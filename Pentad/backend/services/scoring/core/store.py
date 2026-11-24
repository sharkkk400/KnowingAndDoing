"""core8 缓冲带的持久化: 每个 5 日换仓节点一条汇总 + 该节点持仓/卖出/评分榜。

与 pages/daily/review/store.py 分开: 那套是逐日复盘记录(每天独立结算),
这套是带持仓记忆的状态机(持仓在节点间延续), 复盘记录从本表读取当日有效的节点持仓。
"""

from __future__ import annotations

import json
import sqlite3
from typing import Any

SCHEMA = """
CREATE TABLE IF NOT EXISTS fitted_core_summary (
    signal_date TEXT PRIMARY KEY,
    next_rebalance TEXT,
    generated_at TEXT,
    rule_version TEXT,
    scored INTEGER,
    min_aum_yi REAL,
    complete INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS fitted_core_pick (
    signal_date TEXT NOT NULL,
    code TEXT NOT NULL,
    name TEXT,
    core_rank INTEGER NOT NULL,
    core_score REAL NOT NULL,
    held INTEGER NOT NULL DEFAULT 0,
    action TEXT NOT NULL,
    factors_json TEXT,
    pre_rank INTEGER,
    PRIMARY KEY (signal_date, code)
);
"""

PICK_COLUMNS = "signal_date, code, name, core_rank, core_score, held, action, factors_json, pre_rank"


def ensure_schema(conn: sqlite3.Connection) -> None:
    conn.executescript(SCHEMA)
    # 因子拆解/预备排名是后加列: 旧库 CREATE IF NOT EXISTS 不会补, 这里兼容升级。
    columns = {row[1] for row in conn.execute("PRAGMA table_info(fitted_core_pick)")}
    if "factors_json" not in columns:
        conn.execute("ALTER TABLE fitted_core_pick ADD COLUMN factors_json TEXT")
    if "pre_rank" not in columns:
        conn.execute("ALTER TABLE fitted_core_pick ADD COLUMN pre_rank INTEGER")
    summary_columns = {row[1] for row in conn.execute("PRAGMA table_info(fitted_core_summary)")}
    if "complete" not in summary_columns:
        conn.execute("ALTER TABLE fitted_core_summary ADD COLUMN complete INTEGER NOT NULL DEFAULT 1")
    conn.commit()


def _decode_pick(row: sqlite3.Row) -> dict[str, Any]:
    item = dict(row)
    raw = item.pop("factors_json", None)
    item["factors"] = json.loads(raw) if raw else None
    return item


def replace_node(conn: sqlite3.Connection, summary: dict[str, Any], picks: list[dict[str, Any]]) -> None:
    """整节点覆盖: 重复回填不会残留旧成员。"""
    signal = summary["signal_date"]
    with conn:
        conn.execute(
            "INSERT OR REPLACE INTO fitted_core_summary "
            "(signal_date, next_rebalance, generated_at, rule_version, scored, min_aum_yi, complete) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            (
                signal,
                summary.get("next_rebalance"),
                summary.get("generated_at"),
                summary.get("rule_version"),
                summary.get("scored"),
                summary.get("min_aum_yi"),
                1 if summary.get("complete", True) else 0,
            ),
        )
        conn.execute("DELETE FROM fitted_core_pick WHERE signal_date = ?", (signal,))
        conn.executemany(
            f"INSERT INTO fitted_core_pick ({PICK_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            [
                (
                    signal,
                    p["code"],
                    p.get("name"),
                    p["core_rank"],
                    p["core_score"],
                    1 if p.get("held") else 0,
                    p["action"],
                    json.dumps(p["factors"], ensure_ascii=False) if p.get("factors") else None,
                    p.get("pre_rank"),
                )
                for p in picks
            ],
        )


def list_nodes(
    conn: sqlite3.Connection,
    start: str | None = None,
    end: str | None = None,
) -> list[dict[str, Any]]:
    sql = "SELECT * FROM fitted_core_summary"
    where: list[str] = []
    params: list[Any] = []
    if start:
        where.append("signal_date >= ?")
        params.append(start)
    if end:
        where.append("signal_date <= ?")
        params.append(end)
    if where:
        sql += " WHERE " + " AND ".join(where)
    sql += " ORDER BY signal_date"
    return [dict(r) for r in conn.execute(sql, params)]


def prune_nodes(conn: sqlite3.Connection, start: str, end: str, keep: list[str]) -> int:
    """删除窗口内本次未写入的旧节点(日历尾部无行情的空节点), 返回删除数。"""
    params: list[Any] = [start, end]
    sql = "SELECT signal_date FROM fitted_core_summary WHERE signal_date >= ? AND signal_date <= ?"
    if keep:
        sql += f" AND signal_date NOT IN ({','.join('?' * len(keep))})"
        params.extend(keep)
    dates = [r["signal_date"] for r in conn.execute(sql, params)]
    with conn:
        for date in dates:
            conn.execute("DELETE FROM fitted_core_pick WHERE signal_date = ?", (date,))
            conn.execute("DELETE FROM fitted_core_summary WHERE signal_date = ?", (date,))
    return len(dates)


def holdings_by_node(
    conn: sqlite3.Connection,
    start: str | None = None,
    end: str | None = None,
) -> dict[str, list[dict[str, Any]]]:
    """{节点日: 该节点持仓(按 core_rank 排序)}: 日度记录按节点延续持仓, 一次查询取全。"""
    sql = (
        "SELECT p.* FROM fitted_core_pick p "
        "JOIN fitted_core_summary s ON s.signal_date = p.signal_date "
        "WHERE p.held = 1"
    )
    params: list[Any] = []
    if start:
        sql += " AND p.signal_date >= ?"
        params.append(start)
    if end:
        sql += " AND p.signal_date <= ?"
        params.append(end)
    sql += " ORDER BY p.signal_date, p.core_rank"
    nodes: dict[str, list[dict[str, Any]]] = {}
    for row in conn.execute(sql, params):
        item = _decode_pick(row)
        nodes.setdefault(item.pop("signal_date"), []).append(item)
    return nodes


def pre_ranks_by_node(
    conn: sqlite3.Connection,
    start: str | None = None,
    end: str | None = None,
) -> dict[str, dict[str, int | None]]:
    """{节点日: {code: 预备排名}}: 卖出动作属于掉出名单, 也要带出它周四收盘时的排名。"""
    sql = "SELECT signal_date, code, pre_rank FROM fitted_core_pick"
    where: list[str] = []
    params: list[Any] = []
    if start:
        where.append("signal_date >= ?")
        params.append(start)
    if end:
        where.append("signal_date <= ?")
        params.append(end)
    if where:
        sql += " WHERE " + " AND ".join(where)
    out: dict[str, dict[str, int | None]] = {}
    for row in conn.execute(sql, params):
        out.setdefault(row["signal_date"], {})[row["code"]] = row["pre_rank"]
    return out


def action_counts(
    conn: sqlite3.Connection,
    start: str | None = None,
    end: str | None = None,
) -> dict[str, dict[str, int]]:
    """{节点日: {hold/buy/sell/rank: 只数}}; 节点收益与换手需要。"""
    sql = "SELECT signal_date, action, COUNT(*) AS n FROM fitted_core_pick"
    where: list[str] = []
    params: list[Any] = []
    if start:
        where.append("signal_date >= ?")
        params.append(start)
    if end:
        where.append("signal_date <= ?")
        params.append(end)
    if where:
        sql += " WHERE " + " AND ".join(where)
    sql += " GROUP BY signal_date, action"
    counts: dict[str, dict[str, int]] = {}
    for row in conn.execute(sql, params):
        counts.setdefault(row["signal_date"], {})[row["action"]] = row["n"]
    return counts


def node_at(conn: sqlite3.Connection, date: str) -> str | None:
    """≤ date 的最近换仓节点: 换仓间隔期内页面继续展示上一个节点的持仓。"""
    row = conn.execute(
        "SELECT signal_date FROM fitted_core_summary WHERE signal_date <= ? ORDER BY signal_date DESC LIMIT 1",
        (date,),
    ).fetchone()
    return row["signal_date"] if row else None


def prev_node(conn: sqlite3.Connection, signal: str) -> str | None:
    """严格早于该节点的上一个节点: 单节点重算要靠它的持仓当状态。"""
    row = conn.execute(
        "SELECT signal_date FROM fitted_core_summary WHERE signal_date < ? ORDER BY signal_date DESC LIMIT 1",
        (signal,),
    ).fetchone()
    return row["signal_date"] if row else None


def node_complete(conn: sqlite3.Connection, signal: str) -> bool:
    """节点日份额是否已落地(False = 收盘时只有 T-1 份额算出的预备目标)。"""
    row = conn.execute("SELECT complete FROM fitted_core_summary WHERE signal_date = ?", (signal,)).fetchone()
    return bool(row and row["complete"])


def get_node(conn: sqlite3.Connection, signal: str) -> dict[str, Any] | None:
    row = conn.execute("SELECT * FROM fitted_core_summary WHERE signal_date = ?", (signal,)).fetchone()
    if row is None:
        return None
    picks = [
        _decode_pick(r)
        for r in conn.execute(
            "SELECT * FROM fitted_core_pick WHERE signal_date = ? ORDER BY core_rank",
            (signal,),
        )
    ]
    data = dict(row)
    data["holdings"] = [p for p in picks if p["held"]]
    data["sells"] = [p for p in picks if p["action"] == "sell"]
    data["ranked"] = [p for p in picks if p["core_rank"] <= 20]
    data["counts"] = {
        "hold": sum(1 for p in picks if p["action"] == "hold"),
        "buy": sum(1 for p in picks if p["action"] == "buy"),
        "sell": len(data["sells"]),
    }
    return data
