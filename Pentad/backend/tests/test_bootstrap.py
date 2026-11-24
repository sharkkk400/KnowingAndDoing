"""一键数据准备: 阶段顺序、失败中断与空库刷新链守卫。"""

from __future__ import annotations

import threading
import time
from collections.abc import Callable

import pytest

from data.store import daily_repo
from data.store.database import get_conn
from ops import bootstrap, refresh_chain


def _noop(stage: str | None, detail: str | None = None) -> None:
    return None


def _progress(done: int, total: int, msg: str) -> None:
    return None


def _seed_days(days: list[str], bars: list[str]) -> None:
    """写交易日历与有行情的日子(节点网格按日历每 5 天一个)。"""
    conn = get_conn()
    conn.executemany("INSERT INTO trade_calendar (date) VALUES (?)", [(d,) for d in days])
    conn.executemany(
        "INSERT INTO etf_daily (date, code, close) VALUES (?, '510300', 1.0)",
        [(d,) for d in bars],
    )
    conn.commit()


def _wait(timeout: float = 5.0) -> dict:
    deadline = time.time() + timeout
    while time.time() < deadline:
        state = bootstrap.status()
        if state["state"] != "running":
            return state
        time.sleep(0.01)
    raise AssertionError("一键准备未在超时内结束")


def _stub(monkeypatch: pytest.MonkeyPatch, calls: list[str], gate: threading.Event | None = None) -> None:
    def make(key: str) -> Callable[[object], str]:
        def run(_: object) -> str:
            if gate is not None:
                gate.wait(2)
            calls.append(key)
            return f"{key} 完成"

        return run

    monkeypatch.setattr(bootstrap, "STAGE_FNS", {key: make(key) for key in bootstrap.STAGE_LABELS})


def test_bootstrap_runs_stages_in_order(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[str] = []
    _stub(monkeypatch, calls)
    bootstrap.start()
    state = _wait()
    assert state["state"] == "done"
    assert calls == list(bootstrap.STAGE_LABELS)
    assert state["percent"] == 100
    assert all(s["state"] == "done" for s in state["stages"])
    assert state["stages"][-1]["detail"] == "records 完成"


def test_bootstrap_stops_at_failed_stage(monkeypatch: pytest.MonkeyPatch) -> None:
    def boom(_: object) -> str:
        raise RuntimeError("腾讯接口超时")

    stub = {key: boom if key == "daily" else (lambda _: "ok") for key in bootstrap.STAGE_LABELS}
    monkeypatch.setattr(bootstrap, "STAGE_FNS", stub)
    bootstrap.start()
    state = _wait()
    assert state["state"] == "failed"
    assert state["error"] == "腾讯接口超时"
    stages = {s["key"]: s for s in state["stages"]}
    assert stages["etf_list"]["state"] == "done"
    assert stages["daily"]["state"] == "failed"
    assert stages["records"]["state"] == "pending"


def test_bootstrap_keeps_running_instance(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[str] = []
    gate = threading.Event()
    _stub(monkeypatch, calls, gate)
    first = bootstrap.start()
    second = bootstrap.start()  # 第一趟还在跑, 第二次只返回状态
    gate.set()
    assert first["state"] == second["state"] == "running"
    _wait()
    assert calls == list(bootstrap.STAGE_LABELS)


def test_refresh_chain_skips_empty_universe(monkeypatch: pytest.MonkeyPatch) -> None:
    daily_repo.upsert_rows("510300", [{"date": "2026-11-18", "close": 1.0}])

    def fake_calendar() -> dict:
        return {"days": 1}

    def fake_days(conn: object) -> list[str]:
        return ["2026-11-18"]

    monkeypatch.setattr(refresh_chain.raw_jobs, "refresh_calendar", fake_calendar)
    monkeypatch.setattr(refresh_chain.features, "trading_days", fake_days)
    result = refresh_chain.shares_chain(_noop)
    assert "ETF 清单为空" in result["skipped"]


def _store_node(signal: str) -> None:
    conn = get_conn()
    conn.execute("INSERT INTO fitted_core_summary (signal_date) VALUES (?)", (signal,))
    conn.commit()


def test_core_stage_skips_when_snapshot_holds_last_node() -> None:
    days = [f"2015-01-{d:02d}" for d in (5, 6, 7, 8, 9, 12, 13)]
    _seed_days(days, days[:6])  # 最后行情 2015-01-12, 恰好是第二个网格节点
    _store_node("2015-01-12")
    assert bootstrap._core(_progress) == "换仓节点已最新"


def test_core_stage_resumes_after_stored_node(monkeypatch: pytest.MonkeyPatch) -> None:
    days = [f"2015-01-{d:02d}" for d in range(5, 17)]
    _seed_days(days, days)
    _store_node("2015-01-10")
    calls: dict[str, str | None] = {}

    def fake_rebuild(conn: object, start: str | None = None, end: str | None = None, **_: object) -> dict:
        calls.update(start=start, end=end)
        return {"written": 1, "start": start, "end": end}

    monkeypatch.setattr(bootstrap.core_backfill, "rebuild", fake_rebuild)
    detail = bootstrap._core(_progress)
    assert calls == {"start": "2015-01-11", "end": "2015-01-16"}
    assert detail == "1 个换仓节点(2015-01-11 ~ 2015-01-16)"


def test_records_stage_starts_before_first_gap(monkeypatch: pytest.MonkeyPatch) -> None:
    days = [f"2015-01-{d:02d}" for d in range(5, 10)]
    _seed_days(days, days)
    conn = get_conn()
    conn.executemany(
        "INSERT INTO fitted_daily_summary (signal_date) VALUES (?)",
        [(d,) for d in days[:4]],
    )
    conn.commit()
    calls: dict[str, str | None] = {}

    def fake_rebuild(conn: object, start_date: str | None = None, end_date: str | None = None, **_: object) -> dict:
        calls.update(start=start_date, end=end_date)
        return {"days": 2}

    monkeypatch.setattr(bootstrap.build, "rebuild", fake_rebuild)
    detail = bootstrap._records(_progress)
    assert calls == {"start": "2015-01-08", "end": "2015-01-09"}
    assert detail == "2 个交易日(2015-01-08 ~ 2015-01-09)"
