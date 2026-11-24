"""core8 的取数与单日评分: 加载截至信号日的行情/份额/基准, 复用 core 的纯函数打分。

拆在这里是因为回填要"一次加载、逐节点切片"(每个节点都重读全库会慢一个数量级),
build 与 core_backfill 共用同一份切片口径, 避免两套 logic 打分。
时点纪律: 只读 ≤ 信号日的行; load_end 只放大"能读到哪天", 切片仍按信号日截断。
"""

from __future__ import annotations

import math
import sqlite3
from bisect import bisect_left, bisect_right
from typing import Any

from services.kline import states as macd_states
from services.scoring import features
from services.scoring.core import rebalance
from services.scoring.core import score as core
from services.scoring.descriptors import cross_section, slices


def load_context(conn: sqlite3.Connection, signal: str, load_end: str | None = None) -> dict[str, Any]:
    """加载 [信号日-270 交易日, load_end]; 份额窗口取 120 日以保证 60 点切片是满的。"""
    calendar = features.trading_days(conn)
    idx = bisect_left(calendar, signal)
    if idx >= len(calendar) or calendar[idx] != signal:
        raise ValueError(f"{signal} 不是交易日")
    end = load_end or signal
    data_start = calendar[max(0, idx - features.HISTORY_DAYS)]
    shares_start = calendar[max(0, idx - slices.SHARES_SLICE_DAYS * 2)]
    meta = features.load_meta(conn)
    scope = features.equity_a_share_codes(meta)
    daily_all = {c: b for c, b in features.load_daily(conn, data_start, end).items() if c in scope}
    shares_all = {c: s for c, s in features.load_shares(conn, shares_start, end).items() if c in scope}
    indices = features.load_index(conn, data_start, end)
    return {
        "meta": meta,
        "daily_all": daily_all,
        "daily_dates": {c: [bar["date"] for bar in bars] for c, bars in daily_all.items()},
        "shares_all": shares_all,
        "shares_dates": {c: [pt["date"] for pt in pts] for c, pts in shares_all.items()},
        "shares_through": max((pts[-1]["date"] for pts in shares_all.values() if pts), default=None),
        "bench": indices.get(cross_section.HS300_CODE, []),
        "provider": macd_states.MacdStateProvider.load(conn, end),
    }


def score_signal(
    ctx: dict[str, Any],
    signal: str,
    min_aum: float = features.DEFAULT_MIN_AUM_YI,
    shares_before: bool = False,
) -> list[dict[str, Any]]:
    """切片 → 特征 → 候选池 → core8 评分, 返回按分降序的行(含 core_rank)。

    shares_before=True 只用严格早于信号日的份额 = 节点日收盘时的"预备排名"
    (当日份额 T+1 才发布), 用来决定周四收盘先卖谁。
    """
    daily, shares = slices.slice_universe(
        ctx["daily_all"],
        ctx["daily_dates"],
        ctx["shares_all"],
        ctx["shares_dates"],
        signal,
        features.HISTORY_DAYS,
        shares_before=shares_before,
    )
    bench = ctx["bench"]
    b_idx = bisect_right([b["date"] for b in bench], signal)
    bench_map = {b["date"]: b["close"] for b in bench[max(0, b_idx - features.HISTORY_DAYS) : b_idx]}
    rows = features.build_features(signal, ctx["meta"], daily, shares, bench_map)
    candidates = features.select_candidates(rows, min_aum)
    return core.score_rows(candidates, daily, shares, ctx["provider"], signal)


def item(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "code": row["code"],
        "name": row.get("name"),
        "core_rank": row["core_rank"],
        "core_score": row["core_score"],
        "features": {k: (None if not math.isfinite(v) else round(v, 4)) for k, v in row["core_features"].items()},
    }


def build(
    conn: sqlite3.Connection,
    signal: str,
    held: list[str],
    min_aum: float = features.DEFAULT_MIN_AUM_YI,
) -> dict[str, Any]:
    """单日评分与目标持仓; 非换仓日保持 held 不变(held 为空时按首次建仓处理)。"""
    scored = score_signal(load_context(conn, signal), signal, min_aum)
    calendar = features.trading_days(conn)
    ranked = [row["code"] for row in scored]
    on_rebalance = rebalance.should_rebalance(calendar, signal)
    target = rebalance.rebalance(held, ranked) if (on_rebalance or not held) else list(held)
    details = {row["code"]: row for row in scored}
    return {
        "signal_date": signal,
        "rebalance": on_rebalance,
        "next_rebalance": rebalance.next_rebalance(calendar, signal),
        "scored": len(scored),
        "min_aum_yi": min_aum,
        "holdings": target,
        "holding_details": [item(details[c]) for c in target if c in details],
        "ranked": [item(row) for row in scored[:20]],
    }
