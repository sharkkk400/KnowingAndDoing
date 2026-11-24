"""时点切片: 把截至信号日的行情/份额窗口切给特征与评分使用。

单日评分(daily 的 records/screen/live)与 core8 节点回填(core_data)共用同一份切片口径,
拆到评分域是为了让 daily → scoring 保持单向依赖, 不出现两套时点截断逻辑。
"""

from __future__ import annotations

from bisect import bisect_left, bisect_right
from collections.abc import Sequence
from typing import Any

SHARES_SLICE_DAYS = 60  # 份额切片冗余: 覆盖 FLOW_WINDOW 与滞后


def slice_bars(
    bars: Sequence[dict[str, Any]],
    dates: Sequence[str],
    signal: str,
    window: int,
) -> list[dict[str, Any]] | None:
    """截取 [signal-window, signal] 的 bar 列表; 信号日无 bar(停牌/未上市)返回 None。"""
    idx = bisect_right(dates, signal)
    if idx == 0 or dates[idx - 1] != signal:
        return None
    return list(bars[max(0, idx - window) : idx])


def slice_points(
    bars: Sequence[dict[str, Any]],
    dates: Sequence[str],
    signal: str,
    window: int,
    *,
    before: bool = False,
) -> list[dict[str, Any]] | None:
    """取 ≤ signal 的最后 window 个点; 份额等滞后数据当日可能未更新, 允许缺信号日。

    before=True 取严格早于 signal 的点 = 节点日收盘时"当时已知"的份额。
    """
    idx = bisect_left(dates, signal) if before else bisect_right(dates, signal)
    if idx == 0:
        return None
    return list(bars[max(0, idx - window) : idx])


def slice_daily(
    daily_all: dict[str, list[dict[str, Any]]],
    daily_dates: dict[str, list[str]],
    signal: str,
    window: int,
) -> dict[str, list[dict[str, Any]]]:
    """把全量日K切片到信号日; 信号日停牌/未上市的标的整体剔除。"""
    daily: dict[str, list[dict[str, Any]]] = {}
    for code, bars in daily_all.items():
        part = slice_bars(bars, daily_dates[code], signal, window)
        if part is not None:
            daily[code] = part
    return daily


def slice_shares(
    shares_all: dict[str, list[dict[str, Any]]],
    shares_dates: dict[str, list[str]],
    signal: str,
    *,
    before: bool = False,
) -> dict[str, list[dict[str, Any]]]:
    """把全量份额切片到信号日; 当日份额未发布时保留上一个交易日的点。"""
    shares: dict[str, list[dict[str, Any]]] = {}
    for code, points in shares_all.items():
        part = slice_points(points, shares_dates[code], signal, SHARES_SLICE_DAYS, before=before)
        if part is not None:
            shares[code] = part
    return shares


def slice_universe(
    daily_all: dict[str, list[dict[str, Any]]],
    daily_dates: dict[str, list[str]],
    shares_all: dict[str, list[dict[str, Any]]],
    shares_dates: dict[str, list[str]],
    signal: str,
    daily_window: int,
    *,
    shares_before: bool = False,
) -> tuple[dict[str, list[dict[str, Any]]], dict[str, list[dict[str, Any]]]]:
    """单日评分链路的统一入口: 日K与份额按同一信号日截断。

    daily 的 records/screen/live 与 core 节点回填都走这里, 避免各处自己写循环导致
    时点口径漂移。
    """
    return (
        slice_daily(daily_all, daily_dates, signal, daily_window),
        slice_shares(shares_all, shares_dates, signal, before=shares_before),
    )
