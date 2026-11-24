"""数据就绪度审计: 缺口、异常值、份额/指数覆盖。"""

from __future__ import annotations

from data.config import INDEX_CODES
from data.store import calendar_repo, daily_repo, etf_repo, index_repo
from data.store.database import get_conn
from pages.jobs import readiness as audit

CAL = ["2024-01-02", "2024-01-03", "2024-01-04", "2024-01-05"]


def _seed_calendar(days: list[str]) -> None:
    calendar_repo.replace_all(days)


def _seed_etfs() -> None:
    etf_repo.upsert_list([{"code": "510300", "name": "沪深300ETF"}, {"code": "588000", "name": "科创50ETF"}])


def test_list_date_backfilled_from_first_bar() -> None:
    _seed_etfs()
    daily_repo.upsert_rows("510300", [{"date": "2024-01-03", "close": 1.0}])
    assert etf_repo.backfill_list_dates() == 1
    row = get_conn().execute("SELECT list_date FROM etfs WHERE code='510300'").fetchone()
    assert row["list_date"] == "2024-01-03"
    assert etf_repo.backfill_list_dates() == 0  # 幂等


def test_audit_reports_gaps_and_anomalies() -> None:
    _seed_calendar(CAL)
    daily_repo.upsert_rows(
        "510300",
        [
            {"date": "2024-01-02", "close": 1.0, "volume": 100.0},
            {"date": "2024-01-05", "close": 2.5, "volume": 0.0},
        ],
    )
    summary = audit.dataset_summary()
    assert summary["calendar"]["days"] == 4
    assert summary["daily"]["codes"] == 1 and summary["daily"]["rows"] == 2
    assert summary["gaps"]["codes"] == 1 and summary["gaps"]["days"] == 2  # 缺 01-03、01-04
    assert summary["gaps"]["top"][0]["code"] == "510300"
    assert summary["anomalies"]["zero_volume"] == 1
    assert summary["anomalies"]["jump_gt_30pct"] == 1
    assert summary["index"]["configured"] > 0 and summary["index"]["rows"] == 0


def test_audit_lists_index_coverage_even_when_empty() -> None:
    rows = audit.index_coverage()
    assert len(rows) == len(INDEX_CODES)
    assert all(r["rows"] == 0 for r in rows)


def test_audit_counts_share_scale_fallback() -> None:
    _seed_etfs()
    _seed_calendar(CAL)
    daily_repo.upsert_rows(
        "510300",
        [
            {"date": "2024-01-02", "close": 1.0, "volume": 100.0},
            {"date": "2024-01-03", "close": 1.0, "volume": 100.0},
        ],
    )
    index_repo.upsert_rows("000300", "沪深300", [{"date": "2024-01-02", "close": 4000.0, "open": 4000.0}])
    summary = audit.dataset_summary()
    assert summary["index"]["codes"] == 1 and summary["index"]["rows"] == 1
    assert summary["share_scale"]["jumps"] == 0
