"""回填任务编排：全量清单、交易日历、日K、份额、指数日线。

原则：边拉边写(中断不丢已拉数据)、重跑自动跳过已完成区间、
相邻请求限速。所有任务幂等, 可反复执行。
"""

from __future__ import annotations

import time
from bisect import bisect_left, bisect_right
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta

from data.config import (
    BACKFILL_START_DATE,
    CSINDEX_START_DATE,
    DAILY_FINAL_TIME,
    FETCH_WORKERS,
    INDEX_CODES,
    INDEX_FETCH_SLEEP_SEC,
    KLINE_START_DATE,
)
from data.fetch import adjust as adjust_fetch
from data.fetch import calendar as calendar_fetch
from data.fetch import etf_list as list_fetch
from data.fetch import index_kline as index_fetch
from data.fetch import kline as kline_fetch
from data.fetch import shares as shares_fetch
from data.store import calendar_repo, daily_repo, etf_repo, index_repo, shares_repo
from data.store.database import get_conn

OnProgress = Callable[[int, int, str], None]

PREV_FLOOR_DAY = "2015-01-05"  # 旧回填下限的首个交易日: 起点仍停在这一天的标的是被截断的, 需向前补深
GAP_MIN_BARS = 30  # 区间内缺根数低于此值不值得全量重拉
GAP_RATIO = 0.5  # 缺口占区间交易日槽位过半才算丢失整段历史(货币 ETF 成交稀疏属正常, 不触发)
SHARE_JUMP_SCAN_RATIO = shares_repo.JUMP_SCAN_RATIO  # 单日份额倍率超 1/1.3~1.3 才送甄别


def _today() -> str:
    return datetime.now().strftime("%Y-%m-%d")


def final_bar_ready(now: datetime | None = None) -> bool:
    """当日 K 线是否已到终值时刻(16:15): 在此之前拉到的是盘中快照, 之后才是收盘价。"""
    now = now or datetime.now()
    return (now.hour, now.minute) >= DAILY_FINAL_TIME


def _report(on_progress: OnProgress | None, done: int, total: int, msg: str) -> None:
    print(f"[BACKFILL] {done}/{total} {msg}", flush=True)
    if on_progress:
        on_progress(done, total, msg)


def refresh_etf_list() -> dict:
    """全量清单快照入库; 返回在册数量与本次新增数量。"""
    rows = list_fetch.fetch_etf_list()
    if not rows:
        return {"total": len(etf_repo.all_codes()), "added": 0, "error": "拉取清单为空"}
    added = etf_repo.upsert_list(rows)
    return {"total": len(etf_repo.all_codes()), "added": added}


def refresh_calendar() -> dict:
    dates = calendar_fetch.fetch_trade_dates()
    if not dates:
        return {"days": 0, "error": "交易日历拉取失败"}
    return {"days": calendar_repo.replace_all(dates)}


def _has_hole(earliest: str, latest: str, rows: int, calendar: list[str]) -> bool:
    """区间内实有根数明显少于交易日槽位 → 历史拉取中途被截断, 尾部增量补不回来。"""
    slots = bisect_right(calendar, latest) - bisect_left(calendar, earliest)
    missing = slots - rows
    return missing >= GAP_MIN_BARS and missing > slots * GAP_RATIO


def _daily_ranges(
    code: str,
    stats: dict[str, tuple[str, str, int]],
    today: str,
    calendar: list[str],
    final_ready: bool,
) -> list[tuple[str, str]]:
    """需要的拉取区间: 无历史 / 被旧下限截断 / 区间内明显缺根 → 从最早起点重拉
    (反向分块, 取到上市首日即停); 其余(含上市晚、历史短但完整的标的)只补最新日之后的增量。

    库里已有今天时, 收盘终值时刻(16:15)之后再重拉一次当天: 盘中写入的当天 K 线只是快照,
    必须让「最后一次落库」取到收盘价, 否则节点与当日揭示价会一直对不上。
    """
    if code not in stats:
        return [(KLINE_START_DATE, today)]
    earliest, latest, rows = stats[code]
    if earliest == PREV_FLOOR_DAY or _has_hole(earliest, latest, rows, calendar):
        return [(KLINE_START_DATE, today)]
    start = (datetime.strptime(latest, "%Y-%m-%d") + timedelta(days=1)).strftime("%Y-%m-%d")
    if start > today:
        return [(today, today)] if final_ready else []
    return [(start, today)]


def _daily_one(code: str, stats: dict[str, tuple[str, str, int]], today: str, calendar: list[str]) -> int:
    written = 0
    for start, end in _daily_ranges(code, stats, today, calendar, final_bar_ready()):
        written += daily_repo.upsert_rows(code, kline_fetch.fetch_kline(code, start_date=start, end_date=end))
    return written


def backfill_daily(on_progress: OnProgress | None = None, workers: int = FETCH_WORKERS) -> dict:
    """全部在册标的日K回填: 多线程并发(请求级全局限速), 已完成区间自动跳过。

    新标的反向分块取到上市首日即停, 通常只需 1 个请求; 已完整的标的每次只补最新一日。
    16:15 之后每次运行都会重拉当天, 保证收盘终值覆盖掉盘中快照。
    """
    codes = etf_repo.all_codes()
    stats = daily_repo.stats_per_code()
    calendar = calendar_repo.all_dates()
    today = _today()
    total = len(codes)
    done = 0
    rows_total = 0
    blocked = False
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = {pool.submit(_daily_one, code, stats, today, calendar): code for code in codes}
        for fut in as_completed(futures):
            code = futures[fut]
            try:
                written = fut.result()
            except kline_fetch.KlineBlocked as e:
                print(f"[BACKFILL] 中止: {e}")
                blocked = True
                for pending in futures:
                    pending.cancel()
                break
            done += 1
            rows_total += written
            _report(on_progress, done, total, f"{code} +{written} 根")
    return {"etfs": done, "rows": rows_total, "blocked": blocked, "list_dates": etf_repo.backfill_list_dates()}


def backfill_shares(on_progress: OnProgress | None = None, recent_days: int = 0, end_date: str | None = None) -> dict:
    """逐交易日回填全市场 ETF 份额(仅写在册标的), 已覆盖日期跳过。

    recent_days > 0 时强制重拉末尾 N 个交易日: 份额 T+1 发布, 昨晚的空结果要在
    次日凌晨补上(全部 upsert, 重拉幂等)。
    """
    days = calendar_repo.trading_days_between(BACKFILL_START_DATE, end_date or _today())
    existing = shares_repo.existing_dates()
    known = set(etf_repo.all_codes())
    todo = [d for d in days if d not in existing]
    if recent_days > 0 and days:
        todo = sorted(set(todo) | set(days[-recent_days:]))
    written = 0
    for i, d in enumerate(todo, 1):
        got = shares_fetch.fetch_shares_for_date(d)
        written += shares_repo.upsert_day(d, got, known)
        if i % 20 == 0 or i == len(todo):
            _report(on_progress, i, len(todo), f"{d} 累计{written}条")
    return {"days": len(todo), "rows": written}


def _detect_one(code: str, jumps: list[dict]) -> tuple[str, list[dict], dict[str, int]]:
    """单个标的的折算甄别: 本地取窗口内前复权, 必要时抓一次未复权, 返回待写事件与计数。"""
    conn = get_conn()
    start, end = adjust_fetch.fetch_window([j["date"] for j in jumps])
    qfq = {
        r["date"]: r["close"]
        for r in conn.execute(
            "SELECT date, close FROM etf_daily WHERE code = ? AND date BETWEEN ? AND ?", (code, start, end)
        )
    }
    todo = [j for j in jumps if adjust_fetch.has_edge_samples(qfq, j["date"])]
    stats = {"split": 0, "flow": 0, "no_history": len(jumps) - len(todo), "unknown": 0}
    events: list[dict] = []
    if not todo:
        return code, events, stats
    raw_start, raw_end = adjust_fetch.fetch_window([j["date"] for j in todo])
    raw = adjust_fetch.fetch_raw_bars(code, raw_start, raw_end)
    for jump in todo:
        method = adjust_fetch.classify(raw, qfq, jump["date"])
        if method is None:
            stats["unknown"] += 1
            continue
        stats[method] += 1
        events.append({"code": code, "date": jump["date"], "ratio": jump["ratio"], "method": method})
    return code, events, stats


def detect_share_conversions(on_progress: OnProgress | None = None, workers: int = FETCH_WORKERS) -> dict:
    """甄别份额整倍跳变: 折算/合并 vs 真实申赎, 结果写 etf_share_scale(幂等增量)。

    每个标的一次未复权区间抓取, 与前复权比值对照; 多线程并发(请求级全局限速),
    写库留在主线程。本地无前史的跳变(上市首日即跳变)无法判定, 直接跳过并计入
    no_history, 不浪费网络请求。
    """
    done = {(e["code"], e["date"]) for e in shares_repo.scale_events()}
    grouped: dict[str, list[dict]] = {}
    for jump in shares_repo.jump_candidates(SHARE_JUMP_SCAN_RATIO):
        if (jump["code"], jump["date"]) not in done:
            grouped.setdefault(jump["code"], []).append(jump)
    counts = {"codes": len(grouped), "split": 0, "flow": 0, "no_history": 0, "unknown": 0}
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = {pool.submit(_detect_one, code, jumps): code for code, jumps in grouped.items()}
        for processed, future in enumerate(as_completed(futures), 1):
            code, events, stats = future.result()
            shares_repo.upsert_scales(events)
            for key in ("split", "flow", "no_history", "unknown"):
                counts[key] += stats[key]
            _report(on_progress, processed, len(grouped), f"{code} {len(events)} 条已甄别")
    return counts


def _index_start(stats: dict[str, tuple[str, str, int]], code: str, today: str) -> str | None:
    """增量起点: 无历史→全历史; 已到最新→None(跳过)。"""
    if code not in stats:
        return CSINDEX_START_DATE
    last = stats[code][1]
    start = (datetime.strptime(last, "%Y-%m-%d") + timedelta(days=1)).strftime("%Y-%m-%d")
    return start if start <= today else None


def backfill_index(on_progress: OnProgress | None = None) -> dict:
    """中证官方指数日线回填(全历史/增量); 单指数失败只记录不中断。"""
    stats = index_repo.stats_per_code()
    today = _today()
    total = len(INDEX_CODES)
    rows_total = 0
    for i, code in enumerate(INDEX_CODES, 1):
        start = _index_start(stats, code, today)
        if start is not None:
            name, rows = index_fetch.fetch_index_daily(code, start_date=start)
            rows_total += index_repo.upsert_rows(code, name, rows)
            time.sleep(INDEX_FETCH_SLEEP_SEC)
        _report(on_progress, i, total, f"{code} {start or '已是最新'}")
    return {"indices": total, "rows": rows_total}


JOB_FNS: dict[str, Callable[..., dict]] = {
    "refresh_etf_list": refresh_etf_list,
    "refresh_calendar": refresh_calendar,
    "backfill_daily": backfill_daily,
    "backfill_shares": backfill_shares,
    "backfill_index": backfill_index,
    "detect_share_conversions": detect_share_conversions,
}

# 带进度回调的任务: 各任务签名不同, 在编排层显式分发, 路由层只认任务名。
_PROGRESS_JOBS: dict[str, Callable[..., dict]] = {
    "backfill_daily": backfill_daily,
    "backfill_shares": backfill_shares,
    "backfill_index": backfill_index,
    "detect_share_conversions": detect_share_conversions,
}


def run_job(name: str, on_progress: OnProgress | None = None) -> dict:
    """按任务名执行; 未知任务抛 ValueError(接口层已提前校验并返回 400)。"""
    if name in _PROGRESS_JOBS:
        return _PROGRESS_JOBS[name](on_progress=on_progress)
    if name in JOB_FNS:
        return JOB_FNS[name]()
    raise ValueError(f"未知任务 {name}, 可选: {sorted(JOB_FNS)}")
