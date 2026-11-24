"""周/月K聚合与 MACD 指标: 分组边界、预热期、收敛扩散与水上水下判定。"""

from __future__ import annotations

from datetime import date, timedelta

import pytest

from services.kline import aggregate, macd


def _bar(day: str, close: float, open_: float | None = None, volume: float = 10.0) -> dict:
    return {
        "date": day,
        "open": close if open_ is None else open_,
        "close": close,
        "high": close + 1,
        "low": close - 1,
        "volume": volume,
    }


def _series(count: int, start: date = date(2024, 1, 1)) -> list[dict]:
    return [_bar((start + timedelta(days=index)).isoformat(), 1.0 + index * 0.1) for index in range(count)]


def test_resample_week_uses_iso_week_and_last_trading_day() -> None:
    bars = [
        _bar("2020-12-30", 10.0, open_=9.0, volume=1.0),
        _bar("2020-12-31", 11.0, volume=2.0),
        _bar("2021-01-04", 12.0, open_=11.5, volume=3.0),
        _bar("2021-01-08", 13.0, volume=4.0),
    ]
    weekly = aggregate.resample(bars, "week")
    assert [bar["date"] for bar in weekly] == ["2020-12-31", "2021-01-08"]
    assert weekly[0]["open"] == 9.0
    assert weekly[0]["close"] == 11.0
    assert weekly[0]["high"] == 12.0  # 组内最高价
    assert weekly[0]["low"] == 9.0
    assert weekly[0]["volume"] == 3.0
    assert weekly[1]["open"] == 11.5 and weekly[1]["close"] == 13.0


def test_resample_month_and_day() -> None:
    bars = [_bar("2024-01-31", 10.0), _bar("2024-02-01", 11.0), _bar("2024-02-29", 12.0)]
    monthly = aggregate.resample(bars, "month")
    assert [bar["date"] for bar in monthly] == ["2024-01-31", "2024-02-29"]
    assert monthly[1]["open"] == 11.0 and monthly[1]["close"] == 12.0
    assert aggregate.resample(bars, "day") == bars
    with pytest.raises(ValueError):
        aggregate.resample(bars, "quarter")


def test_macd_warmup_hides_unreliable_values() -> None:
    enriched = macd.attach(_series(40))
    assert enriched[macd.SLOW - 2]["dif"] is None
    assert enriched[macd.SLOW - 1]["dif"] is not None
    assert enriched[macd.SLOW - 1]["hist"] is None
    assert enriched[macd.MIN_BARS - 1]["hist"] is None
    assert enriched[macd.MIN_BARS]["hist"] is not None
    assert enriched[-1]["dif"] > 0 and enriched[-1]["dea"] > 0


def test_macd_state_trend_and_zone() -> None:
    def bars(hist: list[float], dif: float, dea: float) -> list[dict]:
        return [
            {"date": f"2024-01-0{index + 1}", "dif": dif, "dea": dea, "hist": value} for index, value in enumerate(hist)
        ]

    rising = macd.state(bars([0.1, 0.3], 0.8, 0.4))
    assert rising is not None
    assert rising["trend"] == "rising" and rising["zone"] == "above" and rising["flip"] is None

    falling = macd.state(bars([0.5, 0.2], 0.8, 0.4))
    assert falling is not None and falling["trend"] == "falling"

    below = macd.state(bars([-0.1, -0.2], -0.5, -0.3))
    assert below is not None and below["trend"] == "falling" and below["zone"] == "below"

    # 定区看柱体符号而非 DIF/DEA: dif>0 而 dea<0 但柱体为正, 仍是水上
    cross = macd.state(bars([0.1, 0.2], 0.3, -0.1))
    assert cross is not None and cross["zone"] == "above"

    zero = macd.state(bars([0.1, 0.0], 0.3, 0.3))
    assert zero is not None and zero["zone"] == "zero" and zero["trend"] == "falling"


def test_macd_state_treats_zero_cross_as_reversal_not_expansion() -> None:
    """柱体由 +0.001 翻到 -0.002: 绝对值放大, 但方向是转空, 必须判走弱/死叉。"""
    bars = [
        {"date": "2024-01-01", "dif": 0.008, "dea": 0.0075, "hist": 0.001},
        {"date": "2024-01-02", "dif": 0.006, "dea": 0.007, "hist": -0.002},
    ]
    state = macd.state(bars)
    assert state is not None
    assert state["zone"] == "below"  # 柱体已翻绿, 按柱体符号属水下
    assert state["trend"] == "falling" and state["flip"] == "dead"

    recovery = macd.state([bars[1], bars[0]])
    assert recovery is not None and recovery["trend"] == "rising" and recovery["flip"] == "golden"


def test_macd_state_requires_two_warm_bars() -> None:
    assert macd.state([]) is None
    assert macd.state([{"date": "2024-01-01", "dif": 0.1, "dea": 0.1, "hist": 0.0}]) is None
    assert macd.state([{"date": "2024-01-01", "hist": None}, {"date": "2024-01-02", "hist": 0.1}]) is None


def test_attach_forward_fills_missing_close() -> None:
    bars = _series(40)
    bars[10]["close"] = None
    enriched = macd.attach(bars)
    # 缺失收盘不产生 NaN 断层, 预热完成后 MACD 仍连续
    assert enriched[macd.MIN_BARS]["hist"] is not None
    assert enriched[-1]["dif"] is not None
