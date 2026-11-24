"""core8 日频核心分: 秩变换、排名缓冲带换仓、五日锚点、MACD 柱体形状。"""

from __future__ import annotations

import math
from datetime import date, timedelta
from types import SimpleNamespace
from typing import Any

import pytest

from services.scoring.core import rebalance
from services.scoring.core import score as core

# ---------------------------------------------------------------- rank_z


def test_rank_z_monotonic_bounds_and_ties() -> None:
    z = core.rank_z([float(i) for i in range(20)])
    assert z == sorted(z)
    assert z[0] == pytest.approx(-19 / 21)
    assert z[-1] == pytest.approx(19 / 21)
    assert z == sorted(set(z))  # 无并列时每个值各不相同

    tied = core.rank_z([1.0] * 10 + [2.0] * 10)
    assert tied[0] == tied[9] == pytest.approx(-10 / 21)
    assert tied[10] == tied[19] == pytest.approx(10 / 21)


def test_rank_z_missing_and_small_sample_neutral() -> None:
    assert core.rank_z([1.0, 2.0, 3.0]) == [0.0, 0.0, 0.0]

    z = core.rank_z([float(i) for i in range(19)] + [math.nan])
    assert z == [0.0] * 20, "有效样本不足 20 个时整列中性"

    mixed = core.rank_z([float(i) for i in range(20)] + [math.nan, math.inf])
    assert mixed[20] == 0.0
    assert mixed[21] == 0.0
    assert mixed[0] != 0.0


# ---------------------------------------------------------------- rebalance


def _ranked(n: int = 20) -> list[str]:
    return [f"C{i:02d}" for i in range(n)]


def test_rebalance_keeps_within_buffer_and_fills_gaps() -> None:
    ranked = _ranked()
    target = rebalance.rebalance(["C04", "C19"], ranked)
    assert target == ["C04", "C00", "C01", "C02", "C03"], "第 5 名留仓, 掉出前 15 的换掉并按排名补齐"
    assert len(target) == core.HOLD_TOP


def test_rebalance_buffer_boundary_and_unknown_names() -> None:
    ranked = _ranked()
    kept = rebalance.rebalance(["C14"], ranked)
    assert kept[0] == "C14", "排名 15 以内(0-based 14)继续持有"

    dropped = rebalance.rebalance(["C15"], ranked)
    assert "C15" not in dropped, "排名 16 起卖出"

    unknown = rebalance.rebalance(["NOT_IN_UNIVERSE"], ranked)
    assert unknown == ranked[: core.HOLD_TOP]


def test_rebalance_full_hold_is_stable() -> None:
    ranked = _ranked()
    assert rebalance.rebalance(ranked[:5], ranked) == ranked[:5]


# ---------------------------------------------------------------- 换仓锚点


def _calendar(n: int = 20) -> list[str]:
    start = date(2022, 1, 4)
    return [(start + timedelta(days=i)).isoformat() for i in range(n)]


def test_should_rebalance_aligned_to_anchor() -> None:
    calendar = _calendar()
    anchor = calendar[3]
    assert rebalance.should_rebalance(calendar, calendar[3], anchor)
    assert rebalance.should_rebalance(calendar, calendar[8], anchor)
    assert rebalance.should_rebalance(calendar, calendar[13], anchor)
    assert not rebalance.should_rebalance(calendar, calendar[9], anchor)
    assert rebalance.should_rebalance(calendar, calendar[9], anchor, step=1)


def test_next_rebalance_steps_to_next_node() -> None:
    calendar = _calendar()
    anchor = calendar[3]
    assert rebalance.next_rebalance(calendar, calendar[3], anchor) == calendar[8]
    assert rebalance.next_rebalance(calendar, calendar[6], anchor) == calendar[8]
    assert rebalance.next_rebalance(calendar, calendar[18], anchor) is None, "超出日历尾部返回 None"


# ---------------------------------------------------------------- MACD 柱体形状


def _macd_inputs(n: int = 70, cross_at: int | None = None) -> tuple[Any, list[dict[str, Any]], str]:
    """构造 n 根等距 K 线; cross_at 为全序列下标, 该日起 dif 上穿 dea(此前在水下)。"""
    start = date(2024, 1, 1)
    days = [(start + timedelta(days=i)).isoformat() for i in range(n)]
    labels = [int(d.replace("-", "")) for d in days]
    dif: list[float] = []
    dea: list[float] = []
    for i in range(n):
        above = True if cross_at is None else i >= cross_at
        dif.append(0.3 if above else -0.3)
        dea.append(0.0)
    hist = [0.02] * n
    bars = [{"date": d, "close": 10.0, "volume": 1.0} for d in days]
    return SimpleNamespace(labels=labels, dif=dif, dea=dea, hist=hist), bars, days[-1]


def test_macd_shape_hist_norm_and_cross_age() -> None:
    window_pos = 57  # 观察窗第 58 根上穿 -> 距今 2 个交易日
    series, bars, signal = _macd_inputs(cross_at=70 - core.MACD_BARS + window_pos)
    out: dict[str, float] = {}
    core._macd_shape(out, bars, series, signal, 0.2)
    assert out["hist_norm"] == pytest.approx(0.002 / (0.2 / math.sqrt(252)))
    assert out["zero_cross_age"] == pytest.approx(2.0)


def test_macd_shape_no_cross_reports_full_window() -> None:
    series, bars, signal = _macd_inputs()
    out: dict[str, float] = {}
    core._macd_shape(out, bars, series, signal, 0.2)
    assert out["zero_cross_age"] == pytest.approx(float(core.MACD_BARS))


def test_macd_shape_guards_missing_series_and_history() -> None:
    series, bars, signal = _macd_inputs()
    out: dict[str, float] = {}
    core._macd_shape(out, bars, None, signal, 0.2)
    assert out == {}
    core._macd_shape(out, bars, series, "1999-01-01", 0.2)
    assert out == {}, "MACD 序列未覆盖信号日时不出值"

    short_series, short_bars, short_signal = _macd_inputs(n=core.MACD_BARS)
    out = {}
    core._macd_shape(out, short_bars, short_series, short_signal, 0.2)
    assert out == {}, "不足一个观察窗不参与打分"

    out = {}
    core._macd_shape(out, bars, series, signal, 0.0)
    assert out == {}, "无波动率无法归一"


# ---------------------------------------------------------------- describe


def _row(**kwargs: float) -> dict[str, Any]:
    base = {"dd60": -0.1, "r250": 0.2, "vol20": 0.25, "r20": 0.03, "flow_5d": 0.01}
    base.update(kwargs)
    return base


def _bars(n: int) -> list[dict[str, Any]]:
    start = date(2024, 1, 1)
    return [{"date": (start + timedelta(days=i)).isoformat(), "close": 10.0, "volume": 1_000_000.0} for i in range(n)]


def test_describe_insufficient_bars_is_all_nan() -> None:
    out = core.describe(_row(), _bars(1), [], None, "2024-03-01")
    assert set(out) == set(core.CORE_FEATURES)
    assert all(math.isnan(v) for v in out.values())


def test_describe_z20_and_flow_guards() -> None:
    bars = _bars(61)
    flat_shares = [{"date": b["date"], "shares_yi": 10.0} for b in bars[-21:]]
    out = core.describe(_row(), bars, flat_shares, None, bars[-1]["date"])
    assert out["z20"] == pytest.approx(0.03 / (0.25 / math.sqrt(252) * math.sqrt(20)))
    assert out["dd60"] == pytest.approx(-0.1)
    assert out["r250"] == pytest.approx(0.2)
    assert math.isnan(out["amount_z_60"]), "成交额无波动时不给分, 由 rank_z 转中性"
    assert math.isnan(out["flow_z_60"]), "份额增长率无波动时不给分"
    assert math.isnan(out["hist_norm"]), "无 MACD 序列时不参与"


def test_describe_flow_z_with_varying_shares() -> None:
    bars = _bars(61)
    shares = [{"date": b["date"], "shares_yi": 10.0 + i * 0.1} for i, b in enumerate(bars[-21:])]
    out = core.describe(_row(flow_5d=0.06), bars, shares, None, bars[-1]["date"])
    growths = [shares[i]["shares_yi"] / shares[i - 5]["shares_yi"] - 1 for i in range(5, len(shares))]
    expected = (0.06 - sum(growths) / len(growths)) / (
        sum((g - sum(growths) / len(growths)) ** 2 for g in growths) / len(growths)
    ) ** 0.5
    assert out["flow_z_60"] == pytest.approx(expected)


# ---------------------------------------------------------------- 高位高波扣分


def _trend_bars(n: int, last_close: float | None = None) -> list[dict[str, Any]]:
    start = date(2023, 1, 2)
    closes = [1.0 + i for i in range(n)]
    if last_close is not None:
        closes[-1] = last_close
    return [
        {"date": (start + timedelta(days=i)).isoformat(), "close": c, "volume": 1_000_000.0}
        for i, c in enumerate(closes)
    ]


def test_describe_dd250_needs_full_year_and_uses_window_peak() -> None:
    short = core.describe(_row(), _bars(200), [], None, "2024-03-01")
    assert "dd250" not in short, "不足 250 根不出年内高位"

    bars = _trend_bars(300)
    at_high = core.describe(_row(), bars, [], None, bars[-1]["date"])
    assert at_high["dd250"] == pytest.approx(0.0)

    bars = _trend_bars(300, last_close=270.0)
    dipped = core.describe(_row(), bars, [], None, bars[-1]["date"])
    assert dipped["dd250"] == pytest.approx(270.0 / 299.0 - 1), "峰值取窗口内最高收盘(剔除被替换的最新一根)"


def test_high_vol_penalty_is_one_sided_and_needs_both_conditions() -> None:
    assert core.high_vol_penalty({"vol20": 0.30, "dd250": 0.0}) == 0.0, "低波动高位是正常估值抬升"
    assert core.high_vol_penalty({"vol20": 0.60, "dd250": -0.30}) == 0.0, "高位高波以外的深回撤不罚"
    assert core.high_vol_penalty({"vol20": 0.60, "dd250": -0.01}) == pytest.approx(0.10)
    assert core.high_vol_penalty({"vol20": 0.45, "dd250": -0.03}) == pytest.approx(0.10), "边界含等号"
    assert core.high_vol_penalty({"vol20": 0.60, "dd250": -0.05}) == 0.0, "距高点 5% 已不算贴新高"
    assert core.high_vol_penalty({"vol20": math.nan, "dd250": 0.0}) == 0.0
    assert core.high_vol_penalty({"vol20": 0.60}) == 0.0, "缺年内高点数据不罚"


def test_factor_rows_appends_penalty_only_when_bound() -> None:
    bound = core.factor_rows({"vol20": 0.50, "dd250": -0.01}, {})
    assert len(bound) == len(core.CORE_FEATURES) + 1
    row = bound[-1]
    assert row["key"] == "high_vol_penalty"
    assert row["weight"] is None and row["z"] is None
    assert row["contrib"] == pytest.approx(-core.HIGH_VOL_PENALTY)
    assert sum(f["contrib"] for f in bound) == pytest.approx(-core.HIGH_VOL_PENALTY)

    free = core.factor_rows({"vol20": 0.20, "dd250": 0.0}, {})
    assert len(free) == len(core.CORE_FEATURES)
    assert sum(f["contrib"] for f in free) == 0.0
