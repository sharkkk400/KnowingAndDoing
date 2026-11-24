"""盘中 core8 预演: 用腾讯现价合成今日未收盘K线, 复用 core8 评分, 结果不落库。

腾讯日K接口收盘后才返回当日K线, 盘中"今天若换仓会持有谁"只能拿实时现价临时拼
一根 bar 提前算一遍: close=现价, open/high/low/volume 取当日行情。份额与沪深300
仍截止上一交易日(当日不可得), 与收盘后的正式节点可能存在细微差异。

持仓语义与收盘一致: 今天不是换仓节点时沿用上一节点持仓; 是节点日则按 core8
排名与缓冲带(已持有排名≤15 继续持有)给出目标持仓。

缓存分两级: 评分/持仓预演交易时段 60 秒重算一次(现价每 15 秒由行情接口负责,
策略层不必更勤); 全量排名行(含因子拆解, 单份约 3MB)10 分钟一批, 「手动全量
拉取」可立即重建。与周度页"当周实时行情"同一纪律: 实时数据只用于展示, 绝不写
入历史表。
"""

from __future__ import annotations

import sqlite3
import threading
import time
from datetime import datetime
from typing import Any

from data.fetch import realtime
from pages.daily.live import context, rows
from services.kline import states as macd_states
from services.scoring import features
from services.scoring.core import rebalance
from services.scoring.core import score as core
from services.scoring.core import store as core_store
from services.scoring.descriptors import cross_section, slices
from services.scoring.reason import core8 as core_reason

LIVE_TTL_SEC = 60  # 评分/持仓预演: 交易时段每分钟重算; 现价列由行情接口 15 秒轮询
LIVE_IDLE_TTL_SEC = 300  # 非交易时段行情不再变, 降频重算
RANKING_TTL_SEC = 600  # 全量排名行(含因子拆解): 10 分钟一批, 手动刷新立即重建
LIVE_RULE_VERSION = "core8-live-v1"
BASELINE_TOP = 10
TODAY_TOP_N = 10  # 左卡「今日 TOP」对照列表: 覆盖买入区(前 5)与缓冲带(前 15)的前段

_guard = threading.Lock()
_compute_cache: dict[str, Any] = {"date": None, "stamp": 0.0, "data": None}
_picks_cache: dict[str, Any] = {"date": None, "stamp": 0.0, "data": None}
_ranking_cache: dict[str, Any] = {"date": None, "stamp": 0.0, "data": None}


def _ttl() -> int:
    return LIVE_TTL_SEC if realtime.is_trading_time() else LIVE_IDLE_TTL_SEC


def _cached(cache: dict[str, Any], day: str, ttl: int) -> dict[str, Any] | None:
    with _guard:
        if cache["date"] == day and time.time() - cache["stamp"] < ttl:
            return dict(cache["data"])
    return None


def _store(cache: dict[str, Any], day: str, data: dict[str, Any]) -> dict[str, Any]:
    with _guard:
        cache.update(date=day, stamp=time.time(), data=data)
    return dict(data)


def _compute(conn: sqlite3.Connection, day: str, force: bool = False) -> dict[str, Any]:
    """完整预演计算(拉行情→拼bar→特征→评分→目标持仓), 结果多级缓存共享。"""
    if not force:
        hit = _cached(_compute_cache, day, _ttl())
        if hit is not None:
            return hit
    calendar = features.trading_days(conn)
    if day not in calendar:
        return _store(_compute_cache, day, {"live": False, "reason": "今日非交易日", "signal_date": day})
    ctx = context.load_context(conn, day, calendar)
    if ctx is None:
        return _store(_compute_cache, day, {"live": False, "reason": "无历史交易日", "signal_date": day})

    t0 = time.time()
    quotes = realtime.fetch_quotes(list(ctx["daily_all"]))
    quotes_sec = time.time() - t0
    live_bars: dict[str, dict[str, Any]] = {}
    as_of: str | None = None
    for code, quote in quotes.items():
        if ctx["daily_dates"].get(code) and ctx["daily_dates"][code][-1] >= day:
            continue  # 库里已有今日K线, 交给正式记录
        bar = context.quote_bar(quote, day)
        if bar is None:
            continue
        bar = context.fill_auction_volume(bar, ctx["daily_all"].get(code) or [])
        live_bars[code] = bar
        stamp = str(quote.get("time") or "")
        if stamp and (as_of is None or stamp > as_of):
            as_of = stamp
    if not live_bars:
        return _store(
            _compute_cache,
            day,
            {"live": False, "reason": "实时行情尚未覆盖今日", "signal_date": day, "as_of": as_of},
        )

    t1 = time.time()
    daily_all = {c: list(b) for c, b in ctx["daily_all"].items()}
    daily_dates = {c: list(d) for c, d in ctx["daily_dates"].items()}
    for code, bar in live_bars.items():
        daily_all[code].append(bar)
        daily_dates[code].append(day)
    provider = macd_states.MacdStateProvider.from_bars(daily_all)

    bench_map = {b["date"]: b["close"] for b in ctx["bench"]}
    rows = features.build_features(day, ctx["meta"], daily_all, ctx["shares_all"], bench_map)
    features.attach_macd(rows, day, provider)
    candidates = features.select_candidates(rows)
    cross_section.enrich(candidates, ctx["bench"])
    features.score(candidates)
    shares = slices.slice_shares(ctx["shares_all"], ctx["shares_dates"], day)
    scored = core.score_rows(candidates, daily_all, shares, provider, day)
    scoring_sec = time.time() - t1

    held_codes, held = context.held_positions(conn, ctx["last_day"])
    on_rebalance = rebalance.should_rebalance(calendar, day)
    ranked = [r["code"] for r in scored]
    target = rebalance.rebalance(held_codes, ranked) if (on_rebalance or not held_codes) else list(held_codes)
    data = {
        "live": True,
        "signal_date": day,
        "last_day": ctx["last_day"],
        "as_of": as_of,
        "meta": ctx["meta"],
        "daily_all": daily_all,
        "rows": rows,
        "candidates": candidates,
        "scored": scored,
        "held_codes": held_codes,
        "held": held,
        "target": target,
        "on_rebalance": bool(on_rebalance or not held_codes),
        "next_rebalance": rebalance.next_rebalance(calendar, day),
        "last_node": core_store.node_at(conn, ctx["last_day"]),
        "quotes": quotes,
        "live_bars": live_bars,
        "timing": {"quotes_sec": round(quotes_sec, 3), "scoring_sec": round(scoring_sec, 3)},
    }
    return _store(_compute_cache, day, data)


def _pick(bucket: str, rank: int, row: dict[str, Any], text: str, reason: dict[str, Any]) -> dict[str, Any]:
    return {
        "bucket": bucket,
        "rank": rank,
        "pick_rank": rank,
        "code": row["code"],
        "name": row["name"],
        "theme": row["theme"],
        "fund_type": row["fund_type"],
        "baseline_score": row["baseline_score"],
        "reason_text": text,
        "reason": reason,
        "next_return": None,
    }


def _core_picks(scored: list[dict[str, Any]], target: list[str]) -> list[dict[str, Any]]:
    by_code = {r["code"]: r for r in scored}
    picks = []
    for code in target:
        row = by_code.get(code)
        if row is None:
            continue
        picks.append(
            _pick(
                "core",
                row["core_rank"],
                row,
                core_reason.reason_text(row, row["core_rank"], True),
                core_reason.reason_json(row, row["core_rank"], True),
            )
        )
    return picks


def build_picks(conn: sqlite3.Connection, day: str, force: bool = False) -> dict[str, Any]:
    """轻量预演响应: 目标持仓 + 当前持仓 + 元信息; 给今日页上部双卡。"""
    if not force:
        hit = _cached(_picks_cache, day, _ttl())
        if hit is not None:
            return hit
    c = _compute(conn, day, force=force)
    if not c.get("live"):
        return _store(_picks_cache, day, c)
    baseline_sorted = sorted(c["candidates"], key=lambda r: -r["baseline_score"])
    today_rank = {r["code"]: r["core_rank"] for r in c["scored"]}
    top_rows = c["scored"][:TODAY_TOP_N]
    top_closes = context.node_closes(conn, c["last_node"], [r["code"] for r in top_rows])
    payload = {
        "live": True,
        "signal_date": day,
        "generated_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "rule_version": LIVE_RULE_VERSION,
        "codes_with_bar": len(c["live_bars"]),
        "codes_with_enough_history": len(c["rows"]),
        "scored": len(c["candidates"]),
        "min_aum_yi": features.DEFAULT_MIN_AUM_YI,
        "shares_available": sum(r["shares_yi"] is not None for r in c["rows"]),
        "evaluation": {"skipped": "盘中预演不结算"},
        "rebalance": c["on_rebalance"],
        "next_rebalance": c["next_rebalance"],
        "last_node": c["last_node"],
        "picks": {
            "core": _core_picks(c["scored"], c["target"]),
            "baseline_codes": [r["code"] for r in baseline_sorted[:BASELINE_TOP]],
        },
        "today_top": [
            {
                "rank": r["core_rank"],
                "code": r["code"],
                "name": r["name"],
                "score": r["core_score"],
                "node_close": top_closes.get(r["code"]),
            }
            for r in top_rows
        ],
        "hold_top": core.HOLD_TOP,
        "buffer_rank": core.HOLD_BUFFER_RANK,
        "held": [{**h, "today_rank": today_rank.get(h["code"])} for h in c["held"]],
        "as_of": c["as_of"],
        "is_trading": realtime.is_trading_time(),
        "last_day": c["last_day"],
        "server_now": int(time.time()),
        "timing": c["timing"],
    }
    return _store(_picks_cache, day, payload)


def build_ranking(conn: sqlite3.Connection, day: str, force: bool = False) -> dict[str, Any]:
    """全量实时排名(约 3MB): 10 分钟一批; 与收盘筛选同构, 前端复用同一表格组件。"""
    if not force:
        hit = _cached(_ranking_cache, day, RANKING_TTL_SEC)
        if hit is not None:
            return hit
    c = _compute(conn, day, force=force)
    if not c.get("live"):
        return _store(_ranking_cache, day, c)
    built = rows.build_rows(
        c["meta"], c["daily_all"], c["rows"], c["candidates"], c["scored"], set(c["held_codes"]), c["quotes"], day
    )
    payload = {
        "live": True,
        "signal_date": day,
        "as_of": c["as_of"],
        "scored": len(c["candidates"]),
        "server_now": int(time.time()),
        "rows": built,
    }
    return _store(_ranking_cache, day, payload)


def refresh(conn: sqlite3.Connection, day: str | None = None) -> dict[str, Any]:
    """手动全量拉取: 清行情缓存与全部预演缓存, 立即重建 picks 与排名, 返回实测耗时。"""
    d = day or datetime.now().strftime("%Y-%m-%d")
    realtime.clear_cache()
    with _guard:
        for cache in (_compute_cache, _picks_cache, _ranking_cache):
            cache.update(date=None, stamp=0.0, data=None)
    picks = build_picks(conn, d, force=True)
    ranking = build_ranking(conn, d, force=True)
    return {
        "refreshed_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "picks": picks,
        "ranking_rows": len(ranking.get("rows") or []),
    }
