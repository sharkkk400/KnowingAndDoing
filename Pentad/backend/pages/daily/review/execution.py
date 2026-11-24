"""core8 节点的混合执行结算: 周四收盘先卖、周五开盘补买/顺延卖。

份额 T+1 才发布, 节点日收盘只能拿到 T-1 份额算出的预备排名; 直接拿它当最终目标会与
完整份额差出约 1 只。约定:
- 节点日 T 收盘: 已持有且预备排名掉出缓冲带(>15)的仓位先卖出(成交价 = T 收盘);
- T+1 凌晨份额落地后用完整排名重算目标, T+1 开盘买入目标里缺的、卖出顺延的;
- 连续持有的仓位不动。

结算按真实成交价: 新买入只承担开盘→收盘, 顺延卖出吃到收盘→次日开盘的跳空。
等权槽位口径: 分母取节点前后的较大仓位槽数, 空槽(现金)记 0, 与日度复利口径一致。
"""

from __future__ import annotations

import sqlite3
import statistics
from bisect import bisect_right
from collections.abc import Mapping, Sequence
from typing import Any

from services.scoring.core import score as core

SELL_CLOSE = "close"
SELL_OPEN = "open"


def sell_at(pre_rank: int | None, buffer: int = core.HOLD_BUFFER_RANK) -> str:
    """预备排名缺失(已掉出候选池)按收盘卖: 周四收盘就能确定它进不了完整目标。"""
    return SELL_CLOSE if pre_rank is None or pre_rank >= buffer else SELL_OPEN


def legs(
    held_prev: Sequence[str],
    target: Sequence[str],
    pre_rank: Mapping[str, int | None],
    buffer: int = core.HOLD_BUFFER_RANK,
) -> dict[str, list[str]]:
    """把一次换仓拆成四条腿: 周四收盘卖 / 周五开盘卖 / 继续持有 / 周五开盘买。"""
    final = set(target)
    close_sells = [c for c in held_prev if sell_at(pre_rank.get(c), buffer) == SELL_CLOSE]
    left = [c for c in held_prev if c not in set(close_sells)]
    left_set = set(left)
    return {
        "sell_close": close_sells,
        "sell_open": [c for c in left if c not in final],
        "keep": [c for c in left if c in final],
        "buy": [c for c in target if c not in left_set],
    }


def remaining_after_close_sells(
    held_prev: Sequence[str],
    pre_rank: Mapping[str, int | None],
    buffer: int = core.HOLD_BUFFER_RANK,
) -> list[str]:
    """周四收盘卖掉掉出缓冲带的仓位后剩下的持仓: 周五开盘再平衡的状态。"""
    return [c for c in held_prev if sell_at(pre_rank.get(c), buffer) == SELL_OPEN]


def plans(
    nodes_by_date: dict[str, list[dict[str, Any]]],
    pre_ranks: dict[str, dict[str, int | None]] | None = None,
    buffer: int = core.HOLD_BUFFER_RANK,
) -> dict[str, Any]:
    """{节点日: 持有名单} → {节点日: 四条腿}; 持仓链按节点顺序推进。

    预备排名要从节点全部动作行取(sell 行也带着它), 只读 hold/buy 会把掉出缓冲带的
    仓位当成缺排名, 一律按周四收盘卖, 与 "预备排名仍在缓冲带就留到周五开盘" 冲突。
    """
    out: dict[str, Any] = {}
    prev: list[str] = []
    for day in sorted(nodes_by_date):
        picked = nodes_by_date[day]
        target = [p["code"] for p in picked]
        pre = (pre_ranks or {}).get(day) or {p["code"]: p.get("pre_rank") for p in picked}
        out[day] = legs(prev, target, pre, buffer)
        prev = target
    return out


def _collect_prices(
    conn: sqlite3.Connection,
    codes: Sequence[str],
    where: str,
    params: Sequence[str],
) -> dict[str, dict[str, dict[str, float | None]]]:
    """{code: {date: {open, close}}}; where 只拼日期条件, 代码条件由这里统一加。"""
    if not codes:
        return {}
    code_marks = ",".join("?" * len(codes))
    rows = conn.execute(
        f"SELECT code, date, open, close FROM etf_daily WHERE code IN ({code_marks}) AND {where}",
        (*codes, *params),
    )
    prices: dict[str, dict[str, dict[str, float | None]]] = {}
    for row in rows:
        prices.setdefault(row["code"], {})[row["date"]] = {"open": row["open"], "close": row["close"]}
    return prices


def load_prices(
    conn: sqlite3.Connection,
    codes: Sequence[str],
    days: Sequence[str],
) -> dict[str, dict[str, dict[str, float | None]]]:
    """{code: {date: {open, close}}}: 只取结算用到的日期, 缺行为空。"""
    if not codes or not days:
        return {}
    day_marks = ",".join("?" * len(days))
    return _collect_prices(conn, codes, f"date IN ({day_marks})", days)


def load_price_range(
    conn: sqlite3.Connection,
    codes: Sequence[str],
    start: str,
    end: str,
) -> dict[str, dict[str, dict[str, float | None]]]:
    """同 load_prices, 但按 [start, end] 区间取(节点列表/时间线一次要读整段)。"""
    return _collect_prices(conn, codes, "date BETWEEN ? AND ?", (start, end))


def price_at(prices: Mapping[str, Any], code: str, day: str | None, field: str = "close") -> float | None:
    """从 load_prices/load_price_range 的嵌套字典取价; 缺日或非正价一律视为缺价。"""
    if day is None:
        return None
    value = ((prices.get(code) or {}).get(day) or {}).get(field)
    return value if isinstance(value, (int, float)) and value > 0 else None


def period_returns(
    plan: dict[str, list[str]],
    prices: dict[str, Any],
    entry_day: str,
    open_day: str,
    exit_day: str,
) -> dict[str, float]:
    """单个区间的每只标的收益; 收盘卖出的仓位在区间起点已退出, 不产生收益。"""
    out: dict[str, float] = {}
    for code in plan["keep"]:
        p0, p1 = price_at(prices, code, entry_day), price_at(prices, code, exit_day)
        if p0 and p1:
            out[code] = p1 / p0 - 1
    for code in plan["buy"]:
        p0, p1 = price_at(prices, code, open_day, "open"), price_at(prices, code, exit_day)
        if p0 and p1:
            out[code] = p1 / p0 - 1
    for code in plan["sell_open"]:
        p0, p1 = price_at(prices, code, entry_day), price_at(prices, code, open_day, "open")
        if p0 and p1:
            out[code] = p1 / p0 - 1
    return out


def settle(
    plan: dict[str, list[str]],
    prices: dict[str, Any],
    entry_day: str,
    open_day: str,
    exit_day: str,
) -> dict[str, Any]:
    """区间等权收益 + 逐只收益; 分母是槽位数, 缺价的腿按现金(0)处理。"""
    returns = period_returns(plan, prices, entry_day, open_day, exit_day)
    slots = max(
        len(plan["keep"]) + len(plan["sell_open"]) + len(plan["sell_close"]),
        len(plan["keep"]) + len(plan["buy"]),
    )
    values = list(returns.values())
    mean = sum(values) / slots if slots else None
    return {
        "n": slots,
        "mean": round(mean, 6) if mean is not None else None,
        "median": round(statistics.median(values), 6) if values else None,
        "hit_rate": sum(v > 0 for v in values) / len(values) if values else None,
        "returns": returns,
    }


def next_day(calendar: Sequence[str], day: str) -> str | None:
    """节点日之后的第一个交易日 = 开盘成交日。"""
    idx = bisect_right(calendar, day)
    return calendar[idx] if idx < len(calendar) else None
