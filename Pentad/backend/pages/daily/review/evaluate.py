"""日度复盘的事后评估: 只读取下一交易日收益, 不参与信号日分析输入。

评估口径:
- 入场 = 信号日收盘, 出场 = 下一交易日收盘, close-to-close;
- 基线 = 综合分前 10; 核心 = 信号日有效的 core8 节点持仓(换仓节点之间沿用);
- rank IC 衡量分数与次日收益的截面相关方向, 不衡量收益高低。
"""

from __future__ import annotations

import math
import sqlite3
import statistics
from typing import Any

from services.scoring.ranks import average_ranks


def forward_prices(conn: sqlite3.Connection, date: str) -> dict[str, float]:
    return {
        r["code"]: r["close"]
        for r in conn.execute("SELECT code, close FROM etf_daily WHERE date = ? AND close > 0", (date,))
    }


def _spearman(xs: list[float], ys: list[float]) -> float:
    if len(xs) < 3:
        return 0.0
    rx, ry = average_ranks(xs), average_ranks(ys)
    mx, my = statistics.fmean(rx), statistics.fmean(ry)
    num = sum((a - mx) * (b - my) for a, b in zip(rx, ry))
    den = math.sqrt(sum((a - mx) ** 2 for a in rx) * sum((b - my) ** 2 for b in ry)) or 1e-9
    return num / den


def _summary(values: list[float]) -> dict[str, Any]:
    if not values:
        return {"n": 0}
    return {
        "n": len(values),
        "mean": statistics.fmean(values),
        "median": statistics.median(values),
        "hit_rate": sum(v > 0 for v in values) / len(values),
    }


def evaluate(
    conn: sqlite3.Connection,
    signal: str,
    next_signal: str | None,
    rows: list[dict[str, Any]],
    core_picks: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """事后评估: 下一交易日收盘→收盘收益。只用于观察, 不得回灌到信号日分析输入。

    core_picks 是信号日有效的 core8 节点持仓; 不传时核心桶记 0 只样本。
    """
    if not next_signal:
        return {"skipped": "没有下一个交易日"}
    entry = {r["code"]: r["close"] for r in rows}
    exit_ = forward_prices(conn, next_signal)
    fwd = {code: exit_[code] / price - 1 for code, price in entry.items() if exit_.get(code, 0) > 0}
    if not fwd:
        return {"skipped": f"{next_signal} 无行情数据"}
    valid = [r for r in rows if r["code"] in fwd]
    base = sorted(valid, key=lambda r: -r["baseline_score"])[:10]
    core = [r for r in core_picks or [] if r["code"] in fwd]
    picks = [{"code": r["code"], "name": r["name"], "return": fwd[r["code"]]} for r in core]
    base_picks = [{"code": r["code"], "name": r["name"], "return": fwd[r["code"]]} for r in base]
    return {
        "next_signal": next_signal,
        "universe": _summary([fwd[r["code"]] for r in valid]),
        "baseline_top10": _summary([p["return"] for p in base_picks]),
        "baseline_top10_picks": base_picks,
        "core_holdings": _summary([p["return"] for p in picks]),
        "core_holdings_picks": picks,
        "rank_ic_baseline": _spearman(
            [r["baseline_score"] for r in valid],
            [fwd[r["code"]] for r in valid],
        ),
        "index_returns": {
            r["code"]: r["next_close"] / r["close"] - 1
            for r in conn.execute(
                """
                SELECT a.code, a.close, b.close AS next_close
                FROM index_daily a JOIN index_daily b ON b.code = a.code AND b.date = ?
                WHERE a.date = ? AND a.close > 0 AND b.close > 0
                """,
                (next_signal, signal),
            )
        },
        "warning": "事后期望值, 只用于评估, 不得进入信号日分析上下文",
    }
