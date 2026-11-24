"""筛选漏斗与全量排名: 每一级剔除原因、阶段归属与评分明细。"""

from __future__ import annotations

import sqlite3
from datetime import date, timedelta

import pytest

from data.store.database import get_conn
from pages.daily.review import build, store
from pages.daily.screen import rank
from services.scoring import features
from services.scoring.core import store as core_store


@pytest.fixture(autouse=True)
def _clear_screen_cache() -> None:
    rank._cache.clear()


def _weekdays(n: int) -> list[str]:
    days: list[str] = []
    cur = date(2024, 1, 1)
    while len(days) < n:
        if cur.weekday() < 5:
            days.append(cur.isoformat())
        cur += timedelta(days=1)
    return days


def _seed(conn: sqlite3.Connection) -> list[str]:
    """8 只标的覆盖漏斗每一级: 通过/规模不足/无份额/停牌/次新/港股/债券。"""
    days = _weekdays(80)
    etfs = [
        ("510300", "沪深300ETF测试", features.DOMESTIC_EQUITY),
        ("510500", "中证500ETF测试", features.DOMESTIC_EQUITY),
        ("512999", "小规模ETF测试", features.DOMESTIC_EQUITY),
        ("513999", "无份额ETF测试", features.DOMESTIC_EQUITY),
        ("512888", "停牌ETF测试", features.DOMESTIC_EQUITY),
        ("159920", "恒生ETF测试", features.DOMESTIC_EQUITY),
        ("511010", "国债ETF测试", "债券型-长债"),
        ("513888", "次新ETF测试", features.DOMESTIC_EQUITY),
    ]
    closes = {
        "510300": lambda i: 100 * (1.003**i),
        "510500": lambda i: 100 * (0.998**i),
        "512999": lambda i: 100 * (1 + 0.001 * i),
        "513999": lambda i: 100 * (1 + 0.0005 * i),
        "512888": lambda i: 100.0,
        "159920": lambda i: 100.0,
        "511010": lambda i: 100.0,
        "513888": lambda i: 50.0,
    }
    shares = {"510300": lambda i: 10 + i * 0.02, "510500": lambda i: 10.0, "512999": lambda i: 0.01}
    with conn:
        conn.executemany("INSERT INTO etfs (code, name, fund_type) VALUES (?, ?, ?)", etfs)
        conn.executemany("INSERT INTO trade_calendar (date) VALUES (?)", [(d,) for d in days])
        for i, day in enumerate(days):
            for code, close in closes.items():
                if code == "512888" and i == len(days) - 1:
                    continue  # 信号日停牌
                if code == "513888" and i < len(days) - 30:
                    continue  # 次新, 历史不足 62 根
                conn.execute(
                    "INSERT INTO etf_daily (date, code, close, volume) VALUES (?, ?, ?, ?)",
                    (day, code, close(i), 1_000_000),
                )
            for code, value in shares.items():
                conn.execute(
                    "INSERT INTO etf_shares (date, code, shares_yi) VALUES (?, ?, ?)",
                    (day, code, value(i)),
                )
            conn.execute(
                "INSERT INTO index_daily (date, code, close) VALUES (?, ?, ?)",
                (day, "000300", 100 * (1.001**i)),
            )
    return days


def _seed_node(conn: sqlite3.Connection, day: str, held: list[str]) -> None:
    """信号日的换仓节点: held 里的名字落在缓冲带持仓, 其余只进评分榜。"""
    core_store.ensure_schema(conn)
    picks = [
        {
            "code": code,
            "name": code,
            "core_rank": rank,
            "core_score": 1.0 - rank * 0.1,
            "held": code in held,
            "action": "hold" if code in held else "rank",
        }
        for rank, code in enumerate(["510300", "510500"], 1)
    ]
    core_store.replace_node(
        conn,
        {
            "signal_date": day,
            "next_rebalance": None,
            "generated_at": "2024-01-01 00:00:00",
            "rule_version": "core8-v1",
            "scored": 2,
            "min_aum_yi": features.DEFAULT_MIN_AUM_YI,
        },
        picks,
    )


def test_funnel_counts_each_stage() -> None:
    conn = get_conn()
    days = _seed(conn)
    _seed_node(conn, days[-1], ["510300"])

    data = rank.build(conn, days[-1])

    assert data["available"] is True
    counts = {stage["key"]: stage["count"] for stage in data["funnel"]}
    assert counts == {
        "etfs": 8,
        "equity": 7,
        "a_share": 6,
        "with_bar": 5,
        "history": 4,
        "shares": 3,
        "aum": 2,
        "core_pool": 2,
        "core_hold": 1,
    }
    sequence = [stage["count"] for stage in data["funnel"]]
    assert sequence == sorted(sequence, reverse=True)  # 漏斗只减不增
    assert [stage["key"] for stage in data["funnel"]][0] == "etfs"


def test_rows_attribute_each_drop_stage() -> None:
    conn = get_conn()
    days = _seed(conn)
    _seed_node(conn, days[-1], ["510300"])

    data = rank.build(conn, days[-1])
    rows = {row["code"]: row for row in data["rows"]}

    assert rows["511010"]["stage"] == "non_equity"
    assert rows["159920"]["stage"] == "hk"
    assert rows["512888"]["stage"] == "no_bar"
    assert rows["512888"]["last_bar"] == days[-2]
    assert rows["513888"]["stage"] == "short_history"
    assert rows["513999"]["stage"] == "no_shares"
    assert rows["512999"]["stage"] == "small_aum"
    assert 0 < rows["512999"]["reason"]["aum_yi"] < 2
    assert rows["510500"]["stage"] == "core_pool"
    assert rows["510500"]["core8_rank"] is not None
    assert rows["510300"]["stage"] == "core_hold"
    assert rows["510300"]["core8_score"] is not None
    assert data["node_date"] == days[-1]  # 节点涨跌基准: 节点日收盘
    assert rows["510300"]["node_close"] == pytest.approx(100 * (1.003 ** (len(days) - 1)))


def test_ranking_and_codes_match_picks() -> None:
    conn = get_conn()
    days = _seed(conn)
    _seed_node(conn, days[-1], ["510300"])

    data = rank.build(conn, days[-1])
    rows = {row["code"]: row for row in data["rows"]}

    assert rows["510300"]["rank"] == 1
    assert rows["510500"]["rank"] == 2
    assert data["core_codes"] == ["510300"]
    assert data["baseline_codes"] == ["510300", "510500"]
    assert rows["510300"]["reason"]["baseline_score"] >= rows["510500"]["reason"]["baseline_score"]
    assert rows["510300"]["reason_text"].startswith("策略")
    assert rows["510500"]["reason_text"].startswith("综合分")

    build.rebuild(conn, start_date=days[-1], end_date=days[-1])
    day = store.get_day(conn, days[-1])
    assert day is not None
    assert [p["code"] for p in day["picks"]["core"]] == data["core_codes"]
    assert [p["code"] for p in day["picks"]["baseline"]] == data["baseline_codes"]


def test_signal_day_without_bars_is_unavailable() -> None:
    conn = get_conn()
    _seed(conn)
    with conn:
        conn.execute("INSERT INTO trade_calendar (date) VALUES ('2024-04-29')")  # 交易日历有、行情无

    data = rank.build(conn, "2024-04-29")

    assert data["available"] is False
    assert "K 线" in data["reason"]
    assert all(row["stage"] in {"non_equity", "hk", "no_bar"} for row in data["rows"])


def test_non_trading_day_raises() -> None:
    conn = get_conn()
    _seed(conn)

    with pytest.raises(ValueError):
        rank.build(conn, "2024-01-06")
