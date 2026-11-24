"""入选理由: 因子明细 JSON + 综合分文案; core8 持仓的专属文案在 daily/core_reason。"""

from __future__ import annotations

from typing import Any

from services.kline import states as macd_states
from services.scoring import features
from services.scoring.descriptors import profile

DISPLAY_SIGNALS = (
    "rs_strong",
    "rs_weak",
    "theme_leader",
    "near_high_52w",
    "ma_bull",
    "ma_bear",
    "flow_suspect",
    "share_split_5d",
)


def _pct(value: float | None) -> str:
    return "—" if value is None else f"{value * 100:+.1f}%"


def _vol(value: float | None) -> str:
    return "—" if value is None else f"{value * 100:.1f}%"


def _ratio(value: float | None) -> str:
    return "—" if value is None else f"{value * 100:.2f}%"


def _amount(value: float | None) -> str:
    return "—" if value is None else f"{value:.1f} 亿"


def _rank(value: float | None) -> str:
    return "—" if value is None else f"第{value * 100:.0f}分位"


def _num(value: float | None, digits: int = 4) -> float | None:
    return None if value is None else round(float(value), digits)


def _signals(row: dict[str, Any]) -> list[str]:
    """展示用强弱标记(不参与排序): 只收被触发的键, 文案由前端映射。"""
    return [key for key in DISPLAY_SIGNALS if (row.get("share_split_5d") if key == "share_split_5d" else row.get(key))]


def reason_json(row: dict[str, Any], flags: list[str]) -> dict[str, Any]:
    return {
        "flags": flags,
        "signals": _signals(row),
        "r5": _num(row["r5"]),
        "r20": _num(row["r20"]),
        "r60": _num(row["r60"]),
        "r120": _num(row.get("r120")),
        "r250": _num(row.get("r250")),
        "vol20": _num(row["vol20"]),
        "vol60": _num(row.get("vol60")),
        "dd60": _num(row["dd60"]),
        "dd20": _num(row.get("dd20")),
        "mdd60": _num(row.get("mdd60")),
        "dist_52w_high": _num(row.get("dist_52w_high")),
        "dist_52w_low": _num(row.get("dist_52w_low")),
        "vol_ratio_5_20": _num(row["vol_ratio_5_20"]),
        "amount_yi_5d": _num(row.get("amount_yi_5d")),
        "amount_yi_20d": _num(row.get("amount_yi_20d")),
        "turnover_5d": _num(row.get("turnover_5d")),
        "turnover_20d": _num(row.get("turnover_20d")),
        "shrink_pullback": bool(row.get("shrink_pullback")),
        "ma20_dev": _num(row["ma20_dev"]),
        "ma60_dev": _num(row["ma60_dev"]),
        "ma120_dev": _num(row.get("ma120_dev")),
        "ma20_slope_5": _num(row.get("ma20_slope_5")),
        "ma60_slope_20": _num(row.get("ma60_slope_20")),
        "up_ratio_20": _num(row.get("up_ratio_20")),
        "up_ratio_60": _num(row.get("up_ratio_60")),
        "downside_vol20": _num(row.get("downside_vol20")),
        "sharpe_20": _num(row.get("sharpe_20")),
        "sharpe_60": _num(row.get("sharpe_60")),
        "rank_r5": _num(row.get("rank_r5")),
        "rank_r20": _num(row.get("rank_r20")),
        "rank_r60": _num(row.get("rank_r60")),
        "rank_r250": _num(row.get("rank_r250")),
        "rank_vol20": _num(row.get("rank_vol20")),
        "rank_flow_5d": _num(row.get("rank_flow_5d")),
        "rank_dist_52w_high": _num(row.get("rank_dist_52w_high")),
        "excess_r5": _num(row.get("excess_r5")),
        "excess_r20": _num(row.get("excess_r20")),
        "excess_r60": _num(row.get("excess_r60")),
        "beta60": _num(row.get("beta60")),
        "corr60": _num(row.get("corr60")),
        "alpha60": _num(row.get("alpha60")),
        "theme": row.get("theme"),
        "theme_count": row.get("theme_count"),
        "theme_median_r20": _num(row.get("theme_median_r20")),
        "theme_rank_r20": _num(row.get("theme_rank_r20")),
        "theme_excess_r20": _num(row.get("theme_excess_r20")),
        "shares_yi": _num(row["shares_yi"]),
        "shares_raw": _num(row.get("shares_raw")),
        "flow_5d": _num(row["flow_5d"]),
        "flow_5d_raw": _num(row.get("flow_5d_raw")),
        "flow_suspect": bool(row.get("flow_suspect")),
        "share_split_5d": int(row.get("share_split_5d") or 0),
        "aum_yi": _num(row["aum_yi"]),
        "core_score": _num(row.get("core_score")),
        "trend_score": _num(row.get("trend_score")),
        "macd_states": row.get("macd_states") or {},
        "baseline_score": row["baseline_score"],
    }


def _theme_text(row: dict[str, Any]) -> str:
    theme = row.get("theme") or "其他"
    rank = row.get("theme_rank_r20")
    if rank is None:
        return f"主题「{theme}」"
    return f"主题「{theme}」内{_rank(rank)}"


def _rs_text(row: dict[str, Any]) -> str:
    share = f"近5日 {_pct(row['r5'])}，5日份额 {_pct(row['flow_5d'])}"
    if row.get("share_split_5d"):
        share += "（含份额折算，已归一）"
    return share


def _risk_notes(row: dict[str, Any]) -> list[str]:
    notes: list[str] = []
    if (row["r20"] or 0) > features.EXT_R20:
        notes.append("20日涨幅超过25%，拥挤")
    if (row["r5"] or 0) > features.EXT_R5:
        notes.append("单周涨幅超过8%，短期过热")
    if (row["flow_5d"] or 0) > features.EXT_FLOW:
        notes.append("5日份额增长超过50%，资金拥挤")
    if row["vol20"] > features.EXT_VOL:
        notes.append("年化波动超过45%，高波动")
    if row.get("flow_suspect"):
        notes.append("份额单日跳变未甄别，资金因子未计入")
    if row.get("rs_weak"):
        notes.append("20/60日截面都在后30%，相对弱势")
    amount = row.get("amount_yi_5d")
    if amount is not None and amount < profile.LIQUIDITY_MIN_AMOUNT_YI:
        notes.append("5日均额不足0.5亿，流动性偏弱")
    return notes


def _macd_text(row: dict[str, Any]) -> str:
    """把三周期状态压成一行: 趋势 +0.48（日水上走强+0.82/周水上死叉-1.00/月预热不足）。"""
    states = row.get("macd_states") or {}
    zone_text = {"above": "水上", "below": "水下", "zero": "零轴"}
    trend_text = {"rising": "走强", "falling": "走弱", "flat": "走平"}
    flip_text = {"golden": "金叉", "dead": "死叉"}
    parts: list[str] = []
    for period, label in macd_states.PERIODS:
        state = states.get(period)
        if state is None:
            parts.append(f"{label}预热不足")
        else:
            word = flip_text.get(state.get("flip") or "") or trend_text.get(state["trend"], "走平")
            parts.append(f"{label}{zone_text.get(state['zone'], '零轴')}{word}")
    return f"趋势 {(row.get('trend_score') or 0.0):+.2f}（{'/'.join(parts)}）"


def reason_text(row: dict[str, Any], rank: int) -> str:
    """基线理由必须能独立读懂: 截面位置 + 基准对比 + 资金 + 成交画像 + MACD + 风险 + 规模。"""
    aum = "—" if row["aum_yi"] is None else f"{row['aum_yi']:.1f} 亿"
    position = (
        f"20日 {_pct(row['r20'])} / 60日 {_pct(row['r60'])}，"
        f"相对沪深300 20日 {_pct(row.get('excess_r20'))}，"
        f"截面 {_rank(row.get('rank_r20'))}（{_theme_text(row)}），"
        f"距52周高 {_pct(row.get('dist_52w_high'))}"
    )
    core = (
        f"{position}，{_rs_text(row)}，"
        f"{_macd_text(row)}，年化波动 {_vol(row['vol20'])}，规模 {aum}，"
        f"5日均额 {_amount(row.get('amount_yi_5d'))}，5日换手 {_ratio(row.get('turnover_5d'))}"
    )
    head = f"综合分 {row['baseline_score']:+.2f}（第{rank}）："
    notes = _risk_notes(row)
    return head + core + (f"；注意：{'、'.join(notes)}" if notes else "")
