"""预热快照: 代码库自带一份历史切片, 空库先本地装载, 只在线补快照之后的增量。

为什么需要: 全量在线回填要拉 1767 只 ETF 的全历史日K 和 2015 年起逐日全市场份额,
网络与限流成本高(数十分钟起步); 派生层(core8 节点 + 日度记录)全量重算也要二十分钟。
快照把原始表与派生表一起固化成 gzip CSV(约 35MB)随仓库分发, 一键准备时先装载到
cut-off 日, 再由增量链路补齐之后的部分。

装载按表进行: 目标表已有数据就跳过该表, 因此重复执行安全; 数值列按 schema 类型回填,
不会把 REAL 写成文本(否则 SQL 排序与计算都会退化成字符串比较)。派生表按 signal_date
截到 cut-off, 未来日期的空结算行不随快照分发(否则增量重算会从日历末尾起算)。
"""

from __future__ import annotations

import csv
import gzip
import json
import sqlite3
from collections.abc import Callable
from datetime import datetime
from pathlib import Path
from typing import Any

from pages.daily.review import store as daily_store
from services.scoring.core import store as core_store

SEED_DIR = Path(__file__).resolve().parents[1] / "seed"
MANIFEST_PATH = SEED_DIR / "manifest.json"
RAW_TABLES = ("etfs", "trade_calendar", "etf_daily", "etf_shares", "etf_share_scale", "indices", "index_daily")
DERIVED_TABLES = ("fitted_core_summary", "fitted_core_pick", "fitted_daily_summary", "fitted_daily_pick")
TABLES = RAW_TABLES + DERIVED_TABLES
BATCH_ROWS = 5000
RowReport = Callable[[str, int, int], None]


def manifest() -> dict[str, Any] | None:
    """读取快照清单; 缺失或损坏时返回 None, 由调用方降级为在线全量。"""
    if not MANIFEST_PATH.is_file():
        return None
    try:
        with MANIFEST_PATH.open(encoding="utf-8") as f:
            info: dict[str, Any] = json.load(f)
            return info
    except (OSError, json.JSONDecodeError):
        return None


def _has_rows(conn: sqlite3.Connection, table: str) -> bool:
    return conn.execute(f"SELECT 1 FROM {table} LIMIT 1").fetchone() is not None


def _missing_files(conn: sqlite3.Connection, info: dict[str, Any]) -> list[str]:
    """清单里仍需装载却缺失的快照文件。

    只检查库内还没有数据的表: 已有数据的表本来就会跳过, 缺文件不影响它。
    文档/仓库只带 manifest 而没带 gzip 时(例如从文档还原的代码库), 这里返回非空,
    调用方降级为在线全量拉取, 而不是在装载第一张表时抛 FileNotFoundError。
    """
    missing: list[str] = []
    for table in TABLES:
        meta = info["tables"].get(table)
        if not meta or _has_rows(conn, table):
            continue
        if not (SEED_DIR / meta["file"]).is_file():
            missing.append(meta["file"])
    return missing


def _convert(raw: str, decl: str) -> Any:
    if raw == "":
        return None
    upper = decl.upper()
    if "INT" in upper:
        return int(raw)
    if any(t in upper for t in ("REAL", "FLOA", "DOUB", "NUMERIC", "DECIMAL")):
        return float(raw)
    return raw


def _load_table(conn: sqlite3.Connection, table: str, info: dict[str, Any], on_rows: RowReport | None) -> int:
    columns: list[str] = info["columns"]
    total = int(info.get("rows", 0))
    decls = {row[1]: str(row[2] or "") for row in conn.execute(f"PRAGMA table_info({table})")}
    sql = f"INSERT OR REPLACE INTO {table} ({', '.join(columns)}) VALUES ({', '.join('?' * len(columns))})"
    done = 0
    with gzip.open(SEED_DIR / info["file"], "rt", newline="", encoding="utf-8") as f:
        reader = csv.reader(f)
        header = next(reader)
        if header != columns:
            raise ValueError(f"{table} 快照列与 schema 不一致")
        batch: list[list[Any]] = []
        for raw in reader:
            batch.append([_convert(v, decls.get(c, "")) for c, v in zip(header, raw)])
            if len(batch) >= BATCH_ROWS:
                conn.executemany(sql, batch)
                done += len(batch)
                batch.clear()
                conn.commit()
                if on_rows:
                    on_rows(table, done, total)
        if batch:
            conn.executemany(sql, batch)
            done += len(batch)
            conn.commit()
    if on_rows:
        on_rows(table, done, total)
    return done


def restore(conn: sqlite3.Connection, on_rows: RowReport | None = None) -> dict[str, Any]:
    """把快照装进空库; 已有数据的表跳过。返回装载的截止日与行数。"""
    m = manifest()
    if m is None:
        return {"skipped": "代码库未附带预热快照, 改为在线全量拉取"}
    core_store.ensure_schema(conn)
    daily_store.ensure_schema(conn)
    missing = _missing_files(conn, m)
    if missing:
        return {"skipped": f"快照文件缺失({len(missing)} 个), 改为在线全量拉取"}
    restored: dict[str, int] = {}
    for table in TABLES:
        info = m["tables"].get(table)
        if not info or _has_rows(conn, table):
            continue
        restored[table] = _load_table(conn, table, info, on_rows)
    if not restored:
        return {"skipped": "库内已有数据, 无需装载快照"}
    return {"cutoff": m.get("cutoff"), "tables": restored, "rows": sum(restored.values())}


def build(src: str | Path, out_dir: Path = SEED_DIR) -> dict[str, Any]:
    """从已有数据库导出快照(gzip CSV + manifest), 供随仓库分发。"""
    src_conn = sqlite3.connect(str(src))
    out_dir.mkdir(parents=True, exist_ok=True)
    cutoff = src_conn.execute("SELECT MAX(date) FROM etf_daily").fetchone()[0]
    tables: dict[str, Any] = {}
    for table in TABLES:
        columns = [row[1] for row in src_conn.execute(f"PRAGMA table_info({table})")]
        where = f" WHERE signal_date <= '{cutoff}'" if table in DERIVED_TABLES and cutoff else ""
        path = out_dir / f"{table}.csv.gz"
        rows = 0
        with gzip.open(path, "wt", newline="", encoding="utf-8") as f:
            writer = csv.writer(f)
            writer.writerow(columns)
            for row in src_conn.execute(f"SELECT {', '.join(columns)} FROM {table}{where}"):
                writer.writerow(["" if v is None else v for v in row])
                rows += 1
        tables[table] = {"rows": rows, "columns": columns, "file": path.name}
    derived_max = src_conn.execute("SELECT MAX(signal_date) FROM fitted_daily_summary").fetchone()[0]
    src_conn.close()
    info = {
        "generated_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "cutoff": cutoff,
        "derived_cutoff": min(derived_max, cutoff) if derived_max and cutoff else derived_max,
        "tables": tables,
    }
    with (out_dir / "manifest.json").open("w", encoding="utf-8") as f:
        json.dump(info, f, ensure_ascii=False, indent=2)
    return info
