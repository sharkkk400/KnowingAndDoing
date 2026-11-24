"""收盘/凌晨刷新链的具体步骤: 行情/指数/份额 → core8 节点 → 日度记录。

与调度槽位解耦: 这里只回答"这一趟该做什么并做到哪一步", 由 ops/scheduler 决定
"什么时刻做"并把阶段与进度写进运行时状态。每步都幂等, 失败由调度层统一冷却重试。
"""

from __future__ import annotations

from bisect import bisect_left
from datetime import datetime
from typing import Any, Callable, Optional

from data.store.database import get_conn
from ops import core_backfill
from ops import jobs as raw_jobs
from pages.daily.review import attribution, build
from pages.daily.screen import cache
from services.scoring import features
from services.scoring.core import rebalance
from services.scoring.core import score as core
from services.scoring.core import store as core_store

SETTLE_TAIL_DAYS = 2  # 每晚兜底重算最后两个交易日: 前一晚结算 + 当晚建行
SHARES_RESYNC_DAYS = 4  # 与 Resonance 手工同步同口径: 覆盖滞后/回补的最近四日
INDEX_HEAL_DAYS = 5  # 指数晚于收盘发布: 最近五日缺指数收益的结算行要补算

Report = Callable[[Optional[str], Optional[str]], None]  # (stage, detail)
Progress = Callable[[int, int, str], None]


def _progress(report: Report, stage: str) -> Progress:
    def cb(done: int, total: int, msg: str) -> None:
        report(stage, f"{msg} ({done}/{total})")

    return cb


def _last_daily(conn: Any) -> str | None:
    row = conn.execute("SELECT MAX(date) FROM etf_daily").fetchone()
    return row[0] if row and row[0] else None


def _has_universe(conn: Any) -> bool:
    """空库(或清单还没拉过)时整条链无事可做, 直接跳过, 避免空跑份额抓取。"""
    return conn.execute("SELECT 1 FROM etfs LIMIT 1").fetchone() is not None


def _has_bar(conn: Any, day: str) -> bool:
    return conn.execute("SELECT 1 FROM etf_daily WHERE date = ? LIMIT 1", (day,)).fetchone() is not None


def _core_stale(conn: Any, calendar: list[str], last_bar: str) -> bool:
    """日历上的最新换仓节点是否还没落库(节点日必须有行情, 否则等下一晚)。"""
    nodes = rebalance.rebalance_nodes(calendar, core.CORE_ANCHOR, last_bar)
    if not nodes or not _has_bar(conn, nodes[-1]):
        return False
    return core_store.node_at(conn, last_bar) != nodes[-1]


def _final_node_needs_rebuild(conn: Any, calendar: list[str], last_bar: str) -> bool:
    """当天正是换仓节点、节点已落库且已过 16:15 终值时刻 → 可能按盘中快照算过, 需按收盘价重算。"""
    if not raw_jobs.final_bar_ready():
        return False
    nodes = rebalance.rebalance_nodes(calendar, core.CORE_ANCHOR, last_bar)
    return bool(nodes) and nodes[-1] == last_bar and core_store.node_at(conn, last_bar) == last_bar


def _shares_through(conn: Any) -> str | None:
    row = conn.execute("SELECT MAX(date) FROM etf_shares").fetchone()
    return row[0] if row and row[0] else None


def node_to_complete(conn: Any, calendar: list[str], last_bar: str) -> str | None:
    """最新节点收盘时只有 T-1 份额(预备目标), 且节点日份额现已落地 → 返回要重算的节点日。

    节点日 T 的份额在 T+1 凌晨 00:00 后才发布, 所以周四 18:30 建出的节点必然不完整;
    用完整排名重算后, 周四收盘卖的名单不变, 周五开盘的补买/顺延卖名单才定下来。
    """
    nodes = rebalance.rebalance_nodes(calendar, core.CORE_ANCHOR, last_bar)
    if not nodes:
        return None
    node = nodes[-1]
    if core_store.node_at(conn, last_bar) != node:
        return None
    if core_store.node_complete(conn, node):
        return None
    through = _shares_through(conn)
    return node if through and through >= node else None


def _index_lagging(conn: Any, days: list[str], last_bar: str) -> list[str]:
    """最近几日已结算却缺指数收益: 快照可能跑在中证指数落库之前。

    只检查指数现在已有行情的日子, 避免指数长期缺失时每晚重复重算。
    """
    window = days[-INDEX_HEAL_DAYS:]
    rows = conn.execute(
        "SELECT s.signal_date FROM fitted_daily_summary s"
        " WHERE s.signal_date >= ? AND s.signal_date <= ?"
        " AND s.next_signal IS NOT NULL AND s.next_signal <= ?"
        " AND (s.index_returns_json IS NULL OR s.index_returns_json IN ('{}', ''))"
        " AND EXISTS (SELECT 1 FROM index_daily i WHERE i.code = ? AND i.date = s.next_signal)"
        " ORDER BY s.signal_date",
        (window[0], last_bar, last_bar, attribution.HS300_CODE),
    ).fetchall()
    return [r["signal_date"] for r in rows]


def records_start(conn: Any, calendar: list[str], last_bar: str) -> str | None:
    """有缺口从缺口前一日重算(顺带结算前一日), 否则兜底重算最后两个交易日;
    最近几日若缺指数收益(指数晚于收盘发布), 起点前移到最早那天。"""
    days = [d for d in calendar if build.DEFAULT_START <= d <= last_bar]
    if not days:
        return None
    existing = {
        r["signal_date"]
        for r in conn.execute(
            "SELECT signal_date FROM fitted_daily_summary WHERE signal_date BETWEEN ? AND ?",
            (days[0], last_bar),
        )
    }
    missing = [d for d in days if d not in existing]
    start = days[max(0, bisect_left(days, missing[0]) - 1)] if missing else days[-min(SETTLE_TAIL_DAYS, len(days))]
    lagging = _index_lagging(conn, days, last_bar)
    return min(start, lagging[0]) if lagging else start


def _rebuild_records(conn: Any, calendar: list[str], last_bar: str, report: Report) -> int:
    start = records_start(conn, calendar, last_bar)
    if not start:
        return 0
    report("records", f"重算 {start} → {last_bar}")
    result = build.rebuild(conn, start_date=start, end_date=last_bar, on_progress=_progress(report, "records"))
    return int(result.get("days") or 0)


def _warm_screen(conn: Any, day: str, report: Report) -> None:
    """记录/节点刚重算过, 落盘筛选快照已失效; 先算好, 页面左卡打开时不必再等一次冷算。"""
    report("screen", f"预热 {day} 筛选快照")
    try:
        cache.warm(conn, day)
    except Exception as e:  # noqa: BLE001 - 预热失败不影响主链, 页面首次打开会自行重算
        report("screen", f"预热失败({e}), 页面首次打开时重算")


def close_chain(report: Report) -> dict[str, Any]:
    """收盘主链: 行情/指数/份额 → 节点 → 日度记录; 未到收盘/未发布时提前结束。

    16:15 之后会重拉当天 K 线终值(覆盖盘中快照), 当天若正是换仓节点则按收盘价重算节点。
    """
    conn = get_conn()
    if not _has_universe(conn):
        return {"skipped": "ETF 清单为空, 请先在数据任务页执行一键准备"}
    report("calendar", None)
    raw_jobs.refresh_calendar()
    calendar = features.trading_days(conn)
    today = datetime.now().strftime("%Y-%m-%d")
    if not calendar:
        return {"skipped": "交易日历为空"}
    if today > calendar[-1]:
        return {"skipped": f"交易日历未更新到 {today}", "calendar_end": calendar[-1]}
    if today not in calendar:
        return {"skipped": "非交易日"}

    last_bar = _last_daily(conn)
    if last_bar is None or last_bar < today or raw_jobs.final_bar_ready():
        report("daily", "增量抓取日K" if last_bar is None or last_bar < today else "重拉当日K线终值")
        raw_jobs.backfill_daily(on_progress=_progress(report, "daily"))
        last_bar = _last_daily(conn)

    # 指数每晚都补: 中证官方当天数据常在收盘之后才发布。
    report("index", "增量抓取指数日线")
    raw_jobs.backfill_index(on_progress=_progress(report, "index"))

    # 份额(T+1 发布): 已覆盖日期自动跳过, 当天没发布就只多一次空请求。
    report("shares", "补齐缺失份额")
    raw_jobs.backfill_shares(on_progress=_progress(report, "shares"))

    if last_bar is None or last_bar < today:
        return {"skipped": "今日行情尚未发布", "last_bar": last_bar}

    core_written = 0
    if _core_stale(conn, calendar, last_bar):
        report("core", "换仓节点重算")
        result = core_backfill.rebuild(conn, end=last_bar, on_progress=_progress(report, "core"))
        core_written = int(result.get("written") or 0)
        calendar = features.trading_days(conn)
    elif _final_node_needs_rebuild(conn, calendar, last_bar):
        report("core", f"{last_bar} 当日节点按收盘终值重算")
        core_backfill.rebuild_node(conn, last_bar)
        core_written += 1

    heal = node_to_complete(conn, calendar, last_bar)
    if heal:
        report("core", f"{heal} 节点日份额已落地, 用完整排名重算")
        core_backfill.rebuild_node(conn, heal)
        core_written += 1

    record_days = _rebuild_records(conn, calendar, last_bar, report)
    _warm_screen(conn, last_bar, report)
    report(None, None)
    return {"last_bar": last_bar, "core_nodes": core_written, "record_days": record_days}


def shares_chain(report: Report) -> dict[str, Any]:
    """凌晨份额链: 重拉最近 N 个交易日份额 → 补算节点日份额缺失的节点 → 重算最近交易日记录。"""
    conn = get_conn()
    if not _has_universe(conn):
        return {"skipped": "ETF 清单为空, 请先在数据任务页执行一键准备"}
    last_bar = _last_daily(conn)
    if last_bar is None:
        return {"skipped": "尚无日K, 请先执行一键准备"}
    report("calendar", None)
    raw_jobs.refresh_calendar()
    calendar = features.trading_days(conn)
    report("shares", f"重拉最近 {SHARES_RESYNC_DAYS} 个交易日份额")
    raw_jobs.backfill_shares(on_progress=_progress(report, "shares"), recent_days=SHARES_RESYNC_DAYS, end_date=last_bar)
    nodes = 0
    heal = node_to_complete(conn, calendar, last_bar)
    if heal:
        report("core", f"{heal} 节点日份额已落地, 用完整排名重算")
        core_backfill.rebuild_node(conn, heal)
        nodes = 1
    record_days = _rebuild_records(conn, calendar, last_bar, report)
    _warm_screen(conn, last_bar, report)
    report(None, None)
    return {
        "last_bar": last_bar,
        "record_days": record_days,
        "shares_days": SHARES_RESYNC_DAYS,
        "core_nodes": nodes,
    }
