"""筛选快照的读取入口: 页面只走 build_cached, 不直接触发全量重算。

单日全量筛选约 6 秒、近 4MB JSON; 页面刷新几次就会堆起多个并发重算把后端 CPU 打满。
这里做两件事:
- 落盘快照(screen_store): 命中直接反序列化, 未命中才算并覆盖;
- 单飞锁: 同一信号日的并发请求只放一个线程进 build, 其余等它写完后读快照。
"""

from __future__ import annotations

import json
import sqlite3
import threading
import zlib
from typing import Any, cast

from pages.daily.review import store
from pages.daily.screen import rank
from pages.daily.screen import store as screen_store
from services.scoring import features
from services.scoring.core import store as core_store

_build_locks: dict[str, threading.Lock] = {}
_lock_guard = threading.Lock()


def _lock_for(signal: str) -> threading.Lock:
    with _lock_guard:
        return _build_locks.setdefault(signal, threading.Lock())


def _source_key(conn: sqlite3.Connection, signal: str) -> tuple[str | None, str | None]:
    """快照有效性: 日度记录与所属换仓节点任一重算都会换 generated_at。"""
    day = conn.execute("SELECT generated_at FROM fitted_daily_summary WHERE signal_date = ?", (signal,)).fetchone()
    node = core_store.node_at(conn, signal)
    node_row = (
        conn.execute("SELECT generated_at FROM fitted_core_summary WHERE signal_date = ?", (node,)).fetchone()
        if node
        else None
    )
    return (day["generated_at"] if day else None, node_row["generated_at"] if node_row else None)


def _snapshot(
    conn: sqlite3.Connection,
    signal: str,
    day_generated_at: str | None,
    node_generated_at: str | None,
    min_aum: float,
) -> dict[str, Any] | None:
    row = screen_store.get(conn, signal)
    if row is None or row[0] != day_generated_at or row[1] != node_generated_at or row[2] != min_aum:
        return None
    data = cast(dict[str, Any], json.loads(zlib.decompress(row[3]).decode("utf-8")))
    if data.get("payload_version") != rank.PAYLOAD_VERSION:
        return None
    return data


def latest_signal(conn: sqlite3.Connection) -> str | None:
    row = conn.execute("SELECT MAX(signal_date) FROM fitted_daily_summary").fetchone()
    return row[0] if row and row[0] else None


def warm(conn: sqlite3.Connection, signal: str | None = None) -> str | None:
    """预热筛选快照: 记录/节点每重算一次落盘快照就失效, 不预热就要等页面首次打开冷算约 7 秒。"""
    signal = signal or latest_signal(conn)
    if not signal:
        return None
    build_cached(conn, signal)
    return signal


def build_cached(
    conn: sqlite3.Connection,
    signal: str,
    min_aum: float = features.DEFAULT_MIN_AUM_YI,
) -> dict[str, Any]:
    store.ensure_schema(conn)
    core_store.ensure_schema(conn)
    screen_store.ensure_schema(conn)
    day_generated_at, node_generated_at = _source_key(conn, signal)
    hit = _snapshot(conn, signal, day_generated_at, node_generated_at, min_aum)
    if hit is not None:
        return hit
    with _lock_for(signal):
        hit = _snapshot(conn, signal, day_generated_at, node_generated_at, min_aum)
        if hit is not None:
            return hit
        data = rank.build(conn, signal, min_aum)
        payload = zlib.compress(json.dumps(data, ensure_ascii=False).encode("utf-8"))
        screen_store.put(conn, signal, day_generated_at, node_generated_at, min_aum, payload)
        return data
