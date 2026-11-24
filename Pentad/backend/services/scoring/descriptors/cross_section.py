"""截面位置与基准对比: 多因子分位、主题相对强度、相对沪深300 的超额与敏感度。

单只 ETF 的涨幅/波动是绝对量; 截面分位回答"同期全市场同类里算强还是弱",
主题分位回答"是个体行情还是板块普涨", 基准超额与 alpha 剥离大盘 beta。
纯函数, 输入是同一信号日的候选行与 ≤ signal_date 的沪深300 收盘。
"""

from __future__ import annotations

import math
import statistics
from typing import Any

from services.scoring.descriptors import themes
from services.scoring.ranks import average_ranks

HS300_CODE = "000300"
MIN_THEME_MEMBERS = 3  # 主题成员不足时不给主题分位(小样本分位没有区分度)
RS_STRONG_RANK = 0.8
RS_STRONG_RANK_60 = 0.7  # 60 日分位要求略低: 中期强势允许最近一月先回调
RS_WEAK_RANK = 0.3
NEAR_HIGH_52W = -0.02  # 距 52 周高点 2% 以内视为贴近新高

RANK_KEYS = ("r5", "r20", "r60", "vol20", "flow_5d", "r250", "dist_52w_high")


def _ret(closes: list[float], n: int) -> float | None:
    if len(closes) <= n or closes[-1 - n] <= 0:
        return None
    return closes[-1] / closes[-1 - n] - 1


def _pct_rank(values: list[float | None]) -> list[float | None]:
    """平均秩百分位(0~1, 1=最高); 并列取平均, 缺失保持 None。"""
    out: list[float | None] = [None] * len(values)
    positions = [i for i, value in enumerate(values) if value is not None and math.isfinite(value)]
    valid = [value for value in values if value is not None and math.isfinite(value)]
    if not valid:
        return out
    if len(valid) == 1:
        return [1.0 if value is not None else None for value in values]
    ranks = average_ranks(valid)
    for offset, position in enumerate(positions):
        out[position] = (ranks[offset] - 1) / (len(valid) - 1)
    return out


def _bench_returns(bench_bars: list[dict[str, Any]]) -> dict[str, float | None]:
    closes = [b["close"] for b in sorted(bench_bars, key=lambda x: x["date"]) if b["close"]]
    return {f"r{n}": _ret(closes, n) for n in (5, 20, 60)}


def _assign_ranks(rows: list[dict[str, Any]], key: str) -> None:
    for row, rank in zip(rows, _pct_rank([row.get(key) for row in rows])):
        row[f"rank_{key}"] = rank


def _theme_stats(rows: list[dict[str, Any]]) -> None:
    groups: dict[str, list[dict[str, Any]]] = {}
    for row in rows:
        row["theme"] = themes.theme_of(row.get("name"))
        groups.setdefault(row["theme"], []).append(row)
    for theme, members in groups.items():
        median = statistics.median([m["r20"] for m in members if m.get("r20") is not None] or [0.0])
        ranks = (
            _pct_rank([m.get("r20") for m in members]) if len(members) >= MIN_THEME_MEMBERS else [None] * len(members)
        )
        for member, rank in zip(members, ranks):
            member["theme"] = theme
            member["theme_count"] = len(members)
            member["theme_median_r20"] = median
            member["theme_rank_r20"] = rank
            member["theme_excess_r20"] = (member["r20"] - median) if member.get("r20") is not None else None


def enrich(rows: list[dict[str, Any]], bench_bars: list[dict[str, Any]]) -> None:
    """原地补截面分位/主题相对强度/基准超额(不改动既有评分字段)。"""
    for key in RANK_KEYS:
        _assign_ranks(rows, key)
    _theme_stats(rows)
    bench = _bench_returns(bench_bars)
    for row in rows:
        for n in (5, 20, 60):
            value, base = row.get(f"r{n}"), bench.get(f"r{n}")
            row[f"excess_r{n}"] = value - base if value is not None and base is not None else None
        r20_rank, r60_rank = row.get("rank_r20"), row.get("rank_r60")
        row["rs_strong"] = bool(
            r20_rank is not None
            and r20_rank >= RS_STRONG_RANK
            and r60_rank is not None
            and r60_rank >= RS_STRONG_RANK_60
        )
        row["rs_weak"] = bool(
            r20_rank is not None and r20_rank <= RS_WEAK_RANK and r60_rank is not None and r60_rank <= RS_WEAK_RANK
        )
        row["near_high_52w"] = bool(row.get("dist_52w_high") is not None and row["dist_52w_high"] >= NEAR_HIGH_52W)
        row["theme_leader"] = bool(
            (row.get("theme_count") or 0) >= MIN_THEME_MEMBERS and (row.get("theme_rank_r20") or 0) >= RS_STRONG_RANK
        )
