"""日频复盘的持久化: 每个交易日一条汇总 + core8 持仓/基线两组成员逐笔记录。

表结构沿用旧版周度 store.py, 但日频版不存市场状态(regime); 持仓桶是
core8 缓冲带的当日有效持仓(由换仓节点延续), 不再是"趋势内回撤"规则桶。
"""

from __future__ import annotations

import json
import sqlite3
from typing import Any

SCHEMA = """
CREATE TABLE IF NOT EXISTS fitted_daily_summary (
    signal_date TEXT PRIMARY KEY,
    next_signal TEXT,
    generated_at TEXT,
    rule_version TEXT,
    codes_with_bar INTEGER,
    codes_with_enough_history INTEGER,
    scored INTEGER,
    min_aum_yi REAL,
    shares_available INTEGER,
    universe_mean REAL,
    universe_median REAL,
    universe_hit REAL,
    baseline_mean REAL,
    baseline_median REAL,
    baseline_hit REAL,
    core_mean REAL,
    core_median REAL,
    core_hit REAL,
    rank_ic REAL,
    eval_json TEXT,
    index_returns_json TEXT
);
CREATE TABLE IF NOT EXISTS fitted_daily_pick (
    signal_date TEXT NOT NULL,
    bucket TEXT NOT NULL,
    pick_rank INTEGER NOT NULL,
    code TEXT NOT NULL,
    name TEXT,
    theme TEXT,
    fund_type TEXT,
    baseline_score REAL,
    reason_text TEXT,
    reason_json TEXT,
    next_return REAL,
    PRIMARY KEY (signal_date, bucket, pick_rank)
);
"""

EVAL_PICK_KEYS = ("baseline_top10_picks", "core_holdings_picks")

# 旧 daily-v1 的规则桶列改名: SQLite ≥3.25 支持 RENAME COLUMN, 破坏前先判存在。
_RENAMES = (
    ("rule_mean", "core_mean"),
    ("rule_median", "core_median"),
    ("rule_hit", "core_hit"),
)


def ensure_schema(conn: sqlite3.Connection) -> None:
    conn.executescript(SCHEMA)
    cols = {r["name"] for r in conn.execute("PRAGMA table_info(fitted_daily_summary)")}
    with conn:
        for old, new in _RENAMES:
            if old in cols and new not in cols:
                conn.execute(f"ALTER TABLE fitted_daily_summary RENAME COLUMN {old} TO {new}")


def _metric(block: dict[str, Any] | None, key: str) -> float | None:
    if not block:
        return None
    value = block.get(key)
    return float(value) if isinstance(value, (int, float)) else None


def _summary_row(summary: dict[str, Any]) -> tuple:
    evaluation = summary["evaluation"]
    return (
        summary["signal_date"],
        summary.get("next_signal"),
        summary.get("generated_at"),
        summary.get("rule_version"),
        summary.get("codes_with_bar"),
        summary.get("codes_with_enough_history"),
        summary.get("scored"),
        summary.get("min_aum_yi"),
        summary.get("shares_available"),
        _metric(evaluation.get("universe"), "mean"),
        _metric(evaluation.get("universe"), "median"),
        _metric(evaluation.get("universe"), "hit_rate"),
        _metric(evaluation.get("baseline_top10"), "mean"),
        _metric(evaluation.get("baseline_top10"), "median"),
        _metric(evaluation.get("baseline_top10"), "hit_rate"),
        _metric(evaluation.get("core_holdings"), "mean"),
        _metric(evaluation.get("core_holdings"), "median"),
        _metric(evaluation.get("core_holdings"), "hit_rate"),
        evaluation.get("rank_ic_baseline"),
        json.dumps({k: v for k, v in evaluation.items() if k not in EVAL_PICK_KEYS}, ensure_ascii=False),
        json.dumps(evaluation.get("index_returns") or {}, ensure_ascii=False),
    )


SUMMARY_COLUMNS = (
    "signal_date, next_signal, generated_at, rule_version, codes_with_bar, codes_with_enough_history, scored, "
    "min_aum_yi, shares_available, universe_mean, universe_median, universe_hit, baseline_mean, baseline_median, "
    "baseline_hit, core_mean, core_median, core_hit, rank_ic, eval_json, index_returns_json"
)

SUMMARY_SQL = f"INSERT OR REPLACE INTO fitted_daily_summary ({SUMMARY_COLUMNS}) VALUES ({', '.join(['?'] * 21)})"

PICK_SQL = """
INSERT OR REPLACE INTO fitted_daily_pick
    (signal_date, bucket, pick_rank, code, name, theme, fund_type, baseline_score,
     reason_text, reason_json, next_return)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
"""


def replace_day(
    conn: sqlite3.Connection,
    summary: dict[str, Any],
    picks: list[dict[str, Any]],
) -> None:
    """整日覆盖: 重复执行同一信号日不会留下旧成员(含旧 rule 桶)。"""
    signal = summary["signal_date"]
    with conn:
        conn.execute(SUMMARY_SQL, _summary_row(summary))
        conn.execute("DELETE FROM fitted_daily_pick WHERE signal_date = ?", (signal,))
        conn.executemany(
            PICK_SQL,
            [
                (
                    signal,
                    p["bucket"],
                    p["rank"],
                    p["code"],
                    p.get("name"),
                    p.get("theme"),
                    p.get("fund_type"),
                    p.get("baseline_score"),
                    p.get("reason_text"),
                    json.dumps(p.get("reason") or {}, ensure_ascii=False),
                    p.get("next_return"),
                )
                for p in picks
            ],
        )


def _decode_row(row: sqlite3.Row) -> dict[str, Any]:
    data = dict(row)
    data["evaluation"] = json.loads(data.pop("eval_json") or "{}")
    data["index_returns"] = json.loads(data.pop("index_returns_json") or "{}") or {}
    return data


def list_days(
    conn: sqlite3.Connection,
    start: str | None = None,
    end: str | None = None,
) -> list[dict[str, Any]]:
    sql = "SELECT * FROM fitted_daily_summary"
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
    return [_decode_row(r) for r in conn.execute(sql, params)]


def get_day(conn: sqlite3.Connection, signal_date: str) -> dict[str, Any] | None:
    row = conn.execute("SELECT * FROM fitted_daily_summary WHERE signal_date = ?", (signal_date,)).fetchone()
    if row is None:
        return None
    data = _decode_row(row)
    picks: dict[str, list[dict[str, Any]]] = {"core": [], "baseline": []}
    for r in conn.execute(
        "SELECT * FROM fitted_daily_pick WHERE signal_date = ? ORDER BY bucket, pick_rank",
        (signal_date,),
    ):
        item = dict(r)
        item["reason"] = json.loads(item.pop("reason_json") or "{}")
        picks.setdefault(item.pop("bucket"), []).append(item)
    data["picks"] = picks
    return data


def all_picks(
    conn: sqlite3.Connection,
    bucket: str,
    start: str | None = None,
    end: str | None = None,
    *,
    require_return: bool = True,
) -> list[dict[str, Any]]:
    sql = "SELECT * FROM fitted_daily_pick WHERE bucket = ?"
    if require_return:
        sql += " AND next_return IS NOT NULL"
    params: list[Any] = [bucket]
    if start:
        sql += " AND signal_date >= ?"
        params.append(start)
    if end:
        sql += " AND signal_date <= ?"
        params.append(end)
    sql += " ORDER BY signal_date, pick_rank"
    return [dict(r) for r in conn.execute(sql, params)]
