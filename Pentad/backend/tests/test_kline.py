"""腾讯K线解析、市场前缀与日期分块的单元测试(不触网)。"""

from __future__ import annotations

import pytest

from data.fetch import kline


def test_market_prefix() -> None:
    assert kline._market_prefix("510300") == "sh"
    assert kline._market_prefix("588000") == "sh"
    assert kline._market_prefix("159915") == "sz"
    with pytest.raises(ValueError):
        kline._market_prefix("600519")


def test_parse_tencent_rows_qfq_and_raw() -> None:
    data = {
        "data": {
            "sh510300": {
                "qfqday": [["2024-01-02", "1.0", "1.1", "1.2", "0.9", "1000"]],
                "day": [["2024-01-02", "2.0", "2.1", "2.2", "1.9", "1000"]],
            }
        }
    }
    rows = kline._parse_tencent_rows("sh510300", data, "qfq")
    assert rows == [{"date": "2024-01-02", "open": 1.0, "close": 1.1, "high": 1.2, "low": 0.9, "volume": 1000.0}]
    raw_rows = kline._parse_tencent_rows("sh510300", data, "bfq")
    assert raw_rows[0]["close"] == 2.1


def test_windows_desc_cover_backwards() -> None:
    windows = kline._iter_windows_desc("2020-01-01", "2024-12-31")
    assert windows[0][1] == "2024-12-31"  # 从最新往前
    assert windows[-1][0] == "2020-01-01"
    for (s1, _e1), (_s2, e2) in zip(windows, windows[1:]):
        assert s1 > e2  # 块间不重叠
    for ws, we in windows:
        assert ws <= we


def test_fetch_kline_stops_at_listing_day(monkeypatch: pytest.MonkeyPatch) -> None:
    """新标的: 最新块不足 limit 且首根晚于窗口起点 → 判定已到上市首日, 不再往前拉。"""
    calls: list[str] = []

    def fake_fetch(symbol: str, urls: tuple[str, ...], fq: str = "qfq") -> list[dict]:
        ws, we = urls[0].split("day,")[1].split(",")[:2]
        calls.append(ws)
        return [{"date": "2025-03-03", "open": 1, "close": 1, "high": 1, "low": 1, "volume": 1}]

    monkeypatch.setattr(kline, "_fetch_tencent", fake_fetch)
    rows = kline.fetch_kline("159001", start_date="2015-01-01", end_date="2026-11-13")
    assert len(calls) == 1  # 首块即停
    assert len(rows) == 1


def test_fetch_kline_range_dedup(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[str] = []

    def fake_fetch(symbol: str, urls: tuple[str, ...], fq: str = "qfq") -> list[dict]:
        url = urls[0]
        calls.append(url)
        ws = url.split("day,")[1].split(",")[0]
        we = url.split("day,")[1].split(",")[1]
        return [
            {"date": ws, "open": 1, "close": 1, "high": 1, "low": 1, "volume": 1},
            {"date": we, "open": 2, "close": 2, "high": 2, "low": 2, "volume": 2},
        ]

    monkeypatch.setattr(kline, "_fetch_tencent", fake_fetch)
    rows = kline.fetch_kline("510300", start_date="2020-01-01", end_date="2024-12-31")
    dates = [r["date"] for r in rows]
    assert len(calls) == 3  # 5 年区间按 850 自然日切 3 块
    assert len(dates) == len(set(dates))  # 跨块重叠日期被去重
    assert dates == sorted(dates)


def test_blocked_streak_raises(monkeypatch: pytest.MonkeyPatch) -> None:
    """连续失败达阈值即中止本轮, 避免限流期间把上千只标的空跑一遍。"""

    def always_fail(symbol: str, urls: tuple[str, ...], fq: str = "qfq") -> list[dict]:
        kline._streak += 1
        we = urls[0].split("day,")[1].split(",")[1]
        return [{"date": we, "open": 1, "close": 1, "high": 1, "low": 1, "volume": 1}] * kline.RANGE_CHUNK_LIMIT

    monkeypatch.setattr(kline, "_fetch_tencent", always_fail)
    monkeypatch.setattr(kline, "_streak", kline.MAX_CONSECUTIVE_FAIL - 1)
    with pytest.raises(kline.KlineBlocked):
        kline.fetch_kline("510300", start_date="2020-01-01", end_date="2022-12-31")
    monkeypatch.setattr(kline, "_streak", 0)
