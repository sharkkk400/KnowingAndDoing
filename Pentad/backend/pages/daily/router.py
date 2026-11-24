"""日度复盘接口: 每个交易日的 ETF 入选、次日收益与频率对照归因。"""

from __future__ import annotations

import contextlib
from datetime import datetime
from typing import Any, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from data.store.database import get_conn
from ops import core_backfill
from ops.background import ProgressFn, TaskBusy, TaskRunner, WorkFn
from pages.daily import nodes
from pages.daily.live import context, preview
from pages.daily.review import attribution, build, store
from pages.daily.screen import cache
from services.scoring.core import store as core_store

router = APIRouter(prefix="/api/dailypick", tags=["dailypick"])

_TASKS = TaskRunner()
RECORDS = "records"
CORE = "core"


class RebuildRequest(BaseModel):
    start_date: Optional[str] = None  # noqa: UP045 — pydantic v2 + py3.9 运行时无法解析 `X | None`
    end_date: Optional[str] = None  # noqa: UP045


def _lite(day: dict[str, Any]) -> dict[str, Any]:
    return {
        "signal_date": day["signal_date"],
        "next_signal": day["next_signal"],
        "scored": day["scored"],
        "universe_mean": day["universe_mean"],
        "universe_hit": day["universe_hit"],
        "baseline_mean": day["baseline_mean"],
        "baseline_hit": day["baseline_hit"],
        "core_mean": day["core_mean"],
        "core_hit": day["core_hit"],
        "rank_ic": day["rank_ic"],
    }


@router.get("/days")
def days(start: Optional[str] = None, end: Optional[str] = None) -> list[dict[str, Any]]:  # noqa: UP045
    conn = get_conn()
    store.ensure_schema(conn)
    return [_lite(d) for d in store.list_days(conn, start, end)]


@router.get("/days/{signal_date}")
def day_detail(signal_date: str) -> dict[str, Any]:
    conn = get_conn()
    store.ensure_schema(conn)
    data = store.get_day(conn, signal_date)
    if data is None:
        raise HTTPException(status_code=404, detail=f"{signal_date} 尚无日度记录, 请先运行重算")
    return data


@router.get("/days/{signal_date}/screen")
def day_screen(signal_date: str) -> dict[str, Any]:
    """筛选漏斗 + 全量排名: 逐级展示当日 ETF 如何在每一级被筛掉, 以及评分明细。"""
    conn = get_conn()
    store.ensure_schema(conn)
    core_store.ensure_schema(conn)
    try:
        return cache.build_cached(conn, signal_date)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


def _closed_today(conn: Any) -> dict[str, Any] | None:
    """今日已有收盘记录时返回它(带 live=False 标记), 盘中预演让位正式记录。"""
    today = datetime.now().strftime("%Y-%m-%d")
    existing = store.get_day(conn, today)
    if existing is not None and (existing.get("scored") or 0) > 0:
        return {**existing, "live": False, "reason": "今日已有收盘记录"}
    return None


@router.get("/live")
def live_day() -> dict[str, Any]:
    """今日盘中预演(轻量): 目标持仓 + 当前持仓 + 元信息; 实时现价合成今日K线, 不落库。"""
    conn = get_conn()
    store.ensure_schema(conn)
    core_store.ensure_schema(conn)
    closed = _closed_today(conn)
    if closed is not None:
        return closed
    return preview.build_picks(conn, datetime.now().strftime("%Y-%m-%d"))


@router.get("/live/ranking")
def live_ranking() -> dict[str, Any]:
    """今日全量实时排名(约 3MB): 与收盘筛选同构, 10 分钟一批; 收盘后让位正式快照。"""
    conn = get_conn()
    store.ensure_schema(conn)
    core_store.ensure_schema(conn)
    closed = _closed_today(conn)
    if closed is not None:
        return closed
    return preview.build_ranking(conn, datetime.now().strftime("%Y-%m-%d"))


@router.post("/live/refresh")
def live_refresh() -> dict[str, Any]:
    """手动全量拉取: 清缓存立即重建, 返回实测行情拉取/评分耗时与排名行数。"""
    conn = get_conn()
    store.ensure_schema(conn)
    core_store.ensure_schema(conn)
    closed = _closed_today(conn)
    if closed is not None:
        return {"refreshed_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"), "picks": closed, "ranking_rows": 0}
    return preview.refresh(conn)


@router.get("/attribution")
def daily_attribution(
    start: Optional[str] = None,  # noqa: UP045
    end: Optional[str] = None,  # noqa: UP045
) -> dict[str, Any]:
    conn = get_conn()
    store.ensure_schema(conn)
    return attribution.build(conn, start, end)


def _warm_latest_screen() -> None:
    """重算会换掉 generated_at, 落盘筛选快照随之失效; 收尾顺手预热, 页面左卡打开即出。"""
    with contextlib.suppress(Exception):  # 预热只影响首屏速度, 失败留给页面首次打开时重算
        cache.warm(get_conn())


def _records_work(req: RebuildRequest) -> WorkFn:
    """日度记录重算: 连接必须在后台线程内取(每线程一条 SQLite 连接)。"""

    def work(progress: ProgressFn) -> dict[str, Any]:
        return build.rebuild(
            get_conn(),
            start_date=req.start_date or build.DEFAULT_START,
            end_date=req.end_date or datetime.now().strftime("%Y-%m-%d"),
            on_progress=progress,
        )

    return work


def _core_work(req: RebuildRequest) -> WorkFn:
    """换仓节点回填: 同上, 连接在后台线程内取。"""

    def work(progress: ProgressFn) -> dict[str, Any]:
        return core_backfill.rebuild(
            get_conn(),
            start=req.start_date,
            end=req.end_date or datetime.now().strftime("%Y-%m-%d"),
            on_progress=progress,
        )

    return work


@router.post("/rebuild")
def rebuild(req: RebuildRequest) -> dict[str, Any]:
    try:
        return _TASKS.start(RECORDS, _records_work(req), on_finished=_warm_latest_screen)
    except TaskBusy as error:
        raise HTTPException(status_code=409, detail="日度记录正在重算") from error


@router.get("/status")
def rebuild_status() -> dict[str, Any]:
    return _TASKS.status(RECORDS)


@router.get("/core")
def core_snapshot(date: Optional[str] = None) -> dict[str, Any]:  # noqa: UP045
    """该日所属的换仓节点: 间隔期内沿用上一节点持仓, 不按当日排名重排。"""
    conn = get_conn()
    core_store.ensure_schema(conn)
    target = date or datetime.now().strftime("%Y-%m-%d")
    signal = core_store.node_at(conn, target)
    data = core_store.get_node(conn, signal) if signal else None
    if data is None:
        raise HTTPException(status_code=404, detail="尚无 core8 换仓节点, 请先执行「回填换仓节点」")
    closes = context.node_closes(conn, data.get("signal_date"), [p["code"] for p in data["holdings"]])
    holdings = [{**p, "node_close": closes.get(p["code"])} for p in data["holdings"]]
    return {**data, "holdings": holdings, "requested_date": target, "held_codes": [p["code"] for p in holdings]}


@router.get("/nodes")
def node_list(
    start: Optional[str] = None,  # noqa: UP045
    end: Optional[str] = None,  # noqa: UP045
) -> list[dict[str, Any]]:
    """换仓节点列表: 每个节点的持仓、买卖计数与持有到下一节点的等权收益。"""
    conn = get_conn()
    core_store.ensure_schema(conn)
    return nodes.list_nodes(conn, start, end)


@router.get("/nodes/{signal}")
def node_detail(signal: str) -> dict[str, Any]:
    """单节点明细: 持仓/卖出/评分前 20 的当日价与区间收益。"""
    conn = get_conn()
    core_store.ensure_schema(conn)
    try:
        return nodes.detail(conn, signal)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e


@router.get("/timeline")
def holding_timeline(
    start: Optional[str] = None,  # noqa: UP045
    end: Optional[str] = None,  # noqa: UP045
) -> list[dict[str, Any]]:
    """持仓区间: 连续持有的节点合并为一段, 用来核对买入/持有/卖出节奏。"""
    conn = get_conn()
    core_store.ensure_schema(conn)
    return nodes.timeline(conn, start, end)


@router.post("/core/rebuild")
def core_rebuild(req: RebuildRequest) -> dict[str, Any]:
    try:
        return _TASKS.start(CORE, _core_work(req), on_finished=_warm_latest_screen)
    except TaskBusy as error:
        raise HTTPException(status_code=409, detail="core8 换仓节点正在回填") from error


@router.get("/core/status")
def core_status() -> dict[str, Any]:
    return _TASKS.status(CORE)
