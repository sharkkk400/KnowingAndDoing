"""/api/etfs/{code}/kline 的窗口参数: end 截断 + 历史窗口不追加实时bar。"""

from __future__ import annotations

import pytest

from pages.etf import router as etf_router

_ROWS = [
    {"date": "2024-01-02", "open": 1.0, "close": 1.1, "high": 1.2, "low": 0.9, "volume": 100.0},
    {"date": "2024-01-03", "open": 1.1, "close": 1.2, "high": 1.3, "low": 1.0, "volume": 110.0},
    {"date": "2024-01-04", "open": 1.2, "close": 1.3, "high": 1.4, "low": 1.1, "volume": 120.0},
]


def test_kline_end_truncates_window(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(etf_router, "_all_bars", lambda code: [dict(r) for r in _ROWS])
    out = etf_router.etf_kline("510300", period="day", limit=2, live=False, end="2024-01-03")
    assert [b["date"] for b in out["bars"]] == ["2024-01-02", "2024-01-03"]


def test_kline_end_skips_live_bar(monkeypatch: pytest.MonkeyPatch) -> None:
    """历史窗口不能追加当日实时bar, 否则走势图会把今天拼到过去。"""

    def boom(code: str, rows: list[dict]) -> list[dict]:
        raise AssertionError("历史窗口不应调用实时行情")

    monkeypatch.setattr(etf_router, "_all_bars", lambda code: [dict(r) for r in _ROWS])
    monkeypatch.setattr(etf_router, "_with_live_bar", boom)
    out = etf_router.etf_kline("510300", period="day", limit=10, live=True, end="2024-01-03")
    assert out["bars"][-1]["date"] == "2024-01-03"
