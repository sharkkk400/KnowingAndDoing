"""预热快照: 导出/装载、数值类型保持、按表跳过与清单缺失降级。"""

from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

from data.store.database import SCHEMA
from ops import seed
from pages.daily.review.store import ensure_schema as ensure_daily_schema
from services.scoring.core.store import ensure_schema as ensure_core_schema


def _source(path: Path) -> None:
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    conn.executescript(SCHEMA)
    ensure_core_schema(conn)
    ensure_daily_schema(conn)
    conn.execute("INSERT INTO etfs (code, name, fund_type) VALUES ('510300', '沪深300ETF', 'stock')")
    conn.execute("INSERT INTO trade_calendar (date) VALUES ('2026-11-18')")
    conn.execute(
        "INSERT INTO etf_daily (date, code, open, close, high, low, volume) "
        "VALUES ('2026-11-18', '510300', 4.0, 4.05, 4.1, 3.95, 123456.0)"
    )
    conn.execute("INSERT INTO etf_shares (date, code, shares_yi) VALUES ('2026-11-18', '510300', 12.5)")
    conn.execute(
        "INSERT INTO etf_share_scale (code, date, ratio, method) VALUES ('510300', '2021-05-31', 2.0, 'split')"
    )
    conn.execute("INSERT INTO indices (code, name) VALUES ('000300', '沪深300')")
    conn.execute("INSERT INTO index_daily (date, code, close, pe) VALUES ('2026-11-18', '000300', 4000.5, 12.3)")
    # 派生表: 未来日期的空结算行不得进入快照(否则增量重算会从日历末尾起算)。
    conn.executemany(
        "INSERT INTO fitted_core_summary (signal_date, rule_version) VALUES (?, 'core8-v1')",
        [("2026-11-18",), ("2026-12-31",)],
    )
    conn.execute(
        "INSERT INTO fitted_core_pick (signal_date, code, core_rank, core_score, action) "
        "VALUES ('2026-11-18', '510300', 1, 0.9, 'buy')"
    )
    conn.executemany(
        "INSERT INTO fitted_daily_summary (signal_date, rule_version) VALUES (?, 'daily-core8-v1')",
        [("2026-11-18",), ("2026-12-31",)],
    )
    conn.execute(
        "INSERT INTO fitted_daily_pick (signal_date, bucket, pick_rank, code) "
        "VALUES ('2026-11-18', 'baseline', 1, '510300')"
    )
    conn.commit()
    conn.close()


def _target(path: Path) -> sqlite3.Connection:
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    conn.executescript(SCHEMA)
    return conn


def _built(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    src = tmp_path / "src.db"
    out = tmp_path / "seed"
    _source(src)
    monkeypatch.setattr(seed, "SEED_DIR", out)
    monkeypatch.setattr(seed, "MANIFEST_PATH", out / "manifest.json")
    info = seed.build(src, out)
    assert info["cutoff"] == "2026-11-18"
    return out


def test_build_then_restore_keeps_types(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    out = _built(tmp_path, monkeypatch)
    assert (out / "etf_daily.csv.gz").is_file()
    conn = _target(tmp_path / "target.db")
    result = seed.restore(conn)
    assert result["cutoff"] == "2026-11-18"
    assert result["rows"] == 11
    close = conn.execute("SELECT close FROM etf_daily").fetchone()[0]
    assert isinstance(close, float) and close == pytest.approx(4.05)
    assert conn.execute("SELECT typeof(close) FROM etf_daily").fetchone()[0] == "real"
    assert conn.execute("SELECT shares_yi FROM etf_shares").fetchone()[0] == pytest.approx(12.5)
    assert conn.execute("SELECT pe FROM index_daily").fetchone()[0] == pytest.approx(12.3)


def test_build_restores_derived_tables_without_future_rows(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _built(tmp_path, monkeypatch)
    conn = _target(tmp_path / "target.db")
    seed.restore(conn)  # 空库没有派生表 schema, restore 必须先建表
    for table in ("fitted_core_summary", "fitted_daily_summary"):
        dates = [r[0] for r in conn.execute(f"SELECT signal_date FROM {table} ORDER BY signal_date")]
        assert dates == ["2026-11-18"]
    assert conn.execute("SELECT core_rank FROM fitted_core_pick").fetchone()[0] == 1
    assert conn.execute("SELECT code FROM fitted_daily_pick").fetchone()[0] == "510300"


def test_restore_skips_tables_with_rows(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _built(tmp_path, monkeypatch)
    conn = _target(tmp_path / "target.db")
    conn.execute("INSERT INTO etfs (code, name) VALUES ('159000', '已有标的')")
    conn.commit()
    result = seed.restore(conn)
    assert "etfs" not in result["tables"]
    assert conn.execute("SELECT COUNT(*) FROM etfs").fetchone()[0] == 1
    assert conn.execute("SELECT COUNT(*) FROM etf_daily").fetchone()[0] == 1


def test_restore_is_idempotent(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _built(tmp_path, monkeypatch)
    conn = _target(tmp_path / "target.db")
    seed.restore(conn)
    again = seed.restore(conn)
    assert again["skipped"] == "库内已有数据, 无需装载快照"
    assert conn.execute("SELECT COUNT(*) FROM etf_daily").fetchone()[0] == 1


def test_restore_without_manifest_degrades(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(seed, "SEED_DIR", tmp_path / "none")
    monkeypatch.setattr(seed, "MANIFEST_PATH", tmp_path / "none" / "manifest.json")
    result = seed.restore(_target(tmp_path / "target.db"))
    assert result["skipped"] == "代码库未附带预热快照, 改为在线全量拉取"


def test_manifest_reports_table_rows(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _built(tmp_path, monkeypatch)
    info = seed.manifest()
    assert info is not None
    assert info["tables"]["etf_daily"]["rows"] == 1
    assert info["tables"]["fitted_core_summary"]["rows"] == 1
    assert info["tables"]["fitted_daily_pick"]["rows"] == 1
    assert info["derived_cutoff"] == "2026-11-18"
    assert "columns" in info["tables"]["etf_daily"]


def test_restore_degrades_when_snapshot_files_missing(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """只带 manifest 没带 gzip(从文档还原的代码库): 降级在线拉取, 不能抛 FileNotFoundError。"""
    out = _built(tmp_path, monkeypatch)
    (out / "etf_daily.csv.gz").unlink()
    conn = _target(tmp_path / "target.db")
    result = seed.restore(conn)
    assert result["skipped"] == "快照文件缺失(1 个), 改为在线全量拉取"
    assert conn.execute("SELECT COUNT(*) FROM etfs").fetchone()[0] == 0


def test_missing_snapshot_files_ignored_for_tables_with_rows(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    out = _built(tmp_path, monkeypatch)
    conn = _target(tmp_path / "target.db")
    seed.restore(conn)
    (out / "etf_daily.csv.gz").unlink()
    again = seed.restore(conn)
    assert again["skipped"] == "库内已有数据, 无需装载快照"
