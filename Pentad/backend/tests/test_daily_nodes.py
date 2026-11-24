"""换仓节点列表/明细/持仓时间线: 混合执行价、节点收益与持有区间。"""

from __future__ import annotations

import sqlite3

import pytest

from pages.daily import nodes
from services.scoring.core import store as core_store

DAYS = ["2024-01-02", "2024-01-09", "2024-01-16", "2024-01-23"]
# (开盘, 收盘): 开盘价与收盘价必须分开, 否则测不出周四收盘卖与周五开盘买的差别。
PRICES = {
    "510300": [(0.98, 1.00), (1.05, 1.10), (1.15, 1.21), (1.30, 1.331)],
    "510500": [(2.05, 2.00), (1.88, 1.90), (1.80, 1.90), (1.90, 1.90)],
    "159915": [(2.90, 3.00), (3.00, 3.00), (3.25, 3.30), (3.30, 3.30)],
}
GENERATED_AT = "2024-01-01 00:00:00"


def _pick(code: str, rank: int, action: str, pre_rank: int | None = None) -> dict[str, object]:
    return {
        "code": code,
        "name": code,
        "core_rank": rank,
        "core_score": 1.0 - rank * 0.1,
        "held": action in {"hold", "buy"},
        "action": action,
        "pre_rank": pre_rank if pre_rank is not None else rank,
    }


def _node(conn: sqlite3.Connection, index: int, picks: list[dict[str, object]]) -> None:
    core_store.replace_node(
        conn,
        {
            "signal_date": DAYS[index],
            "next_rebalance": DAYS[index + 1],
            "generated_at": GENERATED_AT,
            "rule_version": "core8-v1",
            "scored": len(picks),
            "min_aum_yi": 2.0,
        },
        picks,
    )


def _seed(conn: sqlite3.Connection) -> None:
    core_store.ensure_schema(conn)
    with conn:
        conn.executemany("INSERT OR REPLACE INTO trade_calendar (date) VALUES (?)", [(d,) for d in DAYS])
        for code, bars in PRICES.items():
            conn.executemany(
                "INSERT OR REPLACE INTO etf_daily (date, code, open, close, volume) VALUES (?, ?, ?, ?, ?)",
                [(day, code, o, c, 1_000_000) for day, (o, c) in zip(DAYS, bars)],
            )
    _node(conn, 0, [_pick("510300", 1, "buy"), _pick("510500", 2, "buy")])
    _node(conn, 1, [_pick("510300", 1, "hold"), _pick("159915", 2, "buy"), _pick("510500", 9, "sell", 9)])
    _node(conn, 2, [_pick("510300", 1, "hold"), _pick("159915", 2, "hold")])


def test_list_nodes_counts_and_returns() -> None:
    from data.store.database import get_conn

    conn = get_conn()
    _seed(conn)

    rows = nodes.list_nodes(conn)

    assert [r["signal_date"] for r in rows] == DAYS[:3]
    assert [p["code"] for p in rows[0]["holdings"]] == ["510300", "510500"]
    assert rows[0]["counts"] == {"hold": 0, "buy": 2, "sell": 0}
    assert rows[1]["counts"] == {"hold": 1, "buy": 1, "sell": 1}
    # 首个节点全是新买入: 只承担下一交易日 开盘→收盘。
    assert rows[0]["return"] == pytest.approx((1.10 / 1.05 - 1 + 1.90 / 1.88 - 1) / 2, abs=1e-6)
    # 第二个节点: 持有段收盘→收盘, 新买入 开盘→收盘, 顺延卖出 收盘→次日开盘。
    assert rows[1]["return"] == pytest.approx((1.21 / 1.10 - 1 + 3.30 / 3.25 - 1 + 1.80 / 1.90 - 1) / 2, abs=1e-6)
    assert rows[2]["return"] == pytest.approx((1.331 / 1.21 - 1 + 0.0) / 2, abs=1e-6)


def test_list_nodes_benchmarks_use_top10_and_hs300() -> None:
    from data.store.database import get_conn

    conn = get_conn()
    _seed(conn)
    with conn:
        # 排名 11 的标的翻倍: 它只该出现在评分榜, 不能混进前 10 名的对照收益。
        conn.executemany(
            "INSERT OR REPLACE INTO etf_daily (date, code, open, close, volume) VALUES (?, ?, ?, ?, ?)",
            [(day, "512000", 1.0, close, 1_000_000) for day, close in zip(DAYS, [1.0, 2.0, 2.0, 2.0])],
        )
        # 指数比行情晚一天发布: 末节点只有 ETF 行情, 沪深300 必须留空而不是沿用前值。
        conn.executemany(
            "INSERT OR REPLACE INTO index_daily (date, code, close) VALUES (?, '000300', ?)",
            list(zip(DAYS[:3], [4000.0, 4040.0, 4120.0])),
        )
    _node(conn, 0, [_pick("510300", 1, "buy"), _pick("510500", 2, "buy"), _pick("512000", 11, "rank")])

    rows = nodes.list_nodes(conn)

    assert rows[0]["top10_return"] == pytest.approx(((1.10 / 1.00 - 1) + (1.90 / 2.00 - 1)) / 2, abs=1e-6)
    assert rows[1]["top10_return"] == pytest.approx(
        ((1.21 / 1.10 - 1) + (3.30 / 3.00 - 1) + (1.90 / 1.90 - 1)) / 3, abs=1e-6
    )
    assert rows[0]["hs300_return"] == pytest.approx(4040.0 / 4000.0 - 1, abs=1e-6)
    assert rows[1]["hs300_return"] == pytest.approx(4120.0 / 4040.0 - 1, abs=1e-6)
    # 节点 2 的区间终点是 DAYS[3]: ETF 有价, 指数没有 → 只有指数那一列空着。
    assert rows[2]["top10_return"] == pytest.approx(((1.331 / 1.21 - 1) + 0.0) / 2, abs=1e-6)
    assert rows[2]["hs300_return"] is None


def test_timeline_merges_contiguous_holding() -> None:
    from data.store.database import get_conn

    conn = get_conn()
    _seed(conn)

    spells = {(s["code"], s["entry"]): s for s in nodes.timeline(conn)}

    assert set(spells) == {("510300", DAYS[0]), ("510500", DAYS[0]), ("159915", DAYS[1])}
    open_spell = spells[("510300", DAYS[0])]
    assert open_spell["holding"] is True
    assert open_spell["exit"] is None
    assert open_spell["nodes"] == 3
    assert open_spell["return"] is None
    assert open_spell["last_rank"] == 1
    assert open_spell["entry_price"] == pytest.approx(1.05)  # 节点日新买入, 成交在下一交易日开盘

    sold = spells[("510500", DAYS[0])]
    assert sold["exit"] == DAYS[1]
    assert sold["nodes"] == 1
    assert sold["entry_price"] == pytest.approx(1.88)
    assert sold["exit_price"] == pytest.approx(1.80)  # 预备排名仍在缓冲带内, 顺延到次日开盘卖
    assert sold["return"] == pytest.approx(1.80 / 1.88 - 1)

    late = spells[("159915", DAYS[1])]
    assert late["holding"] is True
    assert late["entry_rank"] == 2
    assert late["entry_price"] == pytest.approx(3.25)


def test_detail_enriches_prices_and_rejects_non_node() -> None:
    from data.store.database import get_conn

    conn = get_conn()
    _seed(conn)

    data = nodes.detail(conn, DAYS[1])

    assert data["return"] == pytest.approx((1.21 / 1.10 - 1 + 3.30 / 3.25 - 1 + 1.80 / 1.90 - 1) / 2, abs=1e-6)
    holdings = {p["code"]: p for p in data["holdings"]}
    assert holdings["510300"]["price"] == pytest.approx(1.10)
    assert holdings["510300"]["next_price"] == pytest.approx(1.21)
    assert holdings["510300"]["return"] == pytest.approx(0.1)
    assert "theme" in holdings["510300"]
    assert holdings["159915"]["sell_at"] is None
    assert holdings["159915"]["entry_price"] == pytest.approx(3.25)
    assert holdings["159915"]["return"] == pytest.approx(3.30 / 3.25 - 1)
    sells = {p["code"]: p for p in data["sells"]}
    assert sells["510500"]["sell_at"] == "open"
    assert sells["510500"]["price"] == pytest.approx(1.90)
    assert sells["510500"]["next_price"] is None
    assert sells["510500"]["return"] == pytest.approx(1.80 / 1.90 - 1)

    # 上一节点的持仓在下一节点顺延卖出: 明细的出场价也必须用次日开盘, 而不是下一节点收盘。
    first = {p["code"]: p for p in nodes.detail(conn, DAYS[0])["holdings"]}
    assert first["510500"]["next_price"] == pytest.approx(1.80)
    assert first["510500"]["return"] == pytest.approx(1.80 / 1.88 - 1)
    assert first["510300"]["next_price"] == pytest.approx(1.10)
    assert first["510300"]["return"] == pytest.approx(1.10 / 1.05 - 1)

    with pytest.raises(ValueError):
        nodes.detail(conn, "2024-01-05")
