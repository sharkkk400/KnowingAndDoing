"""筛选漏斗与全量排名: 把某个交易日的 ETF 筛选链路逐级摊开供复盘。

生产链路(pages/daily/review/build.py)落 core8 持仓与基线入选, 复盘时看不到
"谁在哪一级被筛掉"和"池内谁强谁弱"。本模块复用同一套特征/评分/规则函数,
把每一步的中间结果全部返回(不落库):
- funnel: 在册 → 指数型-股票 → A股底层 → 信号日有K线 → 历史≥62根 → 有份额
  → 规模≥2亿 → core8 评分池 → 缓冲带持仓; 基线前10 是评分池的并行分支;
- rows: 每只 ETF 到达的最深一级、剔除原因、评分与因子明细。

时点纪律: 行情/份额/基准全部截到 signal_date, 不读信号日之后的数据。
"""

from __future__ import annotations

import sqlite3
import threading
import time
from bisect import bisect_left
from collections import OrderedDict
from typing import Any

from pages.daily.review import build as daily_build
from services.kline import states as macd_states
from services.scoring import features
from services.scoring.core import score as core
from services.scoring.core import store as core_store
from services.scoring.descriptors import cross_section, slices, themes
from services.scoring.reason import core8 as core_reason
from services.scoring.reason.ranking import reason_json, reason_text

CACHE_TTL_SEC = 120  # 单日筛选结果含全量行, 重算后才可能变化
CACHE_SLOTS = 3  # 单份全量约 3MB; 只留最近几天, 换日期来回切不必重算
BASELINE_TOP = daily_build.BASELINE_TOP
PAYLOAD_VERSION = 2  # 行结构变更时递增: 旧落盘快照缺字段, 自动失效重算

FUNNEL_STAGES: tuple[tuple[str, str, str], ...] = (
    ("etfs", "在册 ETF", "etfs 清单全部标的（含 QDII/债券/货币等）"),
    ("equity", "指数型-股票", "fund_type = 指数型-股票"),
    ("a_share", "A 股底层", "名称不含 港股/恒生/恒指/香港/H股/沪港深/AH"),
    ("with_bar", "信号日有 K 线", "当日收盘已入库（停牌/未上市/未回填会掉队）"),
    ("history", "历史 ≥62 根", "≥62 根日 K，且近 61 日收盘、近 20 日成交量有效"),
    ("shares", "有份额可算规模", "库内有 ≤ 信号日的份额；规模 = 收盘价 × 份额"),
    ("aum", "规模 ≥2 亿", "aum_yi ≥ min_aum（默认 2 亿）"),
    ("core_pool", "策略评分池", "8 因子截面秩评分：深回撤/超跌/长动量为正，高波动/份额拥挤/放量为负"),
    ("core_hold", "缓冲带持仓", "每 5 个交易日调仓；前 5 名 + 已持有且排名≤15 继续持有"),
)
BASELINE_NOTE = (
    "基线前 10 是评分池的并行分支: 综合分前 10，不做策略过滤（无观点对照锚）。"
    "策略持仓由换仓节点决定，间隔期内沿用上一节点，不按当日排名重排。"
)

STAGE_TEXT: dict[str, str] = {
    "non_equity": "非指数型-股票（QDII/债券/货币等）",
    "hk": "含港股/非 A 股底层",
    "no_bar": "信号日无 K 线",
    "short_history": "历史不足 62 根",
    "bad_data": "数据异常（零价/零量）",
    "no_shares": "无份额数据",
    "small_aum": "规模不足 2 亿",
    "core_pool": "策略评分池·未持有",
    "core_hold": "缓冲带持仓",
}

_guard = threading.Lock()
_cache: OrderedDict[tuple[str, float], tuple[float, dict[str, Any]]] = OrderedDict()


def _cached(key: tuple[str, float]) -> dict[str, Any] | None:
    with _guard:
        hit = _cache.get(key)
        if hit is None or time.time() - hit[0] >= CACHE_TTL_SEC:
            _cache.pop(key, None)
            return None
        _cache.move_to_end(key)
        return hit[1]


def _store(key: tuple[str, float], data: dict[str, Any]) -> dict[str, Any]:
    with _guard:
        _cache[key] = (time.time(), data)
        _cache.move_to_end(key)
        while len(_cache) > CACHE_SLOTS:
            _cache.popitem(last=False)
    return data


def _load(conn: sqlite3.Connection, signal: str) -> dict[str, Any]:
    """加载截至信号日的历史上下文; 只读 ≤ signal 的行。"""
    calendar = features.trading_days(conn)
    idx = bisect_left(calendar, signal)
    if idx >= len(calendar) or calendar[idx] != signal:
        raise ValueError(f"{signal} 不是交易日")
    data_start = calendar[max(0, idx - features.HISTORY_DAYS)]
    shares_start = calendar[max(0, idx - slices.SHARES_SLICE_DAYS * 2)]
    daily_all = features.load_daily(conn, data_start, signal)
    shares_all = features.load_shares(conn, shares_start, signal)
    indices = features.load_index(conn, data_start, signal)
    return {
        "meta": features.load_meta(conn),
        "daily_all": daily_all,
        "daily_dates": {code: [bar["date"] for bar in bars] for code, bars in daily_all.items()},
        "shares_all": shares_all,
        "shares_dates": {code: [bar["date"] for bar in bars] for code, bars in shares_all.items()},
        "bench": indices.get(cross_section.HS300_CODE, []),
        "provider": macd_states.MacdStateProvider.load(conn, signal),
    }


def _slice(ctx: dict[str, Any], signal: str) -> tuple[dict[str, Any], dict[str, Any]]:
    return slices.slice_universe(
        ctx["daily_all"],
        ctx["daily_dates"],
        ctx["shares_all"],
        ctx["shares_dates"],
        signal,
        features.HISTORY_DAYS,
    )


def _stage_key(
    meta: dict[str, Any],
    bars: list[dict[str, Any]] | None,
    row: dict[str, Any] | None,
    code: str,
    signal: str,
    scored_codes: set[str],
    held_codes: set[str],
) -> str:
    """该 ETF 在漏斗中到达的最深一级。"""
    if meta.get("fund_type") != features.DOMESTIC_EQUITY:
        return "non_equity"
    if not features.is_a_share(meta.get("name")):
        return "hk"
    if not bars or bars[-1]["date"] != signal:
        return "no_bar"
    if row is None:
        return "short_history" if len(bars) < features.MIN_BARS else "bad_data"
    if row["aum_yi"] is None:
        return "no_shares"
    if code not in scored_codes:
        return "small_aum"
    return "core_hold" if code in held_codes else "core_pool"


def _row(
    code: str,
    meta: dict[str, Any],
    bars: list[dict[str, Any]] | None,
    row: dict[str, Any] | None,
    stage: str,
    rank: int | None,
    core8: dict[str, Any] | None,
    node_close: float | None,
) -> dict[str, Any]:
    item: dict[str, Any] = {
        "code": code,
        "name": meta.get("name"),
        "fund_type": meta.get("fund_type"),
        "theme": themes.theme_of(meta.get("name")),
        "stage": stage,
        "stage_text": STAGE_TEXT[stage],
        "last_bar": bars[-1]["date"] if bars else None,
        "bars": len(bars) if bars else 0,
        "rank": rank,
        "core8_rank": core8["core_rank"] if core8 else None,
        "core8_score": core8["core_score"] if core8 else None,
        "core_factors": core8.get("core_factors") if core8 else None,
        "node_close": node_close,
        "reason": None,
        "reason_text": None,
    }
    if row is None or stage in {"non_equity", "hk", "no_bar", "short_history", "bad_data"}:
        return item
    flags = ["shrink_pullback"] if row.get("shrink_pullback") else []
    item["reason"] = reason_json({**row, "baseline_score": row.get("baseline_score")}, flags)
    if stage == "core_hold" and core8:
        held_row = {**row, "core_rank": core8["core_rank"], "core_score": core8["core_score"]}
        item["reason_text"] = core_reason.reason_text(held_row, core8["core_rank"], True)
    elif stage == "core_pool":
        item["reason_text"] = reason_text(row, rank or 0)
    return item


def _node_context(
    conn: sqlite3.Connection,
    signal: str,
) -> tuple[str | None, set[str], dict[str, float]]:
    """当日有效的换仓节点: (节点日, 持仓代码, 节点日收盘价)。

    间隔期内沿用上一节点; 今日「节点涨跌」统一以节点日收盘为基准
    (持有=本轮周期收益, 未持有=若节点买入至今)。
    """
    node = core_store.node_at(conn, signal)
    if not node:
        return None, set(), {}
    holdings = (core_store.get_node(conn, node) or {}).get("holdings", [])
    closes = {
        row["code"]: row["close"]
        for row in conn.execute("SELECT code, close FROM etf_daily WHERE date = ?", (node,))
        if row["close"] is not None
    }
    return node, {pick["code"] for pick in holdings}, closes


def build(
    conn: sqlite3.Connection,
    signal: str,
    min_aum: float = features.DEFAULT_MIN_AUM_YI,
) -> dict[str, Any]:
    """单日筛选漏斗 + 全量排名(含被筛掉的标的与原因)。"""
    key = (signal, min_aum)
    hit = _cached(key)
    if hit is not None:
        return hit
    ctx = _load(conn, signal)
    meta = ctx["meta"]
    daily, shares = _slice(ctx, signal)
    bench_map = {bar["date"]: bar["close"] for bar in ctx["bench"]}
    all_rows = features.build_features(signal, meta, daily, shares, bench_map)
    features.attach_macd(all_rows, signal, ctx["provider"])

    equity = [c for c, m in meta.items() if m.get("fund_type") == features.DOMESTIC_EQUITY]
    a_share = [c for c in equity if features.is_a_share(meta[c].get("name"))]
    scope = set(a_share)
    with_bar = [c for c in a_share if ctx["daily_all"].get(c) and ctx["daily_all"][c][-1]["date"] == signal]
    scope_rows = [r for r in all_rows if r["code"] in scope]
    shares_rows = [r for r in scope_rows if r["aum_yi"] is not None]

    candidates = features.select_candidates(all_rows, min_aum)
    cross_section.enrich(candidates, ctx["bench"])
    features.score(candidates)
    core8 = {r["code"]: r for r in core.score_rows(candidates, daily, shares, ctx["provider"], signal)}
    baseline_rows = sorted(candidates, key=lambda r: -r["baseline_score"])
    node, held_codes, node_closes = _node_context(conn, signal)

    counts = {
        "etfs": len(meta),
        "equity": len(equity),
        "a_share": len(a_share),
        "with_bar": len(with_bar),
        "history": len(scope_rows),
        "shares": len(shares_rows),
        "aum": len(candidates),
        "core_pool": len(candidates),
        "core_hold": len(held_codes & {r["code"] for r in candidates}),
    }
    feature_by_code = {r["code"]: r for r in all_rows}
    scored_codes = {r["code"] for r in candidates}
    ranks = {r["code"]: i for i, r in enumerate(baseline_rows, 1)}
    rows: list[dict[str, Any]] = []
    for code, m in meta.items():
        bars = ctx["daily_all"].get(code)
        row = feature_by_code.get(code)
        stage = _stage_key(m, bars, row, code, signal, scored_codes, held_codes)
        rows.append(_row(code, m, bars, row, stage, ranks.get(code), core8.get(code), node_closes.get(code)))
    rows.sort(key=lambda r: (r["rank"] is None, r["rank"] or 0, r["code"]))

    data = {
        "payload_version": PAYLOAD_VERSION,
        "signal_date": signal,
        "node_date": node,
        "available": bool(with_bar),
        "reason": None if with_bar else "信号日没有任何指数型-股票 ETF 的收盘 K 线（盘中或尚未回填）",
        "min_aum_yi": min_aum,
        "funnel": [
            {"key": key_, "label": label, "criteria": criteria, "count": counts[key_]}
            for key_, label, criteria in FUNNEL_STAGES
        ],
        "baseline_note": BASELINE_NOTE,
        "core_codes": sorted(held_codes),
        "baseline_codes": [r["code"] for r in baseline_rows[:BASELINE_TOP]],
        "scored": len(candidates),
        "rows": rows,
    }
    return _store(key, data)
