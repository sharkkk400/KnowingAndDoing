"""盘中实时全量排名行: 与收盘筛选同构的 stage/排序/行情字段语义(纯函数, 不触网)。"""

from __future__ import annotations

from typing import Any

import pytest

from pages.daily.live import rows
from services.scoring import features

TODAY = "2026-11-18"
EQUITY = features.DOMESTIC_EQUITY


def _meta(code: str, name: str, fund_type: str = EQUITY) -> dict[str, Any]:
    return {"name": name, "fund_type": fund_type}


def _bars(last: str, n: int = features.MIN_BARS + 5) -> list[dict[str, Any]]:
    return [{"date": f"2026-10-{i % 28 + 1:02d}"} for i in range(n - 1)] + [{"date": last}]


def _row(code: str, baseline: float, aum: float = 5.0) -> dict[str, Any]:
    return {"code": code, "aum_yi": aum, "baseline_score": baseline, "shares_yi": 3.0}


def _scored(code: str, rank: int) -> dict[str, Any]:
    return {
        "code": code,
        "core_rank": rank,
        "core_score": 0.5,
        "core_factors": [],
        "name": code,
        "theme": "其他",
        "fund_type": EQUITY,
        "baseline_score": 0.0,
    }


@pytest.fixture(autouse=True)
def _stub_reason(monkeypatch: pytest.MonkeyPatch) -> None:
    """reason 组装由 weekly.reasons 单测覆盖, 这里只验证行结构语义。"""
    monkeypatch.setattr(rows, "reason_json", lambda row, flags: {"stub": True})
    monkeypatch.setattr(rows, "reason_text", lambda row, rank: "stub")
    monkeypatch.setattr(rows.core_reason, "reason_text", lambda row, rank, held: "stub")


def test_stages_follow_screen_semantics() -> None:
    meta = {
        "510300": _meta("510300", "沪深300ETF"),
        "512100": _meta("512100", "中证1000ETF"),
        "510880": _meta("510880", "红利ETF"),
        "513100": _meta("513100", "纳指ETF"),
        "511010": _meta("511010", "国债ETF", fund_type="债券型"),
        "520990": _meta("520990", "港股创新药ETF"),
    }
    daily_all = {
        "510300": _bars(TODAY),  # 有今日 bar → 可评分
        "512100": _bars("2026-11-17"),  # 停在昨日 → 今日无 bar
        "510880": _bars(TODAY),
    }
    feature_rows = [_row("510300", 0.9), _row("510880", 0.1, aum=1.0)]  # 510880 规模不足
    candidates = [_row("510300", 0.9)]
    scored = [_scored("510300", 1)]
    held_codes = {"510300"}
    quotes = {"510300": {"price": 4.0, "pct": 0.01, "time": f"{TODAY} 14:00:00"}}

    items = rows.build_rows(meta, daily_all, feature_rows, candidates, scored, held_codes, quotes, TODAY)
    by_code = {r["code"]: r for r in items}

    assert by_code["510300"]["stage"] == "core_hold"
    assert by_code["510300"]["quote"] == {"price": 4.0, "pct": 0.01, "time": f"{TODAY} 14:00:00"}
    assert by_code["512100"]["stage"] == "no_bar"  # 昨日有K线 ≠ 今日有bar
    assert by_code["510880"]["stage"] == "small_aum"
    assert by_code["513100"]["stage"] == "no_bar"  # 有历史但今日未更新, 不会误标 core_pool
    assert by_code["511010"]["stage"] == "non_equity"
    assert by_code["520990"]["stage"] == "hk"


def test_rows_sorted_by_baseline_rank() -> None:
    meta = {"AAA": _meta("AAA", "AETF"), "BBB": _meta("BBB", "BETF"), "CCC": _meta("CCC", "CETF")}
    daily_all = {c: _bars(TODAY) for c in meta}
    feature_rows = [_row("AAA", 0.5), _row("BBB", 0.9), _row("CCC", 0.7)]
    candidates = list(feature_rows)
    scored = [_scored("BBB", 1), _scored("CCC", 2), _scored("AAA", 3)]

    items = rows.build_rows(meta, daily_all, feature_rows, candidates, scored, set(), {}, TODAY)

    assert [r["code"] for r in items] == ["BBB", "CCC", "AAA"]
    assert [r["rank"] for r in items] == [1, 2, 3]
    assert items[0]["stage"] == "core_pool"


def test_stale_quote_not_attached() -> None:
    meta = {"AAA": _meta("AAA", "AETF")}
    daily_all = {"AAA": _bars(TODAY)}
    feature_rows = [_row("AAA", 0.5)]
    stale = {"AAA": {"price": 4.0, "pct": 0.01, "time": "2026-11-17 15:00:00"}}

    items = rows.build_rows(meta, daily_all, feature_rows, feature_rows, [_scored("AAA", 1)], set(), stale, TODAY)

    assert items[0]["quote"] is None
