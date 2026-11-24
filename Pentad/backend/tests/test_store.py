"""存储层写入语义：COALESCE 不覆盖、覆盖统计、交易日历。"""

from __future__ import annotations

from data.store import calendar_repo, daily_repo, etf_repo, shares_repo
from data.store.database import get_conn


def _seed_etfs() -> None:
    etf_repo.upsert_list([{"code": "510300", "name": "沪深300ETF"}, {"code": "588000", "name": "科创50ETF"}])


def test_upsert_daily_coalesce_not_null() -> None:
    _seed_etfs()
    daily_repo.upsert_rows(
        "510300", [{"date": "2024-01-02", "open": 1.0, "close": 2.0, "high": 2.5, "low": 0.9, "volume": 100.0}]
    )
    # 二次写入缺 close/high/low: 不得把已有值清成 NULL, 同值重复写入不产生新行
    daily_repo.upsert_rows("510300", [{"date": "2024-01-02", "open": 1.1, "volume": None}])
    row = get_conn().execute("SELECT * FROM etf_daily WHERE code='510300' AND date='2024-01-02'").fetchone()
    assert row["open"] == 1.1 and row["close"] == 2.0 and row["high"] == 2.5 and row["volume"] == 100.0
    assert daily_repo.coverage("510300")["rows"] == 1


def test_coverage_and_history_order() -> None:
    _seed_etfs()
    daily_repo.upsert_rows(
        "588000", [{"date": d, "close": float(i)} for i, d in enumerate(["2024-01-02", "2024-01-03"])]
    )
    cov = daily_repo.coverage("588000")
    assert (cov["first_date"], cov["last_date"], cov["rows"]) == ("2024-01-02", "2024-01-03", 2)
    assert [r["date"] for r in daily_repo.history("588000")] == ["2024-01-02", "2024-01-03"]
    assert daily_repo.latest_per_code() == {"588000": "2024-01-03"}
    assert daily_repo.empty_codes(["510300", "588000"]) == ["510300"]


def test_shares_upsert_filters_unknown_codes() -> None:
    _seed_etfs()
    written = shares_repo.upsert_day("2024-01-02", {"510300": 300.0, "999999": 1.0}, set(etf_repo.all_codes()))
    assert written == 1
    assert shares_repo.latest_per_code() == {"510300": "2024-01-02"}


def test_calendar_roundtrip() -> None:
    calendar_repo.replace_all(["2024-01-02", "2024-01-03", "2024-01-04"])
    assert calendar_repo.trading_days_between("2024-01-03", "2024-01-05") == ["2024-01-03", "2024-01-04"]
    assert calendar_repo.last_trading_day("2024-01-05") == "2024-01-04"
    assert calendar_repo.last_trading_day("2024-01-01") is None


def test_etf_list_upsert_merges() -> None:
    assert etf_repo.upsert_list([{"code": "510300", "name": "老名字"}]) == 1
    assert etf_repo.upsert_list([{"code": "510300", "name": "新名字"}, {"code": "588000", "name": "科创50"}]) == 1
    rows = {r["code"]: r["name"] for r in etf_repo.list_with_coverage()}
    assert rows == {"510300": "新名字", "588000": "科创50"}
