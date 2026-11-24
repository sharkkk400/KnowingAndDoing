"""core8 缓冲带: 换仓节点回填的间距、持仓动作一致性、幂等与空节点清理。"""

from __future__ import annotations

import math
import sqlite3
from bisect import bisect_left
from datetime import date, timedelta

from data.store.database import get_conn
from ops import core_backfill
from services.scoring import features
from services.scoring.core import score as core
from services.scoring.core import store as core_store

START = date(2021, 8, 2)


def _weekdays(start: date, n: int) -> list[str]:
    days: list[str] = []
    cur = start
    while len(days) < n:
        if cur.weekday() < 5:
            days.append(cur.isoformat())
        cur += timedelta(days=1)
    return days


def _seed(conn: sqlite3.Connection, days: list[str], n_etfs: int = 25) -> list[str]:
    """n_etfs 只走势分化的 ETF: 漂移拉开截面、正弦制造短期反转, 保证每日排名会变。"""
    codes = [f"51{i:04d}" for i in range(n_etfs)]
    with conn:
        conn.executemany(
            "INSERT INTO etfs (code, name, fund_type) VALUES (?, ?, ?)",
            [(code, f"测试ETF{i}", features.DOMESTIC_EQUITY) for i, code in enumerate(codes)],
        )
        conn.executemany("INSERT INTO trade_calendar (date) VALUES (?)", [(d,) for d in days])
        for i, day in enumerate(days):
            for k, code in enumerate(codes):
                drift = -0.002 + 0.00016 * k
                close = 100 * math.exp(drift * i) * (1 + 0.08 * math.sin(i / 6 + k))
                conn.execute(
                    "INSERT INTO etf_daily (date, code, close, volume) VALUES (?, ?, ?, ?)",
                    (day, code, round(close, 4), 1_000_000 + 1_000 * k),
                )
                conn.execute(
                    "INSERT INTO etf_shares (date, code, shares_yi) VALUES (?, ?, ?)",
                    (day, code, 10 + 0.02 * ((k * 7) % 5) * i / len(days)),
                )
            conn.execute(
                "INSERT INTO index_daily (date, code, close) VALUES (?, ?, ?)",
                (day, "000300", round(100 * (1 + 0.0005 * i), 4)),
            )
    return codes


def _seed_days(conn: sqlite3.Connection, n: int = 160) -> list[str]:
    days = _weekdays(START, n)
    _seed(conn, days)
    return days


def test_rebuild_writes_every_fifth_trading_day() -> None:
    conn = get_conn()
    days = _seed_days(conn)

    result = core_backfill.rebuild(conn)
    nodes = core_store.list_nodes(conn)

    assert result["written"] == len(nodes) > 0
    dates = [node["signal_date"] for node in nodes]
    position = {day: i for i, day in enumerate(days)}
    # 节点与锚点网格同相位(锚点早于数据窗时, 首个落点顺延到第一个有评分的节点)
    grid0 = bisect_left(days, core.CORE_ANCHOR)
    assert all((position[d] - grid0) % core.REBALANCE_EVERY == 0 for d in dates)
    assert all(position[b] - position[a] == core.REBALANCE_EVERY for a, b in zip(dates, dates[1:]))
    assert dates[-1] <= days[-1]
    assert nodes[0]["rule_version"] == core_backfill.RULE_VERSION
    assert nodes[0]["scored"] == 25
    # 份额已覆盖到最新行情: 每个节点都是完整排名, 且预备排名随 pick 持久化。
    assert all(node["complete"] == 1 for node in nodes)
    missing_pre = conn.execute("SELECT COUNT(*) FROM fitted_core_pick WHERE pre_rank IS NULL").fetchone()[0]
    assert missing_pre == 0


def test_picks_track_buffer_holdings_across_nodes() -> None:
    conn = get_conn()
    _seed_days(conn)
    core_backfill.rebuild(conn)
    nodes = core_store.list_nodes(conn)

    held_prev: set[str] = set()
    for index, node in enumerate(nodes):
        data = core_store.get_node(conn, node["signal_date"])
        assert data is not None
        holdings = data["holdings"]
        held = {pick["code"] for pick in holdings}
        assert len(holdings) == core.HOLD_TOP
        assert all(pick["held"] and pick["action"] in {"hold", "buy"} for pick in holdings)
        holds = {pick["code"] for pick in holdings if pick["action"] == "hold"}
        buys = {pick["code"] for pick in holdings if pick["action"] == "buy"}
        assert holds == held & held_prev
        assert buys == held - held_prev
        sells = data["sells"]
        assert all(not pick["held"] and pick["action"] == "sell" for pick in sells)
        assert {pick["code"] for pick in sells} == held_prev - held
        assert data["counts"] == {"hold": len(holds), "buy": len(buys), "sell": len(sells)}
        assert len(data["ranked"]) <= core_backfill.KEEP_TOP
        if index == 0:
            assert buys == held  # 首节点建仓
        held_prev = held


def test_buffer_keeps_ranked_holding_but_sells_dropped_one() -> None:
    conn = get_conn()
    _seed_days(conn)
    core_backfill.rebuild(conn)
    nodes = core_store.list_nodes(conn)
    data = core_store.get_node(conn, nodes[-1]["signal_date"])
    assert data is not None

    for pick in data["holdings"]:
        assert pick["core_rank"] <= core.HOLD_BUFFER_RANK
    for pick in data["sells"]:
        assert pick["core_rank"] > core.HOLD_BUFFER_RANK


def test_rebuild_is_idempotent_and_prunes_non_node_rows() -> None:
    conn = get_conn()
    _seed_days(conn)
    core_backfill.rebuild(conn)
    summary_before = conn.execute("SELECT COUNT(*) FROM fitted_core_summary").fetchone()[0]
    picks_before = conn.execute("SELECT COUNT(*) FROM fitted_core_pick").fetchone()[0]

    core_store.replace_node(
        conn,
        {
            "signal_date": "2022-01-05",  # 交易日, 但不是 5 日换仓节点
            "next_rebalance": None,
            "generated_at": None,
            "rule_version": "bogus",
            "scored": 0,
            "min_aum_yi": 0,
        },
        [],
    )
    core_backfill.rebuild(conn)

    assert conn.execute("SELECT COUNT(*) FROM fitted_core_summary").fetchone()[0] == summary_before
    assert conn.execute("SELECT COUNT(*) FROM fitted_core_pick").fetchone()[0] == picks_before
    assert core_store.node_at(conn, "2022-01-05") != "2022-01-05"


def test_nodes_without_bars_are_skipped_and_stale_rows_pruned() -> None:
    conn = get_conn()
    days = _seed_days(conn)
    future = _weekdays(date(2022, 3, 14), 10)  # 行情结束后仍在日历里, 模拟日历尾部
    with conn:
        conn.executemany("INSERT INTO trade_calendar (date) VALUES (?)", [(d,) for d in future])
    core_store.replace_node(
        conn,
        {
            "signal_date": future[4],
            "next_rebalance": None,
            "generated_at": None,
            "rule_version": "bogus",
            "scored": 0,
            "min_aum_yi": 0,
        },
        [],
    )

    result = core_backfill.rebuild(conn)
    dates = [node["signal_date"] for node in core_store.list_nodes(conn)]

    assert future[4] not in dates
    assert dates[-1] <= days[-1]
    assert result["written"] == len(dates)


def test_node_at_returns_previous_node_inside_holding_period() -> None:
    conn = get_conn()
    days = _seed_days(conn)
    core_backfill.rebuild(conn)
    nodes = core_store.list_nodes(conn)
    node = nodes[2]["signal_date"]
    idx = days.index(node)

    assert core_store.node_at(conn, "2000-01-01") is None  # 任何节点之前无持仓
    assert core_store.node_at(conn, node) == node
    assert core_store.node_at(conn, days[idx + core.REBALANCE_EVERY - 1]) == node


def test_rebuild_node_heals_preliminary_node_after_shares_land() -> None:
    """节点日收盘只有 T-1 份额 → 先落预备目标; 份额落地后单节点补算成完整目标。"""
    conn = get_conn()
    _seed_days(conn)
    core_backfill.rebuild(conn)
    node = core_store.list_nodes(conn)[-1]["signal_date"]
    detail = core_store.get_node(conn, node)
    assert detail is not None
    original = {p["code"] for p in detail["holdings"]}
    assert core_store.node_complete(conn, node) is True

    saved = [
        tuple(row)
        for row in conn.execute("SELECT date, code, shares_yi FROM etf_shares WHERE date = ?", (node,)).fetchall()
    ]
    with conn:
        conn.execute("DELETE FROM etf_shares WHERE date = ?", (node,))
    result = core_backfill.rebuild_node(conn, node)

    assert result["written"] is True
    assert core_store.node_complete(conn, node) is False  # 份额只到 T-1, 仍是预备目标

    with conn:
        conn.executemany("INSERT INTO etf_shares (date, code, shares_yi) VALUES (?, ?, ?)", saved)
    core_backfill.rebuild_node(conn, node)

    assert core_store.node_complete(conn, node) is True
    healed = core_store.get_node(conn, node)
    assert healed is not None
    assert {p["code"] for p in healed["holdings"]} == original


def test_rebuild_node_only_touches_target_node() -> None:
    conn = get_conn()
    _seed_days(conn)
    core_backfill.rebuild(conn)
    nodes = [n["signal_date"] for n in core_store.list_nodes(conn)]
    target = nodes[-1]

    def counts(day: str) -> dict[str, int]:
        detail = core_store.get_node(conn, day)
        assert detail is not None
        return dict(detail["counts"])

    before = {d: counts(d) for d in nodes[:-1]}

    core_backfill.rebuild_node(conn, target)

    assert [n["signal_date"] for n in core_store.list_nodes(conn)] == nodes
    assert {d: counts(d) for d in nodes[:-1]} == before


def test_picks_sell_and_top20_sections() -> None:
    scored = [
        {"code": f"S{i:02d}", "name": f"S{i:02d}", "core_rank": i, "core_score": 1.0 - i * 0.01} for i in range(1, 26)
    ]
    picks = core_backfill._picks(scored, ["S01", "S15"], ["S01", "S20"])
    actions = {(pick["code"], pick["action"]) for pick in picks}

    assert ("S01", "hold") in actions
    assert ("S15", "buy") in actions
    assert ("S20", "sell") in actions
    rank_codes = {code for code, action in actions if action == "rank"}
    assert rank_codes == {f"S{i:02d}" for i in range(2, 21)} - {"S15", "S20"}

    rebought = core_backfill._picks(scored, ["S01", "S20"], ["S01", "S20"], {"S01": 1, "S20": 18}, {"S20"})
    actions_by_code = {(pick["code"], pick["action"], pick["pre_rank"]) for pick in rebought}
    # 周四收盘先卖、周五开盘买回: 持仓看着连续, 动作必须是 buy 并且留着预备排名。
    assert ("S20", "buy", 18) in actions_by_code
    assert ("S01", "hold", 1) in actions_by_code
