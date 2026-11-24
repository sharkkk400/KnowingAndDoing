"""测试隔离：导入任何 data 模块之前把数据目录指向临时目录；每个测试前清空全部表。"""

from __future__ import annotations

import os
import tempfile

import pytest

os.environ["DAILYSCOPE_HOME"] = tempfile.mkdtemp(prefix="dailyscope-test-")

_TABLES = (
    "etfs",
    "etf_daily",
    "etf_shares",
    "etf_share_scale",
    "trade_calendar",
    "indices",
    "index_daily",
    "fitted_daily_summary",
    "fitted_daily_pick",
    "fitted_daily_screen",
    "fitted_core_summary",
    "fitted_core_pick",
)


@pytest.fixture(autouse=True)
def _fresh_db() -> None:
    from data.store.database import get_conn
    from pages.daily.review.store import ensure_schema as ensure_daily_schema
    from pages.daily.screen.store import ensure_schema as ensure_screen_schema
    from services.scoring.core.store import ensure_schema as ensure_core_schema

    conn = get_conn()
    ensure_daily_schema(conn)
    ensure_core_schema(conn)
    ensure_screen_schema(conn)
    with conn:
        for table in _TABLES:
            conn.execute(f"DELETE FROM {table}")
