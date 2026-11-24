"""腾讯实时行情解析、交易时段判定与批量缓存的单元测试(不触网)。"""

from __future__ import annotations

from datetime import datetime

import pytest

from data.fetch import realtime


def _line(**overrides: str) -> str:
    fields = ["0"] * 60
    fields[1] = "沪深300ETF"
    fields[2] = "510300"
    fields[3] = "4.123"
    fields[4] = "4.100"
    fields[5] = "4.105"
    fields[6] = "123456"
    fields[30] = "20261116142109"
    fields[31] = "0.023"
    fields[32] = "0.56"
    fields[33] = "4.130"
    fields[34] = "4.090"
    fields[37] = "50000"
    for key, value in overrides.items():
        fields[int(key)] = value
    return f'v_sh510300="{"~".join(fields)}";'


def test_market_prefix() -> None:
    assert realtime._market_prefix("510300") == "sh"
    assert realtime._market_prefix("588000") == "sh"
    assert realtime._market_prefix("159915") == "sz"
    with pytest.raises(ValueError):
        realtime._market_prefix("600519")


def test_parse_line() -> None:
    parsed = realtime._parse_line(_line())
    assert parsed is not None
    code, quote = parsed
    assert code == "510300"
    assert quote["name"] == "沪深300ETF"
    assert quote["price"] == 4.123
    assert quote["prev_close"] == 4.100
    assert quote["open"] == 4.105
    assert quote["high"] == 4.130
    assert quote["low"] == 4.090
    assert quote["change"] == 0.023
    assert quote["pct"] == pytest.approx(0.0056)  # 腾讯给百分数, 统一转成小数
    assert quote["volume"] == 123456.0
    assert quote["amount_wan"] == 50000.0
    assert quote["time"] == "2026-11-16 14:21:09"


@pytest.mark.parametrize(
    "raw",
    [
        "",
        "garbage",
        'v_sh510300="1~2";',  # 字段不足
        _line(**{"3": "0.000"}),  # 停牌/无效: 现价<=0
        _line(**{"3": ""}),
    ],
)
def test_parse_line_rejects_invalid(raw: str) -> None:
    assert realtime._parse_line(raw) is None


@pytest.mark.parametrize(
    ("stamp", "expected"),
    [
        ("2026-11-16 09:14", False),
        ("2026-11-16 09:15", True),
        ("2026-11-16 11:30", False),
        ("2026-11-16 13:00", True),
        ("2026-11-16 14:59", True),
        ("2026-11-16 15:00", False),
        ("2026-11-14 10:00", False),  # 周六
    ],
)
def test_is_trading_time(stamp: str, expected: bool) -> None:
    now = datetime.strptime(stamp, "%Y-%m-%d %H:%M")
    assert realtime.is_trading_time(now) is expected


def test_fetch_quotes_dedupes_and_caches(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[list[str]] = []

    def fake_batch(codes: list[str]) -> dict[str, realtime.Quote]:
        calls.append(list(codes))
        return {code: {"price": 1.0} for code in codes}

    monkeypatch.setattr(realtime, "_CACHE", {})
    monkeypatch.setattr(realtime, "_fetch_batch", fake_batch)

    first = realtime.fetch_quotes(["510300", "510300", "159915"])
    assert calls == [["510300", "159915"]]
    assert set(first) == {"510300", "159915"}

    second = realtime.fetch_quotes(["510300", "159915"])
    assert len(calls) == 1  # TTL 内命中缓存, 不重复触网
    assert second == first


def test_fetch_quotes_keeps_stale_on_failure(monkeypatch: pytest.MonkeyPatch) -> None:
    def boom(codes: list[str]) -> dict[str, realtime.Quote]:
        raise RuntimeError("network down")

    monkeypatch.setattr(realtime, "_CACHE", {"510300": (0.0, {"price": 3.0})})
    monkeypatch.setattr(realtime, "_fetch_batch", boom)

    assert realtime.fetch_quotes(["510300"])["510300"]["price"] == 3.0
    assert realtime.fetch_quotes(["159915"]) == {}  # 无缓存时返回空, 不抛错


def _quote(**overrides: float | str | None) -> realtime.Quote:
    quote: realtime.Quote = {
        "time": "2026-11-16 14:25:48",
        "price": 1.05,
        "open": 1.01,
        "high": 1.06,
        "low": 1.0,
        "volume": 123.0,
    }
    quote.update(overrides)
    return quote


def test_with_live_bar_appends_today(monkeypatch: pytest.MonkeyPatch) -> None:
    from pages.etf import router as etfs

    rows = [{"date": "2026-11-13", "open": 1.0, "close": 1.0, "high": 1.0, "low": 1.0, "volume": 1.0}]
    monkeypatch.setattr(etfs.realtime, "fetch_quotes", lambda codes: {"515170": _quote()})

    out = etfs._with_live_bar("515170", rows)
    assert len(out) == 2
    assert out[-1] == {
        "date": "2026-11-16",
        "open": 1.01,
        "close": 1.05,
        "high": 1.06,
        "low": 1.0,
        "volume": 123.0,
    }
    assert etfs._with_live_bar("515170", out) == out  # 库里已有当日K线, 不重复追加


def test_with_live_bar_skips_without_quote(monkeypatch: pytest.MonkeyPatch) -> None:
    from pages.etf import router as etfs

    rows = [{"date": "2026-11-13", "open": 1.0, "close": 1.0, "high": 1.0, "low": 1.0, "volume": 1.0}]
    monkeypatch.setattr(etfs.realtime, "fetch_quotes", lambda codes: {})

    assert etfs._with_live_bar("515170", rows) == rows


def test_live_bar_falls_back_to_price_when_fields_missing(monkeypatch: pytest.MonkeyPatch) -> None:
    from pages.etf import router as etfs

    quote = _quote(open=0.0, high=None, low="bad", volume=0.0)
    monkeypatch.setattr(etfs.realtime, "fetch_quotes", lambda codes: {"515170": quote})

    bar = etfs._live_bar("515170")
    assert bar is not None
    assert bar["open"] == 1.05 and bar["high"] == 1.05 and bar["low"] == 1.05
    assert bar["volume"] == 0.0
