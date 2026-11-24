"""core8 缓冲带的换仓节点回填: 从 CORE_ANCHOR 起每 5 个交易日一个节点。

节点本身就是换仓日, 持仓带到下一节点(缓冲带: 排名仍在前 15 就继续持有)。
节点日收盘只有 T-1 份额, 除完整目标外还存一份预备排名(pre_rank): 结算层据此区分
周四收盘就卖的仓位与周五开盘顺延卖的仓位。回填从锚点走完全程以保证持仓状态连续,
只落 [start, end] 内的节点; 行情/份额只加载一次, 逐节点切片, 不做逐节点重读全库。
不计交易成本——这里只记目标持仓, 结算留给图表。
"""

from __future__ import annotations

import sqlite3
from datetime import datetime
from typing import Any, Callable

from pages.daily.review import execution
from services.scoring import features
from services.scoring.core import data as core_data
from services.scoring.core import rebalance
from services.scoring.core import score as core
from services.scoring.core import store as core_store

RULE_VERSION = "core8-v1"
KEEP_TOP = 20  # 页面展示前 20; 持仓即使排名掉队也强制保留

ProgressFn = Callable[[int, int, str], None]


def _row(row: dict[str, Any], held: bool, action: str, pre_rank: int | None = None) -> dict[str, Any]:
    return {
        "code": row["code"],
        "name": row.get("name"),
        "core_rank": row["core_rank"],
        "core_score": row["core_score"],
        "held": held,
        "action": action,
        "factors": row.get("core_factors"),
        "pre_rank": pre_rank,
    }


def _picks(
    scored: list[dict[str, Any]],
    target: list[str],
    held_prev: list[str],
    pre_rank: dict[str, int] | None = None,
    rebought: set[str] | None = None,
) -> list[dict[str, Any]]:
    """持仓(hold/buy) + 本次卖出(sell) + 评分前 20(rank, 已列的跳过)。

    pre_rank 是只用 T-1 份额算出的预备排名: 节点日收盘先卖谁由它决定, 与完整目标无关。
    rebought 是周四收盘卖掉、周五开盘又买回的名字, 动作记 buy 而不是 hold——持仓看着连续,
    实际先卖出再成交。
    """
    details = {r["code"]: r for r in scored}
    pre = pre_rank or {}
    back = rebought or set()
    target_set, prev_set = set(target), set(held_prev)
    picks = [
        _row(details[c], True, "hold" if c in prev_set and c not in back else "buy", pre.get(c))
        for c in target
        if c in details
    ]
    picks += [_row(details[c], False, "sell", pre.get(c)) for c in held_prev if c not in target_set and c in details]
    listed = target_set | prev_set
    picks += [_row(r, False, "rank", pre.get(r["code"])) for r in scored[:KEEP_TOP] if r["code"] not in listed]
    return picks


def _pre_ranks(ctx: dict[str, Any], signal: str, min_aum: float) -> dict[str, int]:
    """节点日收盘时的预备排名: 份额只用严格早于信号日的点(T+1 才发布)。"""
    prelim = core_data.score_signal(ctx, signal, min_aum, shares_before=True)
    return {r["code"]: r["core_rank"] for r in prelim}


def _next_node(calendar: list[str], signal: str) -> str | None:
    return rebalance.next_rebalance(calendar, signal)


def _resume_holdings(conn: sqlite3.Connection, earlier: list[str]) -> list[str] | None:
    """增量重算的初始持仓: 直接取 start 前一个已落库节点; 缺节点时返回 None, 退回全程计算。"""
    if not earlier:
        return []
    node = core_store.get_node(conn, earlier[-1])
    return [p["code"] for p in node["holdings"]] if node else None


def rebuild(
    conn: sqlite3.Connection,
    start: str | None = None,
    end: str | None = None,
    min_aum: float = features.DEFAULT_MIN_AUM_YI,
    on_progress: ProgressFn | None = None,
) -> dict[str, Any]:
    """回填 [start, end] 内的换仓节点; start 缺省取锚点(全历史)。

    起点之前的节点只用于推导初始持仓, 直接从已落库的上一节点续跑, 不重复评分。
    """
    core_store.ensure_schema(conn)
    calendar = features.trading_days(conn)
    if not calendar:
        return {"nodes": 0, "written": 0}
    end = end or calendar[-1]
    start = start or core.CORE_ANCHOR
    nodes = rebalance.rebalance_nodes(calendar, core.CORE_ANCHOR, end)
    if not nodes:
        return {"nodes": 0, "written": 0}
    ctx = core_data.load_context(conn, nodes[0], load_end=end)
    earlier = [d for d in nodes if d < start]
    wanted = [d for d in nodes if d >= start]
    held = _resume_holdings(conn, earlier)
    resume = held is not None
    held = held or []
    written: list[str] = []
    for i, signal in enumerate(nodes):
        if resume and signal < start:
            continue
        scored = core_data.score_signal(ctx, signal, min_aum)
        if not scored:
            # 交易日历含未来日期, 尾部节点还没有行情: 不落空节点, 持仓延续。
            continue
        pre = _pre_ranks(ctx, signal, min_aum)
        after = execution.remaining_after_close_sells(held, pre)
        target = rebalance.rebalance(after, [r["code"] for r in scored])
        if signal >= start:
            core_store.replace_node(
                conn,
                {
                    "signal_date": signal,
                    "next_rebalance": nodes[i + 1] if i + 1 < len(nodes) else None,
                    "generated_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
                    "rule_version": RULE_VERSION,
                    "scored": len(scored),
                    "min_aum_yi": min_aum,
                    "complete": (ctx.get("shares_through") or "") >= signal,
                },
                _picks(scored, target, held, pre, set(target) - set(after)),
            )
            written.append(signal)
            if on_progress:
                on_progress(len(written), len(wanted), f"{signal} 持仓 {len(target)} 只, 评分池 {len(scored)}")
        held = target
    core_store.prune_nodes(conn, start, end, written)
    return {
        "nodes": len(nodes),
        "written": len(written),
        "start": written[0] if written else None,
        "end": written[-1] if written else None,
    }


def rebuild_node(
    conn: sqlite3.Connection,
    signal: str,
    min_aum: float = features.DEFAULT_MIN_AUM_YI,
) -> dict[str, Any]:
    """单节点重算: T+1 凌晨份额落地后, 用完整份额补算目标并保留预备排名。

    只动该节点, 上一节点(含)之前的历史不变; 上一节点持仓是本次换仓的状态。
    """
    core_store.ensure_schema(conn)
    calendar = features.trading_days(conn)
    ctx = core_data.load_context(conn, signal)
    scored = core_data.score_signal(ctx, signal, min_aum)
    if not scored:
        return {"signal_date": signal, "written": False, "reason": "节点日无评分"}
    pre = _pre_ranks(ctx, signal, min_aum)
    prev = core_store.prev_node(conn, signal)
    prev_node = core_store.get_node(conn, prev) if prev else None
    held_prev = [p["code"] for p in (prev_node or {}).get("holdings", [])]
    after = execution.remaining_after_close_sells(held_prev, pre)
    target = rebalance.rebalance(after, [r["code"] for r in scored])
    core_store.replace_node(
        conn,
        {
            "signal_date": signal,
            "next_rebalance": _next_node(calendar, signal),
            "generated_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            "rule_version": RULE_VERSION,
            "scored": len(scored),
            "min_aum_yi": min_aum,
            "complete": (ctx.get("shares_through") or "") >= signal,
        },
        _picks(scored, target, held_prev, pre, set(target) - set(after)),
    )
    return {"signal_date": signal, "written": True, "holdings": len(target), "scored": len(scored)}
