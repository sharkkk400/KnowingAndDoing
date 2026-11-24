"""日频归因: 逐日 core8 持仓/基线/股票池/沪深300 的 T+1 收益序列与累计复利。

口径与周度归因一致(逐日等权复利、不扣费用), 额外统计日频版最关心的两个数:
- turnover_avg: core8 持仓相邻交易日重叠度(1 - 交集/两侧较大桶长), 调仓日才跳升;
- rank_ic_mean: 综合分与次日收益的截面相关性, 直接暴露 1 日维度动量是否均值回复。

年线开关与周度归因同口径: 信号日沪深300 收盘站上 MA250 才承受当日 core8 收益,
跌破/未热身时空仓记 0; 严格 `收盘 > MA`, 判定只用信号日及之前的数据。
日频视图按每日判定, 实际执行会有每日申赎摩擦, 视图不扣费、只展示门控的归因效果。
"""

from __future__ import annotations

import math
import sqlite3
import statistics
from bisect import bisect_right
from typing import Any

from pages.daily.review import store

HS300_CODE = "000300"
GATE_WINDOW = 250  # 年线(含当日), 严格 `收盘 > MA` 判定


def _compound(series: list[dict[str, Any]], gates: list[str | None]) -> list[dict[str, Any]]:
    nav = {"core": 1.0, "baseline": 1.0, "universe": 1.0, "hs300": 1.0}
    gated_nav = 1.0
    gated_started = False
    points = []
    for row, gate in zip(series, gates):
        point = {"signal_date": row["signal_date"], "next_signal": row["next_signal"], "gate": gate}
        for key in nav:
            value = row.get(key)
            if value is None:
                point[key] = None
            else:
                nav[key] *= 1 + value
                point[key] = round(nav[key] - 1, 6)
        if gate == "above" and row.get("core") is not None:
            gated_nav *= 1 + row["core"]
            gated_started = True
        # 空仓段沿用最后净值画平线(与周度归因一致), 首个开仓日前为空。
        point["gated"] = round(gated_nav - 1, 6) if gated_started else None
        points.append(point)
    return points


def _hs300_series(conn: sqlite3.Connection, last: str) -> tuple[list[str], list[float]]:
    rows = conn.execute(
        "SELECT date, close FROM index_daily WHERE code = ? AND date <= ? AND close IS NOT NULL ORDER BY date",
        (HS300_CODE, last),
    ).fetchall()
    return [r["date"] for r in rows], [float(r["close"]) for r in rows]


def _moving_average(closes: list[float], window: int) -> list[float | None]:
    """简单移动平均; 前 window-1 个点为 None(不足一个完整窗口)。"""
    out: list[float | None] = []
    total = 0.0
    for i, close in enumerate(closes):
        total += close
        if i >= window:
            total -= closes[i - window]
        out.append(total / window if i >= window - 1 else None)
    return out


def _gate_states(
    dates: list[str],
    closes: list[float],
    days: list[dict[str, Any]],
    window: int = GATE_WINDOW,
) -> list[str | None]:
    """每个信号日收盘相对年线的状态; 年线未热身(不足 window 根)记为 None, 等同不能开仓。"""
    ma = _moving_average(closes, window)
    states: list[str | None] = []
    for day in days:
        index = bisect_right(dates, day["signal_date"]) - 1
        avg = ma[index] if index >= 0 else None
        states.append(None if avg is None else ("above" if closes[index] > avg else "below"))
    return states


def _mean(values: list[float]) -> float | None:
    return round(statistics.fmean(values), 6) if values else None


def _overall(
    series: list[dict[str, Any]],
    core_picks: list[dict[str, Any]],
    gates: list[str | None] | None = None,
) -> dict[str, Any]:
    settled = [s for s in series if s["core"] is not None]

    def stats(key: str) -> dict[str, Any]:
        vals = [s[key] for s in settled if s[key] is not None]
        return {
            "mean": _mean(vals),
            "positive": sum(v > 0 for v in vals) if vals else None,
        }

    result: dict[str, Any] = {"days": len(settled)}
    for key in ("core", "baseline", "universe"):
        block = stats(key)
        vals = [s[key] for s in settled if s[key] is not None]
        block["cumulative"] = round(math.prod(1 + v for v in vals) - 1, 6) if vals else None
        result[key] = block
    hs300_vals = [s["hs300"] for s in settled if s["hs300"] is not None]
    result["hs300"] = {
        "mean": _mean(hs300_vals),
        "cumulative": round(math.prod(1 + v for v in hs300_vals) - 1, 6) if hs300_vals else None,
        "positive": sum(v > 0 for v in hs300_vals) if hs300_vals else None,
    }
    ics = [s["rank_ic"] for s in settled if s["rank_ic"] is not None]
    result["rank_ic_mean"] = _mean(ics)
    result["rank_ic_positive_days"] = sum(v > 0 for v in ics) if ics else None

    if gates is not None:
        gated = [s["core"] for s, gate in zip(settled, gates) if gate == "above" and s["core"] is not None]
        result["gate_on_days"] = sum(gate == "above" for gate in gates)
        result["gate_off_days"] = sum(gate == "below" for gate in gates)
        result["gated_cumulative"] = round(math.prod(1 + v for v in gated) - 1, 6) if gated else None

    prev: list[str] | None = None
    turnover_sum = 0.0
    turnover_n = 0
    by_day: dict[str, list[str]] = {}
    for pick in core_picks:
        by_day.setdefault(pick["signal_date"], []).append(pick["code"])
    for day in sorted(by_day):
        codes = by_day[day]
        if prev is not None:
            overlap = len(set(codes) & set(prev))
            denom = max(len(codes), len(prev))  # 桶不满时按实际较大的一侧归一
            turnover_sum += 1 - overlap / denom
            turnover_n += 1
        prev = codes
    result["turnover_avg"] = round(turnover_sum / turnover_n, 4) if turnover_n else None
    return result


def build(
    conn: sqlite3.Connection,
    start: str | None = None,
    end: str | None = None,
) -> dict[str, Any]:
    days = store.list_days(conn, start, end)
    series = [
        {
            "signal_date": d["signal_date"],
            "next_signal": d["next_signal"],
            "core": d["core_mean"],
            "baseline": d["baseline_mean"],
            "universe": d["universe_mean"],
            "rank_ic": d["rank_ic"],
            "hs300": (d["index_returns"] or {}).get(HS300_CODE),
        }
        for d in days
    ]
    core_picks = store.all_picks(conn, "core", start, end, require_return=False)
    last = max((d["next_signal"] or d["signal_date"] for d in days), default="")
    dates, closes = _hs300_series(conn, last)
    gates = _gate_states(dates, closes, days)
    return {
        "days": days,
        "cumulative": _compound(series, gates),
        "overall": _overall(series, core_picks, gates),
    }
