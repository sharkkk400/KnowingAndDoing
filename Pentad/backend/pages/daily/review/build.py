"""日频 core8 复盘: 每个交易日取当日有效的换仓节点持仓, 次日收盘结算。

口径与「核心8·缓冲带」卡片同源: 每 5 个交易日换仓一次, 已持有名字排名仍在前 15
就继续持有, 空位按排名补足; 节点日按混合执行结算(周四收盘先卖掉出缓冲带的仓位,
周五开盘补买/顺延卖), 其余交易日仍是收盘→次日收盘。日度记录只是逐日跟踪这套持仓的
T+1 收益, 不做每日重排, 也不再把"趋势内回撤"旧规则桶混进来。

持仓来自 fitted_core_pick(节点是真源), 因此必须先回填换仓节点再重算日度记录。
早于第一个节点的交易日没有持仓, 只记录股票池与基线作为参照。

性能: 行情/份额/指数只全量加载一次, 每个信号日按窗口切片; MACD 状态提供者
全历史只构建一次, 逐日查询; core8 评分不在这里重算, 直接读节点。
"""

from __future__ import annotations

import sqlite3
from bisect import bisect_left, bisect_right
from datetime import datetime
from typing import Any, Callable

from pages.daily.review import execution, store
from pages.daily.review.evaluate import evaluate
from services.kline import states as macd_states
from services.scoring import features
from services.scoring.core import store as core_store
from services.scoring.descriptors import cross_section, slices
from services.scoring.reason import core8 as core_reason
from services.scoring.reason.ranking import reason_json, reason_text

RULE_VERSION = "daily-core8-v1"
DEFAULT_START = "2015-01-05"  # 与 core 节点同起点: 份额数据 2015 年才有, 更早无法算 core8 持仓
BASELINE_TOP = 10
ProgressFn = Callable[[int, int, str], None]


def _baseline_rows(rows: list[dict[str, Any]], n: int = BASELINE_TOP) -> list[dict[str, Any]]:
    return sorted(rows, key=lambda r: -r["baseline_score"])[:n]


def _core_rows(candidates: list[dict[str, Any]], held: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """节点持仓 → 当日特征行; 掉出候选池(规模/行情不满足)的名字当日不展示也不结算。"""
    by_code = {r["code"]: r for r in candidates}
    rows: list[dict[str, Any]] = []
    for pick in held:
        row = by_code.get(pick["code"])
        if row is None:
            continue
        item = dict(row)
        item["core_rank"] = pick["core_rank"]
        item["core_score"] = pick["core_score"]
        # 持仓在节点间延续: 因子拆解沿用换仓当日的截面, 不按当日重算。
        item["core_factors"] = pick.get("factors")
        rows.append(item)
    return rows


def _evaluate(
    conn: sqlite3.Connection,
    signal: str,
    next_signal: str | None,
    candidates: list[dict[str, Any]],
    core_rows: list[dict[str, Any]],
    plan: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """事后结算; core8 持仓桶与周度 evaluate 共用同一套结算口径。

    节点日改用混合执行价(周四收盘卖 / 周五开盘买), 其余日子仍是收盘→收盘。
    """
    if not next_signal:
        return {"skipped": "暂无下一交易日"}
    if not core_rows:
        return {"skipped": "当日无 core8 持仓"}
    evaluation = evaluate(conn, signal, next_signal, candidates, core_rows)
    if plan is None or not evaluation.get("core_holdings"):
        return evaluation
    # 收盘卖的腿不产生本段收益, 不需要取价; 其余腿都按真实成交价结算。
    codes = sorted({p["code"] for p in core_rows} | set(plan["keep"]) | set(plan["buy"]) | set(plan["sell_open"]))
    prices = execution.load_prices(conn, codes, (signal, next_signal))
    settled = execution.settle(plan, prices, signal, next_signal, next_signal)
    evaluation["core_holdings"] = {k: settled[k] for k in ("n", "mean", "median", "hit_rate")}
    evaluation["core_holdings_picks"] = [
        {"code": p["code"], "name": p.get("name"), "return": settled["returns"].get(p["code"])} for p in core_rows
    ]
    return evaluation


def _pick(
    bucket: str,
    rank: int,
    row: dict[str, Any],
    next_return: float | None,
    reason: dict[str, Any],
    reason_text_value: str,
) -> dict[str, Any]:
    """落库前的统一挑选行: core 与 baseline 两个桶字段完全一致, 只是理由来源不同。"""
    return {
        "bucket": bucket,
        "rank": rank,
        "code": row["code"],
        "name": row["name"],
        "theme": row["theme"],
        "fund_type": row["fund_type"],
        "baseline_score": row["baseline_score"],
        "reason_text": reason_text_value,
        "reason": reason,
        "next_return": next_return,
    }


def _core_picks(core_rows: list[dict[str, Any]], evaluation: dict[str, Any]) -> list[dict[str, Any]]:
    fwd = {p["code"]: p["return"] for p in evaluation.get("core_holdings_picks") or []}
    picks = []
    for rank, row in enumerate(core_rows, 1):
        held_rank = int(row.get("core_rank") or rank)
        picks.append(
            _pick(
                "core",
                rank,
                row,
                fwd.get(row["code"]),
                core_reason.reason_json(row, held_rank, True),
                core_reason.reason_text(row, held_rank, True),
            )
        )
    return picks


def _baseline_picks(candidates: list[dict[str, Any]], evaluation: dict[str, Any]) -> list[dict[str, Any]]:
    fwd = {p["code"]: p["return"] for p in evaluation.get("baseline_top10_picks") or []}
    picks = []
    for rank, row in enumerate(_baseline_rows(candidates, BASELINE_TOP), 1):
        flags = ["shrink_pullback"] if row.get("shrink_pullback") else []
        picks.append(
            _pick("baseline", rank, row, fwd.get(row["code"]), reason_json(row, flags), reason_text(row, rank))
        )
    return picks


def build_day(
    conn: sqlite3.Connection,
    signal: str,
    next_signal: str | None,
    meta: dict[str, dict[str, Any]],
    daily_all: dict[str, list[dict[str, Any]]],
    daily_dates: dict[str, list[str]],
    shares_all: dict[str, list[dict[str, Any]]],
    shares_dates: dict[str, list[str]],
    bench_all: list[dict[str, Any]],
    bench_dates: list[str],
    provider: macd_states.MacdStateProvider,
    codes_with_bar: int,
    min_aum: float,
    held: list[dict[str, Any]],
    plan: dict[str, Any] | None = None,
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """单个交易日: 切片 → 特征 → 评分 → 读节点持仓 → 事后结算。"""
    sliced_daily, sliced_shares = slices.slice_universe(
        daily_all, daily_dates, shares_all, shares_dates, signal, features.HISTORY_DAYS
    )
    bench_idx = bisect_right(bench_dates, signal)
    bench_bars = bench_all[max(0, bench_idx - features.HISTORY_DAYS) : bench_idx]
    bench_map = {b["date"]: b["close"] for b in bench_bars}

    all_rows = features.build_features(signal, meta, sliced_daily, sliced_shares, bench_map)
    features.attach_macd(all_rows, signal, provider)
    candidates = features.select_candidates(all_rows, min_aum)
    cross_section.enrich(candidates, bench_bars)
    features.score(candidates)

    core_rows = _core_rows(candidates, held)
    evaluation = _evaluate(conn, signal, next_signal, candidates, core_rows, plan)
    summary = {
        "signal_date": signal,
        "next_signal": next_signal,
        "generated_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "rule_version": RULE_VERSION,
        "codes_with_bar": codes_with_bar,
        "codes_with_enough_history": len(all_rows),
        "scored": len(candidates),
        "min_aum_yi": min_aum,
        "shares_available": sum(r["shares_yi"] is not None for r in all_rows),
        "evaluation": evaluation,
    }
    return summary, _core_picks(core_rows, evaluation) + _baseline_picks(candidates, evaluation)


def _held_for_day(
    node_dates: list[str],
    nodes: dict[str, list[dict[str, Any]]],
    signal: str,
) -> list[dict[str, Any]]:
    """换仓间隔期内持仓由上一个节点延续; 节点前没有持仓。"""
    idx = bisect_right(node_dates, signal) - 1
    return nodes[node_dates[idx]] if idx >= 0 else []


def rebuild(
    conn: sqlite3.Connection,
    start_date: str = DEFAULT_START,
    end_date: str | None = None,
    min_aum: float = features.DEFAULT_MIN_AUM_YI,
    on_progress: ProgressFn | None = None,
) -> dict[str, Any]:
    """逐日回填 [start_date, end_date]: 整段全量加载一次, 逐日切片评分。"""
    store.ensure_schema(conn)
    core_store.ensure_schema(conn)
    calendar = features.trading_days(conn)
    end = end_date or calendar[-1]
    days = [d for d in calendar if start_date <= d <= end]
    if not days:
        return {"days": 0}
    nodes = core_store.holdings_by_node(conn, end=end)
    if not nodes:
        raise ValueError("尚无 core8 换仓节点, 请先在日度页执行「回填换仓节点」")
    node_dates = sorted(nodes)
    node_plans = execution.plans(nodes, core_store.pre_ranks_by_node(conn, end=end))
    base = bisect_left(calendar, days[0])
    data_start = calendar[max(0, base - features.HISTORY_DAYS)]
    shares_start = calendar[max(0, base - features.SHARES_HISTORY_DAYS - 5)]
    meta = features.load_meta(conn)
    scope = features.equity_a_share_codes(meta)
    raw_daily = features.load_daily(conn, data_start, end)
    daily_all = {c: b for c, b in raw_daily.items() if c in scope}
    daily_dates = {c: [bar["date"] for bar in bars] for c, bars in daily_all.items()}
    raw_shares = features.load_shares(conn, shares_start, end)
    shares_all = {c: s for c, s in raw_shares.items() if c in scope}
    shares_dates = {c: [bar["date"] for bar in bars] for c, bars in shares_all.items()}
    indices = features.load_index(conn, data_start, end)
    bench_all = indices.get(cross_section.HS300_CODE, [])
    bench_dates = [b["date"] for b in bench_all]
    provider = macd_states.MacdStateProvider.load(conn, end)
    bar_counts = {
        r["date"]: r["n"]
        for r in conn.execute(
            "SELECT date, COUNT(*) AS n FROM etf_daily WHERE date BETWEEN ? AND ? GROUP BY date",
            (days[0], end),
        )
    }
    for i, signal in enumerate(days):
        next_signal = days[i + 1] if i + 1 < len(days) else None
        summary, picks = build_day(
            conn,
            signal,
            next_signal,
            meta,
            daily_all,
            daily_dates,
            shares_all,
            shares_dates,
            bench_all,
            bench_dates,
            provider,
            bar_counts.get(signal, 0),
            min_aum,
            _held_for_day(node_dates, nodes, signal),
            node_plans.get(signal),
        )
        store.replace_day(conn, summary, picks)
        if on_progress:
            on_progress(i + 1, len(days), f"{signal} 评分 {summary['scored']} 只")
    return {"days": len(days), "end": end}
