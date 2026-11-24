"""趋势结构与风险因子: 52 周位置、均线结构、风险调整动量、回撤、胜率、基准敏感度。

与 profile.py 分工: profile 看成交/规模, 本模块看价格自身的位置与质量。全部只用
传入的日线(已截到 signal_date), 纯函数、不做 I/O; 样本不足的因子一律返回 None,
不拿短样本硬算(新上市 ETF 的 52 周位置没有意义)。
"""

from __future__ import annotations

import math
import statistics
from typing import Any

LOOKBACK_52W = 250
SLOPE_STEP = 5
MDD_WINDOW = 60
BETA_WINDOW = 60
MIN_BETA_SAMPLES = 30


def ret(closes: list[float], n: int) -> float | None:
    if len(closes) <= n or closes[-1 - n] <= 0:
        return None
    return closes[-1] / closes[-1 - n] - 1


def _slope(closes: list[float], window: int, step: int = SLOPE_STEP) -> float | None:
    if len(closes) < window + step:
        return None
    now = statistics.fmean(closes[-window:])
    prev = statistics.fmean(closes[-window - step : -step])
    return now / prev - 1 if prev > 0 else None


def _max_drawdown(closes: list[float]) -> float:
    peak, mdd = closes[0], 0.0
    for close in closes:
        peak = max(peak, close)
        mdd = min(mdd, close / peak - 1)
    return mdd


def _annualized(rets: list[float], downside_only: bool = False) -> float | None:
    sample = [r for r in rets if r < 0] if downside_only else rets
    if len(sample) < 2:
        return None
    return statistics.pstdev(sample) * math.sqrt(252)


def _sharpe(rets: list[float]) -> float | None:
    if len(rets) < 2:
        return None
    sd = statistics.pstdev(rets)
    return statistics.fmean(rets) / sd * math.sqrt(252) if sd else None


def _bench_returns(
    dates: list[str], closes: list[float], bench: dict[str, float], n: int
) -> tuple[list[float], list[float]]:
    """ETF 与基准在共同交易日上的日收益(基准缺该日则跳过), 取最近 n 组。"""
    pairs_etf: list[float] = []
    pairs_bench: list[float] = []
    for i in range(max(1, len(dates) - n), len(dates)):
        prev_date, date = dates[i - 1], dates[i]
        if prev_date not in bench or date not in bench or closes[i - 1] <= 0:
            continue
        pairs_etf.append(closes[i] / closes[i - 1] - 1)
        pairs_bench.append(bench[date] / bench[prev_date] - 1)
    return pairs_etf, pairs_bench


def _beta(er: list[float], br: list[float]) -> tuple[float | None, float | None]:
    if len(er) < MIN_BETA_SAMPLES:
        return None, None
    var = statistics.pvariance(br)
    if not var:
        return None, None
    cov = sum((a - statistics.fmean(er)) * (b - statistics.fmean(br)) for a, b in zip(er, br)) / len(er)
    sd = statistics.pstdev(er) * statistics.pstdev(br)
    return cov / var, (cov / sd if sd else None)


def build(bars: list[dict[str, Any]], bench: dict[str, float] | None = None) -> dict[str, Any]:
    closes = [b["close"] for b in bars]
    rets20 = [closes[i] / closes[i - 1] - 1 for i in range(len(closes) - 20, len(closes))]
    rets60 = [closes[i] / closes[i - 1] - 1 for i in range(len(closes) - 60, len(closes))] if len(closes) > 60 else []
    window_52w = closes[-LOOKBACK_52W:]
    has_52w = len(closes) >= LOOKBACK_52W
    ma20 = statistics.fmean(closes[-20:])
    ma60 = statistics.fmean(closes[-60:])
    ma120 = statistics.fmean(closes[-120:]) if len(closes) >= 120 else None
    result: dict[str, Any] = {
        "r120": ret(closes, 120),
        "r250": ret(closes, 250),
        "dist_52w_high": closes[-1] / max(window_52w) - 1 if has_52w else None,
        "dist_52w_low": closes[-1] / min(window_52w) - 1 if has_52w else None,
        "ma120_dev": closes[-1] / ma120 - 1 if ma120 else None,
        "ma_bull": ma20 > ma60 and (ma120 is None or ma60 > ma120),
        "ma_bear": ma20 < ma60 and (ma120 is None or ma60 < ma120),
        "ma20_slope_5": _slope(closes, 20),
        "ma60_slope_20": _slope(closes, 60, 20),
        "up_ratio_20": sum(r > 0 for r in rets20) / len(rets20),
        "up_ratio_60": sum(r > 0 for r in rets60) / len(rets60) if rets60 else None,
        "downside_vol20": _annualized(rets20, downside_only=True),
        "mdd60": _max_drawdown(closes[-MDD_WINDOW:]),
        "sharpe_20": _sharpe(rets20),
        "sharpe_60": _sharpe(rets60),
        "vol60": _annualized(rets60),
    }
    if bench:
        er, br = _bench_returns([b["date"] for b in bars], closes, bench, BETA_WINDOW)
        beta, corr = _beta(er, br)
        bench_r60 = ret([bench[d] for d in sorted(bench)], 60)
        r60 = ret(closes, 60)
        result.update(
            {
                "beta60": beta,
                "corr60": corr,
                "alpha60": (
                    r60 - beta * bench_r60 if r60 is not None and beta is not None and bench_r60 is not None else None
                ),
            }
        )
    return result
