"""core8 换仓网格与缓冲带: 节点判定与目标持仓, 与评分计算(core.py)分开。

缓冲带口径: 已持有名字排名仍在前 HOLD_BUFFER_RANK 就继续持有, 空位按排名补足;
节点网格以 CORE_ANCHOR 为起点每 REBALANCE_EVERY 个交易日一个节点。两者同源,
改锚点必须 core_backfill 全量重建(见 core.py 的 CORE_ANCHOR 注释)。
"""

from __future__ import annotations

from bisect import bisect_left
from collections.abc import Sequence

from services.scoring.core.score import CORE_ANCHOR, HOLD_BUFFER_RANK, HOLD_TOP, REBALANCE_EVERY


def rebalance(
    held: Sequence[str],
    ranked: Sequence[str],
    top: int = HOLD_TOP,
    buffer: int = HOLD_BUFFER_RANK,
) -> list[str]:
    """已持有名字排名仍在前 buffer 就继续持有, 空位按排名补足。"""
    rank = {code: i for i, code in enumerate(ranked)}
    kept = [c for c in held if rank.get(c, len(ranked)) < buffer][:top]
    picked = set(kept)
    for code in ranked:
        if len(kept) >= top:
            break
        if code not in picked:
            kept.append(code)
            picked.add(code)
    return kept


def should_rebalance(
    calendar: Sequence[str],
    signal: str,
    anchor: str = CORE_ANCHOR,
    step: int = REBALANCE_EVERY,
) -> bool:
    idx = calendar.index(signal)
    start = bisect_left(calendar, anchor)
    return (idx - start) % step == 0


def next_rebalance(
    calendar: Sequence[str],
    signal: str,
    anchor: str = CORE_ANCHOR,
    step: int = REBALANCE_EVERY,
) -> str | None:
    idx = calendar.index(signal)
    start = bisect_left(calendar, anchor)
    nxt = idx + step - (idx - start) % step
    return calendar[nxt] if nxt < len(calendar) else None


def rebalance_nodes(calendar: Sequence[str], start: str = CORE_ANCHOR, end: str | None = None) -> list[str]:
    """从锚点起每 step 个交易日一个换仓节点, 与 should_rebalance 判定同源。"""
    idx = bisect_left(calendar, start)
    nodes = calendar[idx::REBALANCE_EVERY]
    return [d for d in nodes if end is None or d <= end]
