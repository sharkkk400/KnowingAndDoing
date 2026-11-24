"""成交画像: 成交额 / 换手率 / 量比 / 缩量回撤。

纯展示字段, 不参与 rule/baseline 排序; 全部只用 signal_date 及之前的行情与份额。
成交量按现金额单位校准: 腾讯日线为"手", 1 手 = 100 份。
"""

from __future__ import annotations

import statistics
from bisect import bisect_right
from typing import Any

VOLUME_SHARES_MULTIPLIER = 100  # 腾讯日线成交量单位为手, 1 手 = 100 份
PROFILE_BARS = 20
# 新浪降级源按"股"返回(相差 100 倍), 超阈值视为单位异常, 不输出换手/成交额。
MAX_PLAUSIBLE_TURNOVER = 0.60
MAX_PLAUSIBLE_AMOUNT_YI = 1000.0
SHRINK_VOL_RATIO = 0.8  # 5 日均量/20 日均量 低于 0.8 视为缩量
SHRINK_DD20 = -0.03  # 距 20 日高点回撤超过 3% 视为回撤
LIQUIDITY_MIN_AMOUNT_YI = 0.5  # 5 日均成交额低于 0.5 亿视为流动性偏弱


def _mean(values: list[float]) -> float | None:
    return statistics.fmean(values) if values else None


def _turnover_series(bars: list[dict[str, Any]], pool: list[dict[str, Any]], n: int) -> list[float | None]:
    """逐日换手率 = 成交份额 / 当日已知总份额; 份额按 T+1 披露, 取 <= 当日的最后一条。"""
    points = [(s["date"], float(s["shares_yi"])) for s in pool if s["shares_yi"]]
    dates = [p[0] for p in points]
    result: list[float | None] = []
    for bar in bars[-n:]:
        idx = bisect_right(dates, bar["date"]) - 1
        if idx < 0:
            result.append(None)
            continue
        result.append(bar["volume"] * VOLUME_SHARES_MULTIPLIER / (points[idx][1] * 1e8))
    return result


def build(bars: list[dict[str, Any]], pool: list[dict[str, Any]], r20: float) -> dict[str, Any]:
    closes = [b["close"] for b in bars]
    volumes = [b["volume"] for b in bars]
    amounts = [v * VOLUME_SHARES_MULTIPLIER * c / 1e8 for v, c in zip(volumes[-PROFILE_BARS:], closes[-PROFILE_BARS:])]
    turnovers = _turnover_series(bars, pool, PROFILE_BARS)
    amount_ok = len(amounts) == PROFILE_BARS and max(amounts) <= MAX_PLAUSIBLE_AMOUNT_YI
    turnover_ok = amount_ok and all(t is not None and t <= MAX_PLAUSIBLE_TURNOVER for t in turnovers)
    vol_ratio = statistics.fmean(volumes[-5:]) / statistics.fmean(volumes[-PROFILE_BARS:])
    dd20 = closes[-1] / max(closes[-PROFILE_BARS:]) - 1
    return {
        "vol_ratio_5_20": vol_ratio,
        "dd20": dd20,
        "amount_yi_5d": _mean(amounts[-5:]) if amount_ok else None,
        "amount_yi_20d": _mean(amounts) if amount_ok else None,
        "turnover_5d": _mean([t for t in turnovers[-5:] if t is not None]) if turnover_ok else None,
        "turnover_20d": _mean([t for t in turnovers if t is not None]) if turnover_ok else None,
        "shrink_pullback": bool(dd20 <= SHRINK_DD20 and vol_ratio <= SHRINK_VOL_RATIO and r20 > 0),
    }
