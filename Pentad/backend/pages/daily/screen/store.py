"""单日筛选快照落盘: 全量排名一次算 6 秒级、近 4MB, 页面每次打开都重算会把后端拖垮。

快照以「日度记录 generated_at + 所属换仓节点 generated_at + 规模门槛」为有效性键:
任一来源重算后键变化, 下次读取自动重算并覆盖; 行结构升级(PAYLOAD_VERSION)同样视为失效。
"""

from __future__ import annotations

import sqlite3
from datetime import datetime

SCHEMA = """
CREATE TABLE IF NOT EXISTS fitted_daily_screen (
    signal_date TEXT PRIMARY KEY,
    day_generated_at TEXT,
    node_generated_at TEXT,
    min_aum_yi REAL,
    generated_at TEXT,
    payload BLOB
);
"""


def ensure_schema(conn: sqlite3.Connection) -> None:
    conn.executescript(SCHEMA)


def get(conn: sqlite3.Connection, signal: str) -> tuple[str | None, str | None, float | None, bytes] | None:
    row = conn.execute(
        "SELECT day_generated_at, node_generated_at, min_aum_yi, payload "
        "FROM fitted_daily_screen WHERE signal_date = ?",
        (signal,),
    ).fetchone()
    if row is None:
        return None
    return (row["day_generated_at"], row["node_generated_at"], row["min_aum_yi"], row["payload"])


def put(
    conn: sqlite3.Connection,
    signal: str,
    day_generated_at: str | None,
    node_generated_at: str | None,
    min_aum: float,
    payload: bytes,
) -> None:
    with conn:
        conn.execute(
            "INSERT OR REPLACE INTO fitted_daily_screen "
            "(signal_date, day_generated_at, node_generated_at, min_aum_yi, generated_at, payload) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (
                signal,
                day_generated_at,
                node_generated_at,
                min_aum,
                datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
                payload,
            ),
        )
