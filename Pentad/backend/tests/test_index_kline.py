"""中证指数日线解析、假首行剔除、增量回填与写入语义(不触网)。"""

from __future__ import annotations

import pytest

from data.fetch import index_kline
from data.store import index_repo
from data.store.database import get_conn
from ops import jobs


def _row(date: str, close: float, name: str = "沪深300") -> dict:
    return {
        "tradeDate": date,
        "indexNameCn": name,
        "open": close,
        "high": close,
        "low": close,
        "close": close,
        "tradingVol": 1000.0,
        "tradingValue": 2701.06,
        "consNumber": 300.0,
        "peg": 13.55,
    }


def test_parse_drops_synthetic_first_row() -> None:
    """接口把首行日期改写成请求起点并复制首个交易日数值, 必须剔除。"""
    payload = {"data": [_row("20200101", 4152.24), _row("20200102", 4152.24), _row("20200103", 4144.96)]}
    name, rows = index_kline._parse_rows(payload, "2020-01-01")
    assert name == "沪深300"
    assert [r["date"] for r in rows] == ["2020-01-02", "2020-01-03"]
    assert rows[0]["amount_yi"] == 2701.06 and rows[0]["pe"] == 13.55 and rows[0]["cons_number"] == 300.0


def test_parse_keeps_real_first_trading_day() -> None:
    """请求起点本身就是交易日且数值不同 → 首行是真实数据, 不能丢。"""
    payload = {"data": [_row("20200102", 4152.24), _row("20200103", 4144.96)]}
    _, rows = index_kline._parse_rows(payload, "2020-01-02")
    assert [r["date"] for r in rows] == ["2020-01-02", "2020-01-03"]


def test_parse_skips_missing_close_and_nulls() -> None:
    payload = {
        "data": [
            {"tradeDate": "20200102", "indexNameCn": "科创50", "close": None},
            {"tradeDate": "20200103", "indexNameCn": "科创50", "open": 1.0, "close": 1.1, "high": None, "peg": None},
        ]
    }
    _, rows = index_kline._parse_rows(payload, "2020-01-01")
    assert len(rows) == 1
    assert rows[0]["date"] == "2020-01-03" and rows[0]["high"] is None and rows[0]["pe"] is None


def test_fetch_failure_returns_empty(monkeypatch: pytest.MonkeyPatch) -> None:
    def boom(*_a: object, **_k: object) -> None:
        raise OSError("network down")

    monkeypatch.setattr(index_kline.urllib.request, "urlopen", boom)
    assert index_kline.fetch_index_daily("000300") == (None, [])


def test_repo_upsert_coalesce_and_name() -> None:
    index_repo.upsert_rows("000300", "沪深300", [{"date": "2024-01-02", "open": 1.0, "close": 2.0, "pe": 12.0}])
    index_repo.upsert_rows("000300", None, [{"date": "2024-01-02", "close": 2.5, "pe": None}])
    row = get_conn().execute("SELECT * FROM index_daily WHERE code='000300'").fetchone()
    assert row["open"] == 1.0 and row["close"] == 2.5 and row["pe"] == 12.0
    name = get_conn().execute("SELECT name FROM indices WHERE code='000300'").fetchone()["name"]
    assert name == "沪深300"


def test_backfill_index_is_incremental(monkeypatch: pytest.MonkeyPatch) -> None:
    index_repo.upsert_rows("000300", "沪深300", [{"date": "2024-01-02", "close": 1.0}])
    calls: list[tuple[str, str]] = []

    def fake_fetch(code: str, start_date: str, end_date: str | None = None) -> tuple[str | None, list[dict]]:
        calls.append((code, start_date))
        return None, []

    monkeypatch.setattr(jobs, "INDEX_CODES", ("000300", "000905"))
    monkeypatch.setattr(jobs, "INDEX_FETCH_SLEEP_SEC", 0)
    monkeypatch.setattr(jobs.index_fetch, "fetch_index_daily", fake_fetch)
    result = jobs.backfill_index()
    assert calls == [("000300", "2024-01-03"), ("000905", jobs.CSINDEX_START_DATE)]
    assert result == {"indices": 2, "rows": 0}
