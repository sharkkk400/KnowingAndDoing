"""盘中预选: 实时现价合成今日 bar 的字段口径与时点守卫(纯函数, 不触网)。"""

from __future__ import annotations

import pytest

from pages.daily.live import context, preview


def test_synthetic_bar_uses_quote_fields() -> None:
    quote = {"price": 4.03, "open": 4.039, "high": 4.044, "low": 4.018, "volume": 4_241_375.0}

    bar = context.synthetic_bar("2026-11-17", quote)

    assert bar == {
        "date": "2026-11-17",
        "open": 4.039,
        "close": 4.03,
        "high": 4.044,
        "low": 4.018,
        "volume": 4_241_375.0,
    }


def test_synthetic_bar_rejects_halted_quote() -> None:
    assert context.synthetic_bar("2026-11-17", {"price": 0, "volume": 0}) is None
    assert context.synthetic_bar("2026-11-17", {"price": None, "volume": 1.0}) is None


def test_cache_ttl_follows_trading_hours(monkeypatch: pytest.MonkeyPatch) -> None:
    """收盘后行情不再变, 缓存要跨过 60 秒轮询, 否则每分钟重跑一次全市场评分。"""
    monkeypatch.setattr(preview.realtime, "is_trading_time", lambda: True)
    assert preview._ttl() == preview.LIVE_TTL_SEC

    monkeypatch.setattr(preview.realtime, "is_trading_time", lambda: False)
    assert preview._ttl() == preview.LIVE_IDLE_TTL_SEC


def test_quote_bar_requires_today_timestamp() -> None:
    """开盘前行情仍停在昨日收盘, 拼成今日 bar 会让今日与昨日重复。"""
    quote = {"price": 4.03, "volume": 1000.0, "time": "2026-11-17 10:43:52"}

    assert context.quote_bar(quote, "2026-11-17") is not None
    assert context.quote_bar({**quote, "time": "2026-11-14 15:00:00"}, "2026-11-17") is None
    assert context.quote_bar({**quote, "time": None}, "2026-11-17") is None


def test_fill_auction_volume_uses_previous_day() -> None:
    """09:25 前集合竞价没有成交量, 用上一交易日成交量占位, 否则整池被成交量校验剔除。"""
    bar = {"date": "2026-11-20", "close": 1.2, "volume": 0.0}
    history = [{"date": "2026-11-19", "volume": 1234.0}]

    filled = context.fill_auction_volume(bar, history)

    assert filled["volume"] == 1234.0
    assert filled["close"] == 1.2
    assert bar["volume"] == 0.0  # 不修改入参


def test_fill_auction_volume_keeps_real_volume() -> None:
    bar = {"date": "2026-11-20", "volume": 50.0}
    assert context.fill_auction_volume(bar, [{"volume": 999.0}])["volume"] == 50.0
