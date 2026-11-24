"""混合执行口径: 周四收盘卖 / 周五开盘买与顺延卖、真实成交价结算与等权槽位。"""

from __future__ import annotations

import pytest

from pages.daily.review import execution


def test_sell_at_splits_by_buffer_rank() -> None:
    assert execution.sell_at(None) == execution.SELL_CLOSE  # 掉出候选池, 收盘就能确定
    assert execution.sell_at(15) == execution.SELL_CLOSE
    assert execution.sell_at(14) == execution.SELL_OPEN


def test_legs_split_one_rebalance_into_four() -> None:
    plan = execution.legs(
        ["A", "B", "C"],
        ["B", "D"],
        {"A": 9, "B": 2, "C": 20},
    )

    assert plan == {
        "sell_close": ["C"],
        "sell_open": ["A"],
        "keep": ["B"],
        "buy": ["D"],
    }
    assert execution.remaining_after_close_sells(["A", "B", "C"], {"A": 9, "B": 2, "C": 20}) == ["A", "B"]


def test_plans_uses_pre_ranks_of_dropped_names() -> None:
    """掉出目标的名字只有 sell 行, 预备排名必须从节点全量 pick 里取, 否则一律误判为收盘卖。"""
    nodes = {"D1": [{"code": "A"}], "D2": [{"code": "B"}]}
    pre: dict[str, dict[str, int | None]] = {"D1": {"A": 1}, "D2": {"A": 20, "B": 2}}

    plans = execution.plans(nodes, pre)

    assert plans["D2"]["sell_close"] == ["A"]
    assert plans["D2"]["sell_open"] == []
    assert plans["D2"]["buy"] == ["B"]

    kept = execution.plans(nodes, {"D1": {"A": 1}, "D2": {"A": 5, "B": 2}})
    assert kept["D2"]["sell_open"] == ["A"]
    assert kept["D2"]["buy"] == ["B"]


def test_plans_falls_back_to_pick_pre_rank() -> None:
    nodes = {"D1": [{"code": "A"}], "D2": [{"code": "B"}]}

    plans = execution.plans(nodes)

    # 节点里没有卖出行的预备排名 → 缺排名按收盘卖, 保守但不会凭空多持有一天。
    assert plans["D2"]["sell_close"] == ["A"]


def _prices() -> dict[str, dict[str, dict[str, float | None]]]:
    return {
        "A": {
            "E": {"open": 9.8, "close": 10.0},
            "O": {"open": 10.5, "close": 11.0},
            "X": {"open": 11.5, "close": 12.0},
        },
        "B": {"O": {"open": 5.0, "close": 5.5}, "X": {"open": 5.8, "close": 6.0}},
        "C": {"E": {"open": 19.5, "close": 20.0}, "O": {"open": 19.0, "close": 19.5}},
        "D": {"E": {"open": 30.0, "close": 30.0}},
    }


PLAN = {"keep": ["A"], "buy": ["B"], "sell_open": ["C"], "sell_close": ["D"]}


def test_settle_uses_real_fills_and_slot_denominator() -> None:
    settled = execution.settle(PLAN, _prices(), "E", "O", "X")

    returns = settled["returns"]
    assert returns["A"] == pytest.approx(12.0 / 10.0 - 1)  # 持有: 收盘 → 收盘
    assert returns["B"] == pytest.approx(6.0 / 5.0 - 1)  # 新买入: 开盘 → 收盘
    assert returns["C"] == pytest.approx(19.0 / 20.0 - 1)  # 顺延卖出: 收盘 → 次日开盘
    assert "D" not in returns  # 周四收盘已退出, 本段不再承担涨跌
    assert settled["n"] == 3  # 槽位数取节点前后较大者
    assert settled["mean"] == pytest.approx((0.2 + 0.2 - 0.05) / 3, abs=1e-6)
    assert settled["hit_rate"] == pytest.approx(2 / 3)


def test_settle_counts_missing_prices_as_cash() -> None:
    prices = _prices()
    del prices["B"]["O"]  # 新买入的标的当日无成交价 → 空槽按现金记 0

    settled = execution.settle(PLAN, prices, "E", "O", "X")

    assert settled["returns"].get("B") is None
    assert settled["n"] == 3
    assert settled["mean"] == pytest.approx(0.15 / 3, abs=1e-6)


def test_settle_all_slots_filled_by_buys() -> None:
    """从空仓建仓: 分母是新买入的槽数, 不能按旧的 0 只算成 0 收益。"""
    settled = execution.settle(
        {"keep": [], "buy": ["A", "B"], "sell_open": [], "sell_close": []},
        _prices(),
        "E",
        "O",
        "X",
    )

    assert settled["n"] == 2
    assert settled["mean"] == pytest.approx(((12.0 / 10.5 - 1) + (6.0 / 5.0 - 1)) / 2, abs=1e-6)


def test_next_day_returns_following_trading_day() -> None:
    calendar = ["2026-11-16", "2026-11-17", "2026-11-18"]

    assert execution.next_day(calendar, "2026-11-16") == "2026-11-17"
    assert execution.next_day(calendar, "2026-11-18") is None
    assert execution.next_day(calendar, "2026-11-15") == "2026-11-16"
