"""日K聚合为周K/月K: 周按 ISO 周分组, 月按自然月分组, 标签取组内最后一个交易日。"""

from __future__ import annotations

from datetime import date
from typing import Any, Callable

PERIODS = ("day", "week", "month")
Bar = dict[str, Any]
GroupKey = Callable[[date], tuple[int, ...]]


def _iso_week(day: date) -> tuple[int, int]:
    iso = day.isocalendar()
    return iso.year, iso.week


def _month(day: date) -> tuple[int, int]:
    return day.year, day.month


def _first(group: list[Bar], field: str) -> float | None:
    for bar in group:
        if bar.get(field) is not None:
            return float(bar[field])
    return None


def _last(group: list[Bar], field: str) -> float | None:
    for bar in reversed(group):
        if bar.get(field) is not None:
            return float(bar[field])
    return None


def _max(group: list[Bar], field: str) -> float | None:
    values = [bar[field] for bar in group if bar.get(field) is not None]
    return max(values) if values else None


def _min(group: list[Bar], field: str) -> float | None:
    values = [bar[field] for bar in group if bar.get(field) is not None]
    return min(values) if values else None


def _sum(group: list[Bar], field: str) -> float | None:
    values = [bar[field] for bar in group if bar.get(field) is not None]
    return sum(values) if values else None


def _aggregate(bars: list[Bar], key_of: GroupKey) -> list[Bar]:
    groups: list[list[Bar]] = []
    current: tuple[int, ...] | None = None
    for bar in bars:
        key = key_of(date.fromisoformat(bar["date"]))
        if key != current:
            groups.append([])
            current = key
        groups[-1].append(bar)
    return [
        {
            "date": group[-1]["date"],
            "open": _first(group, "open"),
            "close": _last(group, "close"),
            "high": _max(group, "high"),
            "low": _min(group, "low"),
            "volume": _sum(group, "volume"),
        }
        for group in groups
    ]


def resample(bars: list[Bar], period: str) -> list[Bar]:
    """按周期聚合; day 原样返回, 未知周期抛 ValueError。"""
    if period == "day":
        return list(bars)
    if period == "week":
        return _aggregate(bars, _iso_week)
    if period == "month":
        return _aggregate(bars, _month)
    raise ValueError(f"unsupported period: {period}")
