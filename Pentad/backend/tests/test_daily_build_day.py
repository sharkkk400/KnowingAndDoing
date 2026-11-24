"""build_day 的单日结算: 盘中缺份额仍能评分、节点日按混合执行价结算。"""

from __future__ import annotations

import pytest

from data.store.database import get_conn
from pages.daily.review import build
from services.kline import states as macd_states
from services.scoring import features
from tests.daily_seed import build_day, seed


def test_build_day_scores_without_same_day_shares() -> None:
    """盘中预选场景: 已合成今日价格 bar, 但份额只到昨日, 评分不能被份额切片拖成空池。"""
    conn = get_conn()
    days = seed(conn)
    today = "2024-04-30"  # 不在种子日历内, 模拟盘中新增交易日

    meta = features.load_meta(conn)
    raw = features.load_daily(conn, days[0], days[-1])
    today_bar = {"date": today, "close": 0.0, "volume": 1_000_000}
    daily = {code: [*bars, {**today_bar, "close": bars[-1]["close"] * 1.003}] for code, bars in raw.items()}
    daily_dates = {code: [b["date"] for b in bars] for code, bars in daily.items()}
    shares = features.load_shares(conn, days[0], days[-1])  # 今日份额未发布
    shares_dates = {code: [b["date"] for b in bars] for code, bars in shares.items()}
    bench = features.load_index(conn, days[0], days[-1]).get("000300", [])
    provider = macd_states.MacdStateProvider.from_bars(daily)
    held = [{"code": "510300", "core_rank": 1, "core_score": 0.8, "held": 1, "action": "hold"}]

    summary, picks = build.build_day(
        conn,
        today,
        None,
        meta,
        daily,
        daily_dates,
        shares,
        shares_dates,
        bench,
        [b["date"] for b in bench],
        provider,
        len(daily),
        features.DEFAULT_MIN_AUM_YI,
        held,
    )

    assert summary["scored"] == 2
    assert summary["shares_available"] == 2
    assert [p["code"] for p in picks if p["bucket"] == "core"] == ["510300"]  # 节点持仓桶
    assert summary["evaluation"].get("skipped")


def test_build_day_node_settles_with_hybrid_plan() -> None:
    """节点日: 持有段收盘→收盘, 新买入开盘→收盘, 顺延卖出收盘→次日开盘, 空槽记 0。"""
    conn = get_conn()
    days = seed(conn)
    held = [
        {"code": "510300", "name": "沪深300ETF测试", "core_rank": 1, "core_score": 0.8, "held": 1, "action": "hold"}
    ]
    signal, next_signal = days[-3], days[-2]

    buy_plan = {"keep": ["510300"], "buy": ["510500"], "sell_open": [], "sell_close": []}
    summary, picks = build_day(conn, days, signal, next_signal, held, buy_plan)

    assert summary["evaluation"]["core_holdings"]["mean"] == pytest.approx((0.003 - 0.002) / 2, abs=1e-6)
    assert {p["code"]: p["next_return"] for p in picks if p["bucket"] == "core"} == {"510300": pytest.approx(0.003)}

    defer_plan = {"keep": ["510300"], "buy": [], "sell_open": ["510500"], "sell_close": []}
    summary, _ = build_day(conn, days, signal, next_signal, held, defer_plan)

    assert summary["evaluation"]["core_holdings"]["mean"] == pytest.approx(0.003 / 2, abs=1e-6)
