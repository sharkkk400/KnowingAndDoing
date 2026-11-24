"""日频记录测试的共享种子: 交易日、两只分化 ETF、沪深300 指数与逐日份额。

抽成模块是因为 build_day 的单日测试也要同一份行情/份额口径; 只是测试夹具, 不是被测代码。
现价/开盘按"平开"构造(open = 前一交易日收盘), 新买入与顺延卖出因此可以手算期望。
"""

from __future__ import annotations

import sqlite3
from datetime import date, timedelta
from typing import Any

from pages.daily.review import build
from services.kline import states as macd_states
from services.scoring import features
from services.scoring.core import store as core_store


def weekdays(n: int) -> list[str]:
    days: list[str] = []
    cur = date(2024, 1, 1)
    while len(days) < n:
        if cur.weekday() < 5:
            days.append(cur.isoformat())
        cur += timedelta(days=1)
    return days


def seed(conn: sqlite3.Connection) -> list[str]:
    """80 个交易日: 两只 A 股 ETF(一涨一跌) + 沪深300 指数逐日 0.1% 上行。"""
    days = weekdays(80)
    with conn:
        conn.executemany(
            "INSERT INTO etfs (code, name, fund_type) VALUES (?, ?, ?)",
            [
                ("510300", "沪深300ETF测试", features.DOMESTIC_EQUITY),
                ("510500", "中证500ETF测试", features.DOMESTIC_EQUITY),
            ],
        )
        conn.executemany("INSERT INTO trade_calendar (date) VALUES (?)", [(d,) for d in days])
        for i, day in enumerate(days):
            prev_300 = 100 * (1.003 ** (i - 1)) if i else 100
            prev_500 = 100 * (0.998 ** (i - 1)) if i else 100
            conn.execute(
                "INSERT INTO etf_daily (date, code, open, close, volume) VALUES (?, ?, ?, ?, ?)",
                (day, "510300", prev_300, 100 * (1.003**i), 1_000_000),
            )
            conn.execute(
                "INSERT INTO etf_daily (date, code, open, close, volume) VALUES (?, ?, ?, ?, ?)",
                (day, "510500", prev_500, 100 * (0.998**i), 1_000_000),
            )
            conn.execute(
                "INSERT INTO etf_shares (date, code, shares_yi) VALUES (?, ?, ?)",
                (day, "510300", 10 + i * 0.02),
            )
            conn.execute(
                "INSERT INTO etf_shares (date, code, shares_yi) VALUES (?, ?, ?)",
                (day, "510500", 10.0),
            )
            conn.execute(
                "INSERT INTO index_daily (date, code, close) VALUES (?, ?, ?)",
                (day, "000300", 100 * (1.001**i)),
            )
    return days


def seed_core(conn: sqlite3.Connection, node: str, held: tuple[str, ...] = ("510300",)) -> None:
    """换仓节点: 510300 持有, 510500 仅进评分榜; 日度记录只延续 held=1 的仓位。"""
    core_store.ensure_schema(conn)
    picks = [
        {
            "code": "510300",
            "name": "沪深300ETF测试",
            "core_rank": 1,
            "core_score": 0.8,
            "held": "510300" in held,
            "action": "hold",
            "pre_rank": 1,
        },
        {
            "code": "510500",
            "name": "中证500ETF测试",
            "core_rank": 2,
            "core_score": 0.1,
            "held": "510500" in held,
            "action": "rank",
            "pre_rank": 2,
        },
    ]
    core_store.replace_node(
        conn,
        {
            "signal_date": node,
            "next_rebalance": None,
            "generated_at": "2024-01-01 00:00:00",
            "rule_version": "core8-v1",
            "scored": 2,
            "min_aum_yi": features.DEFAULT_MIN_AUM_YI,
        },
        picks,
    )


def rebuild_last3(conn: sqlite3.Connection, days: list[str]) -> dict[str, Any]:
    seed_core(conn, days[-3])
    return build.rebuild(conn, start_date=days[-3], end_date=days[-1])


def build_day(
    conn: sqlite3.Connection,
    days: list[str],
    signal: str,
    next_signal: str | None,
    held: list[dict[str, Any]],
    plan: dict[str, Any] | None = None,
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """按整段窗口加载一次, 对单个信号日跑 build_day(与 rebuild 同口径的懒加载切片)。"""
    meta = features.load_meta(conn)
    daily = features.load_daily(conn, days[0], days[-1])
    daily_dates = {code: [b["date"] for b in bars] for code, bars in daily.items()}
    shares = features.load_shares(conn, days[0], days[-1])
    shares_dates = {code: [b["date"] for b in bars] for code, bars in shares.items()}
    bench = features.load_index(conn, days[0], days[-1]).get("000300", [])
    provider = macd_states.MacdStateProvider.from_bars(daily)
    return build.build_day(
        conn,
        signal,
        next_signal,
        meta,
        daily,
        daily_dates,
        shares,
        shares_dates,
        bench,
        [b["date"] for b in bench],
        provider,
        len(daily),
        features.DEFAULT_MIN_AUM_YI,
        held,
        plan,
    )
