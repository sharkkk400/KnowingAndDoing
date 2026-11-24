"""日频复盘记录: core8 节点持仓逐日延续、T+1 结算、落库幂等与归因。"""

from __future__ import annotations

import sqlite3

import pytest

from data.store.database import get_conn
from pages.daily.review import attribution, build, store
from services.scoring.descriptors import slices
from tests.daily_seed import rebuild_last3 as _rebuild_last3
from tests.daily_seed import seed as _seed
from tests.daily_seed import weekdays as _weekdays


def test_slice_bars_window_and_missing_signal() -> None:
    dates = _weekdays(10)
    bars = [{"date": d, "close": float(i)} for i, d in enumerate(dates)]

    part = slices.slice_bars(bars, dates, dates[6], 3)
    assert part is not None and [b["date"] for b in part] == dates[4:7]  # 含信号日在内最近 3 根
    assert slices.slice_bars(bars, dates, "2023-12-31", 3) is None  # 非交易日
    head = slices.slice_bars(bars, dates, dates[1], 3)
    assert head is not None and len(head) == 2  # 窗口越界截到最早


def test_slice_points_allows_lagging_shares() -> None:
    """份额 T+1 发布: 信号日没有份额行时仍要取 ≤ 信号日的最后一段。"""
    dates = _weekdays(10)
    bars = [{"date": d, "shares_yi": float(i)} for i, d in enumerate(dates)]

    part = slices.slice_points(bars, dates, dates[7], 3)
    assert part is not None and [b["date"] for b in part] == dates[5:8]
    # 信号日(第 9 天)尚未入库: 宽松切片取到前一交易日为止
    lagging = slices.slice_points(bars, dates[:-1], dates[9], 3)
    assert lagging is not None and [b["date"] for b in lagging] == dates[6:9]
    assert slices.slice_points(bars, dates, "2023-12-31", 3) is None


def test_holdings_carry_until_next_node() -> None:
    """换仓间隔期内沿用上一节点持仓, 节点当日才切换。"""
    days = _weekdays(4)
    first = [{"code": "A"}]
    second = [{"code": "B"}]
    nodes = {days[1]: first, days[3]: second}
    node_dates = sorted(nodes)

    assert build._held_for_day(node_dates, nodes, days[0]) == []  # 节点前无持仓
    assert build._held_for_day(node_dates, nodes, days[1]) == first
    assert build._held_for_day(node_dates, nodes, days[2]) == first
    assert build._held_for_day(node_dates, nodes, days[3]) == second


def test_rebuild_requires_core_nodes() -> None:
    conn = get_conn()
    days = _seed(conn)

    with pytest.raises(ValueError, match="换仓节点"):
        build.rebuild(conn, start_date=days[-3], end_date=days[-1])


def test_rebuild_writes_daily_rows_with_t1_settlement() -> None:
    conn = get_conn()
    days = _seed(conn)

    result = _rebuild_last3(conn, days)

    assert result["days"] == 3
    rows = store.list_days(conn)
    assert [r["signal_date"] for r in rows] == days[-3:]
    assert all(r["rule_version"] == build.RULE_VERSION for r in rows)
    assert all(r["scored"] == 2 for r in rows)

    settled = store.get_day(conn, days[-3])
    assert settled is not None
    core = settled["picks"]["core"]
    assert [p["code"] for p in core] == ["510300"]  # 节点持仓, 每日沿用
    assert "core8_hold" in core[0]["reason"]["flags"]
    assert core[0]["reason_text"].startswith("策略第1")
    assert core[0]["next_return"] == pytest.approx(0.003)  # 信号日收盘 → 次日收盘
    assert settled["evaluation"]["core_holdings"]["mean"] == pytest.approx(0.003)
    assert settled["core_mean"] == pytest.approx(0.003)
    assert "core_holdings_picks" not in settled["evaluation"]  # 逐笔明细已拆到 pick 表

    last = store.get_day(conn, days[-1])
    assert last is not None
    assert last["evaluation"].get("skipped")  # 最后一个信号日无下一交易日
    assert all(p["next_return"] is None for p in last["picks"]["core"])


def test_rebuild_is_idempotent() -> None:
    conn = get_conn()
    days = _seed(conn)

    _rebuild_last3(conn, days)
    _rebuild_last3(conn, days)

    rows = store.list_days(conn)
    assert len(rows) == 3
    n = conn.execute("SELECT COUNT(*) AS n FROM fitted_daily_pick").fetchone()["n"]
    details = [store.get_day(conn, d) for d in days[-3:]]
    assert n == sum(len(r["picks"]["core"]) + len(r["picks"]["baseline"]) for r in details if r)


def test_all_picks_filters_unsettled_returns() -> None:
    conn = get_conn()
    days = _seed(conn)
    _rebuild_last3(conn, days)

    settled = store.all_picks(conn, "core")
    assert [p["signal_date"] for p in settled] == days[-3:-1]
    assert all(p["next_return"] is not None for p in settled)
    with_unsettled = store.all_picks(conn, "core", require_return=False)
    assert [p["signal_date"] for p in with_unsettled] == days[-3:]


def test_migration_renames_legacy_rule_columns() -> None:
    """旧 daily-v1 库的 rule_* 列要能原地改名, 不要求重建整表。"""
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    conn.executescript(
        """
        CREATE TABLE fitted_daily_summary (
            signal_date TEXT PRIMARY KEY, rule_mean REAL, rule_median REAL, rule_hit REAL
        );
        """
    )

    store.ensure_schema(conn)

    cols = {r["name"] for r in conn.execute("PRAGMA table_info(fitted_daily_summary)")}
    assert {"core_mean", "core_median", "core_hit"} <= cols
    assert not {"rule_mean", "rule_median", "rule_hit"} & cols


def test_attribution_overall_has_turnover_hs300_and_compound() -> None:
    conn = get_conn()
    days = _seed(conn)
    _rebuild_last3(conn, days)

    data = attribution.build(conn)

    assert set(data) == {"days", "cumulative", "overall"}
    assert len(data["cumulative"]) == 3
    overall = data["overall"]
    assert overall["days"] == 2  # 只有可结算的信号日进入总体统计
    for key in ("core", "baseline", "universe", "hs300"):
        assert {"mean", "cumulative", "positive"} <= set(overall[key])
    assert overall["core"]["cumulative"] == pytest.approx(1.003**2 - 1)
    assert overall["hs300"]["cumulative"] == pytest.approx(1.001**2 - 1)
    assert overall["turnover_avg"] == 0.0  # 三日持仓由同一节点延续, 日换手为 0

    last_point = data["cumulative"][-1]
    assert last_point["core"] is None  # 未结算日不进累计复利


def test_attribution_turnover_counts_membership_changes() -> None:
    series = [
        {"signal_date": f"2024-01-0{i}", "core": 0.01, "baseline": 0.01, "universe": 0.01, "rank_ic": 0.1, "hs300": 0.0}
        for i in range(1, 4)
    ]
    picks = [
        {"signal_date": "2024-01-01", "code": "A"},
        {"signal_date": "2024-01-01", "code": "B"},
        {"signal_date": "2024-01-02", "code": "A"},
        {"signal_date": "2024-01-02", "code": "C"},
        {"signal_date": "2024-01-03", "code": "C"},
        {"signal_date": "2024-01-03", "code": "D"},
    ]

    overall = attribution._overall(series, picks)

    assert overall["turnover_avg"] == pytest.approx(0.5)  # 每天换掉 2 只中的 1 只


def _gate_days(dates: list[str]) -> list[dict]:
    return [
        {
            "signal_date": dates[5],
            "next_signal": dates[6],
            "core": 0.10,
            "baseline": 0.05,
            "universe": 0.03,
            "rank_ic": 0.1,
            "hs300": 0.01,
        },
        {
            "signal_date": dates[275],
            "next_signal": dates[276],
            "core": -0.20,
            "baseline": 0.0,
            "universe": 0.01,
            "rank_ic": -0.2,
            "hs300": -0.01,
        },
        {
            "signal_date": dates[290],
            "next_signal": dates[291],
            "core": 0.25,
            "baseline": 0.0,
            "universe": 0.0,
            "rank_ic": 0.0,
            "hs300": 0.0,
        },
    ]


def test_gate_states_use_signal_date_close_against_ma250() -> None:
    dates = _weekdays(300)
    closes = [100.0] * 260 + [120.0] * 20 + [90.0] * 20
    days = _gate_days(dates)

    states = attribution._gate_states(dates, closes, days)

    assert states == [None, "above", "below"]  # 年线未热身/站上/跌破


def test_gated_curve_skips_days_when_gate_is_off() -> None:
    days = _gate_days(_weekdays(300))
    points = attribution._compound(days, ["above", "below", "above"])

    assert points[0]["gated"] == pytest.approx(0.10)
    assert points[1]["gated"] == pytest.approx(0.10)  # 开关下方空仓, 不承受 -20%
    assert points[2]["gated"] == pytest.approx(1.10 * 1.25 - 1)
    assert points[2]["core"] == pytest.approx(1.10 * 0.80 * 1.25 - 1)
    assert points[1]["gate"] == "below"


def test_overall_reports_gated_cumulative_and_day_counts() -> None:
    days = _gate_days(_weekdays(300))
    overall = attribution._overall(days, [], ["above", "below", "above"])

    assert overall["gated_cumulative"] == pytest.approx(1.10 * 1.25 - 1)
    assert overall["gate_on_days"] == 2
    assert overall["gate_off_days"] == 1
    assert overall["core"]["cumulative"] == pytest.approx(1.10 * 0.80 * 1.25 - 1)


def test_attribution_gate_keys_none_when_ma_not_warmed_up() -> None:
    """80 根指数日线不足年线热身: 开关全空, 累计曲线无 gated 点, 统计记 0/None。"""
    conn = get_conn()
    days = _seed(conn)
    _rebuild_last3(conn, days)

    data = attribution.build(conn)

    assert all(p["gate"] is None for p in data["cumulative"])
    assert all(p["gated"] is None for p in data["cumulative"])
    assert data["overall"]["gate_on_days"] == 0
    assert data["overall"]["gate_off_days"] == 0
    assert data["overall"]["gated_cumulative"] is None
