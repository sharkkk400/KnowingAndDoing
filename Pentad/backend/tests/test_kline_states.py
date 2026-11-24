"""信号日 MACD 状态: 四象限趋势分、周期权重与月线当月至今口径(防后视镜)。"""

from __future__ import annotations

import sqlite3
from datetime import date, timedelta

import pytest

from data.store.database import get_conn
from services.kline import aggregate, macd, states
from services.scoring import features


def _state(zone: str, trend: str) -> dict:
    return {"zone": zone, "trend": trend}


def test_trend_score_follows_signed_direction() -> None:
    empty = {"week": None, "month": None}
    # 水上走强满分; 红柱缩短动能衰减不奖不罚; 水下两象限均扣分(绿柱缩短是阴跌中继, 非见底)
    assert states.trend_score({**empty, "day": _state("above", "rising")}) == 0.6
    assert states.trend_score({**empty, "day": _state("above", "falling")}) == 0.0
    assert states.trend_score({**empty, "day": _state("below", "rising")}) == -0.3
    assert states.trend_score({**empty, "day": _state("below", "falling")}) == -0.6
    # 零轴/柱体持平不猜测方向
    assert states.trend_score({**empty, "day": _state("zero", "falling")}) == 0.0
    assert states.trend_score({**empty, "day": _state("above", "flat")}) == 0.0


def test_trend_score_penalizes_zero_cross_reversal() -> None:
    """柱体由 +0.0001 翻到 -0.0021: 绝对值放大, 但方向是转空, 必须扣分。"""
    bars = [
        {"date": "2024-01-01", "dif": 0.008, "dea": 0.0075, "hist": 0.0001},
        {"date": "2024-01-02", "dif": 0.006, "dea": 0.007, "hist": -0.0021},
    ]
    day = macd.state(bars)
    assert day is not None and day["zone"] == "below"
    assert day["trend"] == "falling" and day["flip"] == "dead"
    assert states.trend_score({"day": day, "week": None, "month": None}) == -0.6


def test_period_weight_day_doubles_week() -> None:
    assert states.PERIOD_WEIGHTS["day"] == 2 * states.PERIOD_WEIGHTS["week"]
    assert states.PERIOD_WEIGHTS["week"] > states.PERIOD_WEIGHTS["month"] > 0
    assert round(sum(states.PERIOD_WEIGHTS.values()), 4) == 1.0
    all_bonus = states.trend_score(
        {
            "day": _state("above", "rising"),
            "week": _state("above", "rising"),
            "month": _state("above", "rising"),
        }
    )
    assert all_bonus == round(sum(states.PERIOD_WEIGHTS.values()), 4)


def _month_days(months: int) -> list[list[str]]:
    grouped: dict[tuple[int, int], list[str]] = {}
    day = date(2018, 1, 1)
    while len(grouped) <= months:  # 多走一个月, 保证第 months 个月完整
        if day.weekday() < 5:
            grouped.setdefault((day.year, day.month), []).append(day.isoformat())
        day += timedelta(days=1)
    return list(grouped.values())[:months]


def _seed(conn: sqlite3.Connection) -> tuple[str, str, float, float]:
    """40 个月日线; 信号取最后一个月的周五(周线完整), 信号之后暴跌到月末。"""
    months = _month_days(40)
    last = months[-1]
    signal_offset = max(i for i, day in enumerate(last[:-3]) if date.fromisoformat(day).weekday() == 4)
    base = 100 + (len(months) - 1) * 2
    closes: dict[str, float] = {}
    with conn:
        for index, days in enumerate(months):
            for offset, day in enumerate(days):
                close: float
                if index < len(months) - 1:
                    close = 100 + index * 2
                elif offset <= signal_offset:
                    close = base + offset
                else:
                    close = 1.0
                closes[day] = close
                conn.execute(
                    "INSERT INTO etf_daily (date, code, close, volume) VALUES (?, ?, ?, ?)",
                    (day, "510300", close, 1_000_000),
                )
    signal, month_end = last[signal_offset], last[-1]
    return signal, month_end, closes[signal], closes[month_end]


def test_month_state_uses_month_to_date_close() -> None:
    conn = get_conn()
    signal, month_end, signal_close, month_end_close = _seed(conn)
    full = states.MacdStateProvider.load(conn, month_end)

    at_signal = full.states("510300", signal, signal_close)
    assert at_signal["day"] is not None and at_signal["week"] is not None and at_signal["month"] is not None

    # 用信号日之后的数据重算, 信号日的月线状态必须完全不变
    with conn:
        conn.execute("DELETE FROM etf_daily WHERE date > ?", (signal,))
    truncated = states.MacdStateProvider.load(conn, signal)
    assert truncated.states("510300", signal, signal_close) == at_signal

    # 月末崩溃不得回灌到月中信号: 月末状态必须与信号日不同
    at_month_end = full.states("510300", month_end, month_end_close)
    assert at_month_end["month"] is not None
    assert at_month_end["month"]["hist"] != at_signal["month"]["hist"]


def _weekday_bars(days: int) -> list[tuple[str, float]]:
    """确定性涨跌交替的日线, 末尾对齐到周五, 保证信号周是完整周。"""
    out: list[tuple[str, float]] = []
    day = date(2019, 1, 7)  # 周一
    price = 100.0
    while len(out) < days or day.weekday() != 4:
        if day.weekday() < 5:
            price *= 1.004 if len(out) % 9 < 6 else 0.997
            out.append((day.isoformat(), round(price, 4)))
        day += timedelta(days=1)
    return out


def test_week_state_uses_previous_two_completed_weeks() -> None:
    conn = get_conn()
    bars = _weekday_bars(260)
    with conn:
        conn.executemany(
            "INSERT INTO etf_daily (date, code, close, volume) VALUES (?, '510300', ?, 1000000)",
            bars,
        )
    signal, close = bars[-1]
    provider = states.MacdStateProvider.load(conn, signal)
    week_state = provider.states("510300", signal, close)["week"]

    weeks = macd.attach(aggregate.resample([{"date": d, "close": c} for d, c in bars], "week"))
    assert week_state is not None
    # 信号周(与信号同日收盘)不参与周线判断, 回退到上周 vs 上上周
    assert week_state["date"] == weeks[-2]["date"]
    assert week_state["hist"] == pytest.approx(weeks[-2]["hist"])
    expected = "rising" if weeks[-2]["hist"] > weeks[-3]["hist"] else "falling"
    assert week_state["trend"] == expected
    # 日线仍以信号日收盘为准
    day_state = provider.states("510300", signal, close)["day"]
    assert day_state is not None and day_state["date"] == signal


def test_score_uses_trend_as_main_factor() -> None:
    def row(code: str, trend: float) -> dict:
        return {
            "code": code,
            "r5": 0.01,
            "r20": 0.05,
            "r60": 0.10,
            "vol20": 0.20,
            "flow_5d": 0.0,
            "aum_yi": 10.0,
            "trend_score": trend,
            "macd_states": {},
        }

    rows = [row("510300", -0.5), row("510500", 0.5)]
    features.score(rows)
    first, second = rows
    assert first["core_score"] == second["core_score"] == 0.0
    # 趋势分占 60%: ±0.5 的趋势差直接拉开 ±0.3 的综合分
    assert first["baseline_score"] == -0.3 and second["baseline_score"] == 0.3
