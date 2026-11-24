"""回填任务编排的幂等与增量逻辑(拉取函数全部 mock, 不触网)。"""

from __future__ import annotations

from datetime import date, datetime, timedelta

import pytest

from data.fetch import kline as kline_fetch
from data.store import calendar_repo, daily_repo, etf_repo
from ops import jobs


def business_days(start: str, n: int) -> list[str]:
    """从 start 起连续 n 个工作日(仅用于构造库内历史, 不追求节假日精确)。"""
    d = date.fromisoformat(start)
    out: list[str] = []
    while len(out) < n:
        if d.weekday() < 5:
            out.append(d.isoformat())
        d += timedelta(days=1)
    return out


def test_backfill_daily_incremental(monkeypatch: pytest.MonkeyPatch) -> None:
    etf_repo.upsert_list([{"code": "510300", "name": "沪深300ETF"}])
    calls: list[tuple[str, str | None]] = []

    def fake_kline(
        code: str, limit: int = 60, start_date: str | None = None, end_date: str | None = None, fq: str = "qfq"
    ) -> list[dict]:
        calls.append((code, start_date))
        return [{"date": "2024-01-02", "open": 1, "close": 1, "high": 1, "low": 1, "volume": 1}]

    monkeypatch.setattr(kline_fetch, "fetch_kline", fake_kline)
    result = jobs.backfill_daily()
    assert result["rows"] == 1
    assert calls[0][1] == jobs.KLINE_START_DATE  # 无历史 → 从 2004 全量拉(反向取到上市日即停)
    # 已有历史 → 只按最新日次日增量; 行数少不再当作截断
    jobs.backfill_daily()
    assert calls[1][1] == "2024-01-03"
    assert daily_repo.coverage("510300")["rows"] == 1


def test_backfill_daily_advances_after_full_history(monkeypatch: pytest.MonkeyPatch) -> None:
    etf_repo.upsert_list([{"code": "510300", "name": "沪深300ETF"}])
    days = [f"{y}-{m:02d}-{d:02d}" for y in (2022, 2023, 2024) for m in range(1, 13) for d in range(1, 29)]
    daily_repo.upsert_rows("510300", [{"date": d, "close": 1.0} for d in days])
    calls: list[str | None] = []

    def fake_kline(
        code: str, limit: int = 60, start_date: str | None = None, end_date: str | None = None, fq: str = "qfq"
    ) -> list[dict]:
        calls.append(start_date)
        return []

    monkeypatch.setattr(kline_fetch, "fetch_kline", fake_kline)
    jobs.backfill_daily()
    assert calls[0] == "2024-12-29"  # 已足够长 → 只从最新日次日增量


def test_backfill_daily_extends_truncated_history(monkeypatch: pytest.MonkeyPatch) -> None:
    etf_repo.upsert_list([{"code": "510050", "name": "上证50ETF"}])
    days = business_days("2015-01-05", 700)  # 起点正好停在旧回填下限 → 判定为被截断
    daily_repo.upsert_rows("510050", [{"date": d, "close": 1.0} for d in days])
    calls: list[str | None] = []

    def fake_kline(
        code: str, limit: int = 60, start_date: str | None = None, end_date: str | None = None, fq: str = "qfq"
    ) -> list[dict]:
        calls.append(start_date)
        return []

    monkeypatch.setattr(kline_fetch, "fetch_kline", fake_kline)
    jobs.backfill_daily()
    assert calls[0] == jobs.KLINE_START_DATE  # 从 2004 重拉, 向前补深


def test_backfill_daily_keeps_short_fresh_history_incremental(monkeypatch: pytest.MonkeyPatch) -> None:
    etf_repo.upsert_list([{"code": "159123", "name": "次新ETF"}])
    days = business_days("2025-12-01", 237)  # 上市晚、历史短但完整(预热快照里的典型次新标的)
    calendar_repo.replace_all(days)
    daily_repo.upsert_rows("159123", [{"date": d, "close": 1.0} for d in days])
    calls: list[str | None] = []

    def fake_kline(
        code: str, limit: int = 60, start_date: str | None = None, end_date: str | None = None, fq: str = "qfq"
    ) -> list[dict]:
        calls.append(start_date)
        return []

    monkeypatch.setattr(kline_fetch, "fetch_kline", fake_kline)
    jobs.backfill_daily()
    assert calls[0] == (date.fromisoformat(days[-1]) + timedelta(days=1)).isoformat()


def test_backfill_daily_repairs_interrupted_history(monkeypatch: pytest.MonkeyPatch) -> None:
    etf_repo.upsert_list([{"code": "512100", "name": "中证1000ETF"}])
    days = business_days("2024-01-01", 260)
    calendar_repo.replace_all(days)
    daily_repo.upsert_rows("512100", [{"date": d, "close": 1.0} for d in days[::5]])  # 历史拉取中途中断
    calls: list[str | None] = []

    def fake_kline(
        code: str, limit: int = 60, start_date: str | None = None, end_date: str | None = None, fq: str = "qfq"
    ) -> list[dict]:
        calls.append(start_date)
        return []

    monkeypatch.setattr(kline_fetch, "fetch_kline", fake_kline)
    jobs.backfill_daily()
    assert calls[0] == jobs.KLINE_START_DATE  # 区间内缺根过多 → 全量重拉修复


def test_backfill_daily_sends_old_listing_incremental(monkeypatch: pytest.MonkeyPatch) -> None:
    etf_repo.upsert_list([{"code": "159901", "name": "深证100ETF"}])
    days = business_days("2010-01-04", 700)  # 2015 前上市且起点不是旧下限 → 正常增量
    daily_repo.upsert_rows("159901", [{"date": d, "close": 1.0} for d in days])
    calls: list[str | None] = []

    def fake_kline(
        code: str, limit: int = 60, start_date: str | None = None, end_date: str | None = None, fq: str = "qfq"
    ) -> list[dict]:
        calls.append(start_date)
        return []

    monkeypatch.setattr(kline_fetch, "fetch_kline", fake_kline)
    jobs.backfill_daily()
    assert calls[0] == (date.fromisoformat(days[-1]) + timedelta(days=1)).isoformat()


def test_final_bar_ready_boundary() -> None:
    assert not jobs.final_bar_ready(datetime(2026, 11, 19, 16, 14))  # noqa: DTZ001 - 与应用内 naive 本地时间一致
    assert jobs.final_bar_ready(datetime(2026, 11, 19, 16, 15))  # noqa: DTZ001


def test_backfill_daily_refreshes_today_after_final_time(monkeypatch: pytest.MonkeyPatch) -> None:
    """当天K线已入库也要重拉: 盘中快照必须被收盘终值覆盖(最后一次落库在16:15之后)。"""
    etf_repo.upsert_list([{"code": "510300", "name": "沪深300ETF"}])
    today = jobs._today()
    daily_repo.upsert_rows("510300", [{"date": today, "close": 1.0}])
    calls: list[tuple[str | None, str | None]] = []

    def fake_kline(
        code: str, limit: int = 60, start_date: str | None = None, end_date: str | None = None, fq: str = "qfq"
    ) -> list[dict]:
        calls.append((start_date, end_date))
        return [{"date": today, "open": 1, "close": 1.2, "high": 1.2, "low": 1, "volume": 10}]

    monkeypatch.setattr(kline_fetch, "fetch_kline", fake_kline)
    monkeypatch.setattr(jobs, "final_bar_ready", lambda now=None: True)
    jobs.backfill_daily()
    assert calls == [(today, today)]
    assert daily_repo.history("510300")[-1]["close"] == 1.2


def test_backfill_daily_skips_today_before_final_time(monkeypatch: pytest.MonkeyPatch) -> None:
    etf_repo.upsert_list([{"code": "510300", "name": "沪深300ETF"}])
    today = jobs._today()
    daily_repo.upsert_rows("510300", [{"date": today, "close": 1.0}])
    calls: list[str | None] = []

    def fake_kline(
        code: str, limit: int = 60, start_date: str | None = None, end_date: str | None = None, fq: str = "qfq"
    ) -> list[dict]:
        calls.append(start_date)
        return []

    monkeypatch.setattr(kline_fetch, "fetch_kline", fake_kline)
    monkeypatch.setattr(jobs, "final_bar_ready", lambda now=None: False)
    jobs.backfill_daily()
    assert calls == []
    assert daily_repo.history("510300")[-1]["close"] == 1.0


def test_backfill_shares_reruns_recent_days(monkeypatch: pytest.MonkeyPatch) -> None:
    days = business_days("2025-01-02", 5)
    calendar_repo.replace_all(days)
    pulled: list[str] = []

    def fake_shares(day: str) -> dict:
        pulled.append(day)
        return {}

    monkeypatch.setattr(jobs.shares_repo, "existing_dates", lambda: set(days[:-1]))
    monkeypatch.setattr(jobs.shares_repo, "upsert_day", lambda d, got, known: 0)
    monkeypatch.setattr(jobs.shares_fetch, "fetch_shares_for_date", fake_shares)
    jobs.backfill_shares(recent_days=2, end_date=days[-1])
    # 缺失的最后一天 + 强制重拉的最近两天, 去重后按日期序执行
    assert pulled == [days[-2], days[-1]]


def test_refresh_etf_list_empty_keeps_state(monkeypatch: pytest.MonkeyPatch) -> None:
    etf_repo.upsert_list([{"code": "510300", "name": "沪深300ETF"}])
    monkeypatch.setattr(jobs.list_fetch, "fetch_etf_list", lambda: [])
    result = jobs.refresh_etf_list()
    assert result["added"] == 0 and "error" in result
    assert etf_repo.all_codes() == ["510300"]


def test_history_repo_used_by_api() -> None:
    etf_repo.upsert_list([{"code": "588000", "name": "科创50ETF"}])
    daily_repo.upsert_rows("588000", [{"date": "2024-01-02", "close": 1.0}])
    assert daily_repo.history("588000")[0]["close"] == 1.0
