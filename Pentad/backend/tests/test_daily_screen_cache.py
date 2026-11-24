"""筛选快照缓存: 命中不重算, 日度记录换 generated_at 后重算。"""

from __future__ import annotations

import sqlite3

import pytest

from pages.daily.screen import cache, rank

SIGNAL = "2024-03-01"


def _day(conn: sqlite3.Connection, generated_at: str) -> None:
    with conn:
        conn.execute(
            "INSERT OR REPLACE INTO fitted_daily_summary (signal_date, generated_at) VALUES (?, ?)",
            (SIGNAL, generated_at),
        )


def _fake_screen() -> dict[str, object]:
    return {
        "payload_version": rank.PAYLOAD_VERSION,
        "signal_date": SIGNAL,
        "available": True,
        "min_aum_yi": 2.0,
        "funnel": [],
        "rows": [],
    }


def test_snapshot_hit_skips_rebuild(monkeypatch: pytest.MonkeyPatch) -> None:
    from data.store.database import get_conn

    conn = get_conn()
    _day(conn, "2024-03-01 00:00:00")
    calls = {"n": 0}

    def fake_build(conn_: sqlite3.Connection, signal: str, min_aum: float | None = None) -> dict[str, object]:
        calls["n"] += 1
        return _fake_screen()

    monkeypatch.setattr(cache.rank, "build", fake_build)

    first = cache.build_cached(conn, SIGNAL)
    second = cache.build_cached(conn, SIGNAL)

    assert calls["n"] == 1
    assert first == second

    _day(conn, "2024-03-02 00:00:00")
    cache.build_cached(conn, SIGNAL)
    assert calls["n"] == 2


def test_warm_builds_latest_signal(monkeypatch: pytest.MonkeyPatch) -> None:
    from data.store.database import get_conn

    conn = get_conn()
    _day(conn, "2024-03-01 00:00:00")
    with conn:
        conn.execute(
            "INSERT OR REPLACE INTO fitted_daily_summary (signal_date, generated_at) VALUES ('2024-03-04', 'x')"
        )
    built: list[str] = []

    def fake_build(conn_: sqlite3.Connection, signal: str, min_aum: float | None = None) -> dict[str, object]:
        built.append(signal)
        return {**_fake_screen(), "signal_date": signal}

    monkeypatch.setattr(cache.rank, "build", fake_build)

    assert cache.warm(conn) == "2024-03-04"  # 默认预热最新交易日
    assert cache.warm(conn, SIGNAL) == SIGNAL  # 也可指定日期
    assert built == ["2024-03-04", SIGNAL]


def test_warm_without_records_does_nothing() -> None:
    from data.store.database import get_conn

    assert cache.warm(get_conn()) is None
