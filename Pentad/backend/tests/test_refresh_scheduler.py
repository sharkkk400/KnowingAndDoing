"""收盘自动刷新链的调度判定: 槽位是否到期、日度记录从哪天开始重算。"""

from __future__ import annotations

import sqlite3
from datetime import datetime

import pytest

from data.store import calendar_repo
from data.store.database import get_conn
from ops import refresh_chain, scheduler
from services.scoring.core import store as core_store

NODE_DAYS = ["2015-01-05", "2015-01-06", "2015-01-07", "2015-01-08", "2015-01-09", "2015-01-12"]


def _seed_node(conn: sqlite3.Connection, node: str = NODE_DAYS[-1], complete: int = 0) -> None:
    calendar_repo.replace_all(NODE_DAYS)
    core_store.replace_node(
        conn,
        {
            "signal_date": node,
            "next_rebalance": None,
            "generated_at": "x",
            "rule_version": "core8-v1",
            "scored": 0,
            "min_aum_yi": 2.0,
            "complete": bool(complete),
        },
        [],
    )


def _seed_shares(conn: sqlite3.Connection, day: str) -> None:
    with conn:
        conn.execute("INSERT INTO etf_shares (date, code, shares_yi) VALUES (?, '510300', 10)", (day,))


@pytest.fixture(autouse=True)
def _reset_slots() -> None:
    scheduler._DONE.clear()  # noqa: SLF001 - 测试直接复位模块状态
    scheduler._ATTEMPTS.clear()  # noqa: SLF001
    scheduler._COOLDOWN_UNTIL.clear()  # noqa: SLF001


def _at(hour: int, minute: int) -> datetime:
    return datetime(2026, 11, 18, hour, minute)  # noqa: DTZ001 - 与应用内 naive 本地时间一致


def test_due_slot_shares_before_dawn() -> None:
    assert scheduler._due_slot(_at(0, 19)) is None
    assert scheduler._due_slot(_at(0, 20)) == "shares"
    scheduler._DONE["shares"] = "2026-11-18"
    assert scheduler._due_slot(_at(0, 25)) is None


def test_due_slot_close_then_late() -> None:
    scheduler._DONE["shares"] = "2026-11-18"
    assert scheduler._due_slot(_at(18, 29)) is None
    assert scheduler._due_slot(_at(19, 0)) == "close"
    scheduler._DONE["close"] = "2026-11-18"
    assert scheduler._due_slot(_at(19, 0)) is None
    assert scheduler._due_slot(_at(22, 30)) == "late"
    scheduler._DONE["late"] = "2026-11-18"
    assert scheduler._due_slot(_at(23, 0)) is None


def test_records_start_prefers_gap_before_first_missing() -> None:
    conn = get_conn()
    days = ["2025-01-02", "2025-01-03", "2025-01-06", "2025-01-07", "2025-01-08"]
    calendar_repo.replace_all(days)
    with conn:
        conn.executemany(
            "INSERT INTO fitted_daily_summary (signal_date, generated_at) VALUES (?, ?)",
            [(d, "x") for d in days[:-2]],
        )
    assert refresh_chain.records_start(conn, days, days[-1]) == days[-3]


def test_records_start_recomputes_tail_when_complete() -> None:
    conn = get_conn()
    days = ["2025-01-02", "2025-01-03", "2025-01-06", "2025-01-07", "2025-01-08"]
    calendar_repo.replace_all(days)
    with conn:
        conn.executemany(
            "INSERT INTO fitted_daily_summary (signal_date, generated_at) VALUES (?, ?)",
            [(d, "x") for d in days],
        )
    assert refresh_chain.records_start(conn, days, days[-1]) == days[-2]


def test_records_start_heals_days_missing_index_returns() -> None:
    conn = get_conn()
    days = ["2025-01-02", "2025-01-03", "2025-01-06", "2025-01-07", "2025-01-08"]
    calendar_repo.replace_all(days)
    with conn:
        conn.executemany(
            "INSERT INTO fitted_daily_summary (signal_date, next_signal, generated_at, index_returns_json)"
            " VALUES (?, ?, ?, ?)",
            [(d, days[i + 1] if i + 1 < len(days) else None, "x", "{}") for i, d in enumerate(days)],
        )
        conn.executemany(
            "INSERT INTO index_daily (code, date, close) VALUES ('000300', ?, 1.0)",
            [(d,) for d in days],
        )
    # 指数已落库但结算行是空指数收益 → 从最早那天重算(不只最近两天)
    assert refresh_chain.records_start(conn, days, days[-1]) == days[0]


def test_records_start_ignores_days_before_default() -> None:
    conn = get_conn()
    days = ["2014-12-30", "2014-12-31"]
    assert refresh_chain.records_start(conn, days, days[-1]) is None


def test_final_node_needs_rebuild_only_after_final_time(monkeypatch: pytest.MonkeyPatch) -> None:
    """当天本身是换仓节点: 16:15 之后要用收盘终值重算, 之前是盘中快照不动。"""
    conn = get_conn()
    node = NODE_DAYS[-1]
    _seed_node(conn, node)

    monkeypatch.setattr(refresh_chain.raw_jobs, "final_bar_ready", lambda now=None: False)
    assert not refresh_chain._final_node_needs_rebuild(conn, NODE_DAYS, node)  # noqa: SLF001

    monkeypatch.setattr(refresh_chain.raw_jobs, "final_bar_ready", lambda now=None: True)
    assert refresh_chain._final_node_needs_rebuild(conn, NODE_DAYS, node)  # noqa: SLF001
    # 当天不是换仓节点: 节点在上一个换仓日, 与今天的K线无关
    assert not refresh_chain._final_node_needs_rebuild(conn, NODE_DAYS, NODE_DAYS[-2])  # noqa: SLF001


def test_node_to_complete_waits_for_node_day_shares() -> None:
    conn = get_conn()
    node = NODE_DAYS[-1]
    _seed_node(conn, node)
    _seed_shares(conn, NODE_DAYS[-2])

    # 节点日份额还没落地 → 预备目标先撑着, 不重算。
    assert refresh_chain.node_to_complete(conn, NODE_DAYS, node) is None

    _seed_shares(conn, node)

    assert refresh_chain.node_to_complete(conn, NODE_DAYS, node) == node


def test_node_to_complete_skips_complete_node() -> None:
    conn = get_conn()
    node = NODE_DAYS[-1]
    _seed_node(conn, node, complete=1)
    _seed_shares(conn, node)

    assert refresh_chain.node_to_complete(conn, NODE_DAYS, node) is None


def test_node_to_complete_ignores_non_latest_node() -> None:
    conn = get_conn()
    _seed_node(conn, NODE_DAYS[0])  # 库里只有更早的节点, 最新节点还没建
    _seed_shares(conn, NODE_DAYS[-1])

    assert refresh_chain.node_to_complete(conn, NODE_DAYS, NODE_DAYS[-1]) is None


def test_warm_screen_reports_and_swallows_failure(monkeypatch: pytest.MonkeyPatch) -> None:
    events: list[tuple[str | None, str | None]] = []

    def boom(conn: sqlite3.Connection, signal: str | None = None) -> None:
        raise RuntimeError("冷算失败")

    monkeypatch.setattr(refresh_chain.cache, "warm", boom)
    refresh_chain._warm_screen(get_conn(), NODE_DAYS[-1], lambda s, d: events.append((s, d)))  # noqa: SLF001

    assert events[0] == ("screen", f"预热 {NODE_DAYS[-1]} 筛选快照")
    assert "预热失败" in (events[-1][1] or "")


def test_tick_yields_to_running_bootstrap(monkeypatch: pytest.MonkeyPatch) -> None:
    """一键准备运行期间自动链让路; 结束后同一槽位仍会补跑。"""
    from ops import bootstrap

    scheduler._DONE["shares"] = "2026-11-18"  # noqa: SLF001
    calls: list[str] = []

    def fake_chain(slot: str) -> dict:
        calls.append(slot)
        return {}

    monkeypatch.setattr(scheduler, "run_chain", fake_chain)
    monkeypatch.setattr(bootstrap, "status", lambda: {"state": "running"})

    scheduler._tick(_at(19, 0))

    assert calls == []

    monkeypatch.setattr(bootstrap, "status", lambda: {"state": "idle"})
    scheduler._tick(_at(19, 0))

    assert calls == ["close"]
