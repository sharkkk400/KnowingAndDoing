"""core8 入选理由: 排名 + 原始画像指标, 压成一段可独立读懂的说明。

与 weekly/reasons.py 的综合分文案分开: 那套讲趋势/资金/主题排名, 这套口径是
core8 横截面秩评分(深回撤/超跌/长动量为正, 高波动/份额拥挤/放量为负), 不能混用。
八因子的秩分只在排名表里展开; 这里用原始指标, 避免重复做截面计算。
"""

from __future__ import annotations

import math
from typing import Any

from services.scoring.core import score as core
from services.scoring.reason import ranking as reasons


def _pct(value: Any) -> str:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return "—"
    return f"{number * 100:+.1f}%" if math.isfinite(number) else "—"


def _num(value: Any) -> str:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return "—"
    return f"{number:.1f}" if math.isfinite(number) else "—"


def reason_text(row: dict[str, Any], rank: int, held: bool) -> str:
    """held 且排名在缓冲带内: 说明是缓冲带留仓, 不是本期重新买回。"""
    score = row.get("core_score")
    head = f"策略第{rank}（{score:+.2f}）" if isinstance(score, (int, float)) else f"策略第{rank}"
    if held and rank > core.HOLD_TOP:
        head = f"缓冲带继续持有（策略第{rank}）"
    return (
        f"{head}：60日回撤 {_pct(row.get('dd60'))}，20日 {_pct(row.get('r20'))} / "
        f"250日 {_pct(row.get('r250'))}，年化波动 {_pct(row.get('vol20'))}，"
        f"5日份额 {_pct(row.get('flow_5d'))}，规模 {_num(row.get('aum_yi'))} 亿"
    )


def reason_json(row: dict[str, Any], rank: int, held: bool) -> dict[str, Any]:
    """沿用共享因子明细, 追加策略分、排名与 8 因子拆解(供页面展示公式构成)。"""
    flags: list[str] = ["core8_hold"] if held else []
    if row.get("shrink_pullback"):
        flags.append("shrink_pullback")
    data = reasons.reason_json(row, flags)
    data.update(
        {
            "core8_rank": rank,
            "core8_score": row.get("core_score"),
            "core_factors": row.get("core_factors"),
        }
    )
    return data
