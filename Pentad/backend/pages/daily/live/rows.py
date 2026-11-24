"""盘中实时全量排名行: 与收盘筛选(screen/rank.py)同构的行数据, 供今日页底部全量表复用同一组件。

只在盘中预演(live)时生成: 行情截至实时报价合成bar, 份额/基准截止上一交易日。
stage 语义与 screen 一致, 只是"信号日"换成今天——当日拿不到实时bar 的标的一律
no_bar(停牌/未更新/源端无数据), 不会被误标成"昨日有K线"。
"""

from __future__ import annotations

from typing import Any

from pages.daily.screen import rank as screen_rank
from services.scoring import features
from services.scoring.descriptors import themes
from services.scoring.reason import core8 as core_reason
from services.scoring.reason.ranking import reason_json, reason_text


def _quote(quote: dict[str, Any] | None) -> dict[str, Any] | None:
    """只把卡片/表格需要的三个行情字段带在行上; 时间必须是今日才有效。"""
    if not quote:
        return None
    stamp = str(quote.get("time") or "")
    return {"price": quote.get("price"), "pct": quote.get("pct"), "time": stamp or None}


def build_rows(
    meta: dict[str, Any],
    daily_all: dict[str, list[dict[str, Any]]],
    rows: list[dict[str, Any]],
    candidates: list[dict[str, Any]],
    scored: list[dict[str, Any]],
    held_codes: set[str],
    quotes: dict[str, dict[str, Any]],
    today: str,
) -> list[dict[str, Any]]:
    """全量行: 在册每只 ETF 一行, 排序与 screen 一致(综合分名次升序, 未评分排末尾)。"""
    feature_by_code = {r["code"]: r for r in rows}
    scored_codes = {r["code"] for r in candidates}
    core8 = {r["code"]: r for r in scored}
    baseline_sorted = sorted(candidates, key=lambda r: -r["baseline_score"])
    ranks = {r["code"]: i for i, r in enumerate(baseline_sorted, 1)}

    items: list[dict[str, Any]] = []
    for code, m in meta.items():
        bars = daily_all.get(code)
        row = feature_by_code.get(code)
        if m.get("fund_type") != features.DOMESTIC_EQUITY:
            stage = "non_equity"
        elif not features.is_a_share(m.get("name")):
            stage = "hk"
        elif not bars or bars[-1]["date"] != today:
            stage = "no_bar"
        elif row is None:
            stage = "short_history" if len(bars) < features.MIN_BARS else "bad_data"
        elif row["aum_yi"] is None:
            stage = "no_shares"
        elif code not in scored_codes:
            stage = "small_aum"
        else:
            stage = "core_hold" if code in held_codes else "core_pool"
        items.append(_row(code, m, bars, row, stage, ranks.get(code), core8.get(code), quotes.get(code), today))
    items.sort(key=lambda r: (r["rank"] is None, r["rank"] or 0, r["code"]))
    return items


def _row(
    code: str,
    meta: dict[str, Any],
    bars: list[dict[str, Any]] | None,
    row: dict[str, Any] | None,
    stage: str,
    rank: int | None,
    core8: dict[str, Any] | None,
    quote: dict[str, Any] | None,
    today: str,
) -> dict[str, Any]:
    item: dict[str, Any] = {
        "code": code,
        "name": meta.get("name"),
        "fund_type": meta.get("fund_type"),
        "theme": themes.theme_of(meta.get("name")),
        "stage": stage,
        "stage_text": screen_rank.STAGE_TEXT[stage],
        "last_bar": bars[-1]["date"] if bars else None,
        "bars": len(bars) if bars else 0,
        "rank": rank,
        "core8_rank": core8["core_rank"] if core8 else None,
        "core8_score": core8["core_score"] if core8 else None,
        "core_factors": core8.get("core_factors") if core8 else None,
        "reason": None,
        "reason_text": None,
        "quote": _quote(quote) if str((quote or {}).get("time") or "").startswith(today) else None,
    }
    if row is None or stage in {"non_equity", "hk", "no_bar", "short_history", "bad_data"}:
        return item
    flags = ["shrink_pullback"] if row.get("shrink_pullback") else []
    item["reason"] = reason_json({**row, "baseline_score": row.get("baseline_score")}, flags)
    if stage == "core_hold" and core8:
        held_row = {**row, "core_rank": core8["core_rank"], "core_score": core8["core_score"]}
        item["reason_text"] = core_reason.reason_text(held_row, core8["core_rank"], True)
    elif stage == "core_pool":
        item["reason_text"] = reason_text(row, rank or 0)
    return item
