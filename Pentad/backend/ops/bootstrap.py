"""空库一键数据准备: 按依赖顺序跑通「日度复盘」所需的全部数据。

顺序即依赖: 预热快照 → 清单 → 日历 → 日K → 指数 → 份额 → 折算甄别 → 换仓节点 → 日度记录。
每步都幂等, 中断后重跑只补缺失部分(限流导致日K未拉完时, 重启即可续跑);
后台线程执行, 状态由 /api/data/bootstrap 轮询。
"""

from __future__ import annotations

import threading
from datetime import datetime
from typing import Any, Callable

from data.store.database import get_conn
from ops import core_backfill, jobs, refresh_chain, seed
from pages.daily.review import build
from services.scoring import features
from services.scoring.core import rebalance
from services.scoring.core import score as core

Report = Callable[[int, int, str], None]
StageFn = Callable[[Report], str]

STAGE_LABELS = {
    "seed": "预热快照",
    "etf_list": "ETF 清单",
    "calendar": "交易日历",
    "daily": "日线行情",
    "index": "指数日线",
    "shares": "份额数据",
    "scale": "折算甄别",
    "core": "换仓节点",
    "records": "日度记录",
}

_LOCK = threading.Lock()
_STATE: dict[str, Any] = {}


def _now() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def _fresh_stages() -> list[dict[str, Any]]:
    return [
        {"key": key, "label": label, "state": "pending", "detail": None, "done": 0, "total": 0}
        for key, label in STAGE_LABELS.items()
    ]


def _copy() -> dict[str, Any]:
    return {**_STATE, "stages": [dict(s) for s in _STATE.get("stages", [])]}


def status() -> dict[str, Any]:
    with _LOCK:
        if not _STATE:
            return {
                "state": "idle",
                "stage": None,
                "percent": 0,
                "started_at": None,
                "finished_at": None,
                "error": None,
                "stages": _fresh_stages(),
            }
        return _copy()


def _percent() -> int:
    stages = _STATE.get("stages", [])
    done = sum(1 for s in stages if s["state"] in ("done", "skipped"))
    return round(done * 100 / len(stages)) if stages else 0


def _update(key: str, **fields: Any) -> None:
    with _LOCK:
        for stage in _STATE["stages"]:
            if stage["key"] == key:
                stage.update(fields)
        _STATE["stage"] = key
        _STATE["percent"] = _percent()


def _progress(key: str) -> Report:
    def report(done: int, total: int, msg: str) -> None:
        _update(key, done=done, total=total, detail=msg)

    return report


def _seed(report: Report) -> str:
    def cb(table: str, done: int, total: int) -> None:
        report(done, total, f"{table} {done}/{total} 行")

    result = seed.restore(get_conn(), on_rows=cb)
    if result.get("skipped"):
        return str(result["skipped"])
    return f"装载至 {result['cutoff']} · {int(result['rows'])} 行"


def _etf_list(_: Report) -> str:
    result = jobs.refresh_etf_list()
    if result.get("error"):
        raise RuntimeError(result["error"])
    if not result.get("total"):
        raise RuntimeError("ETF 清单为空, 请检查网络后重试")
    return f"{result['total']} 只(新增 {result.get('added', 0)})"


def _calendar(_: Report) -> str:
    result = jobs.refresh_calendar()
    if result.get("error"):
        raise RuntimeError(result["error"])
    return f"{result['days']} 个交易日"


def _daily(report: Report) -> str:
    result = jobs.backfill_daily(on_progress=report)
    if result.get("blocked"):
        raise RuntimeError("腾讯接口限流, 日K未拉完; 稍后重跑会从中断处继续")
    return f"{result['etfs']} 只 / {result['rows']} 根"


def _index(report: Report) -> str:
    result = jobs.backfill_index(on_progress=report)
    return f"{result['indices']} 个指数 / {result['rows']} 行"


def _shares(report: Report) -> str:
    result = jobs.backfill_shares(on_progress=report)
    return f"{result['days']} 个交易日 / {result['rows']} 行"


def _scale(report: Report) -> str:
    result = jobs.detect_share_conversions(on_progress=report)
    unknown = result["no_history"] + result["unknown"]
    return f"折算 {result['split']} / 申赎 {result['flow']} / 无法判定 {unknown}"


def _last_bar(conn: Any) -> str | None:
    row = conn.execute("SELECT MAX(date) FROM etf_daily").fetchone()
    return row[0] if row and row[0] else None


def _core_start(conn: Any) -> str | None:
    """快照已带节点时从最后节点次日起算; 空白库仍从锚点走全程。"""
    row = conn.execute("SELECT MAX(signal_date) FROM fitted_core_summary").fetchone()
    last = row[0] if row and row[0] else None
    if not last:
        return core.CORE_ANCHOR
    nxt = conn.execute("SELECT MIN(date) FROM trade_calendar WHERE date > ?", (last,)).fetchone()
    return nxt[0] if nxt and nxt[0] else None


def _core(report: Report) -> str:
    conn = get_conn()
    last_bar = _last_bar(conn)
    calendar = features.trading_days(conn)
    start = _core_start(conn)
    if not last_bar or not calendar or start is None:
        return "尚无行情, 跳过换仓节点"
    nodes = rebalance.rebalance_nodes(calendar, core.CORE_ANCHOR, last_bar)
    if not nodes or nodes[-1] < start:
        return "换仓节点已最新"
    result = core_backfill.rebuild(conn, start=start, end=last_bar, on_progress=report)
    span = f"{result.get('start')} ~ {result.get('end')}" if result.get("written") else "无新节点"
    return f"{result.get('written', 0)} 个换仓节点({span})"


def _records(report: Report) -> str:
    conn = get_conn()
    calendar = features.trading_days(conn)
    last_bar = _last_bar(conn)
    if not calendar or not last_bar:
        raise RuntimeError("尚无行情, 请先回填日K")
    start = refresh_chain.records_start(conn, calendar, last_bar)
    if start is None:
        return "无新交易日"
    result = build.rebuild(conn, start_date=start, end_date=last_bar, on_progress=report)
    return f"{result.get('days', 0)} 个交易日({start} ~ {last_bar})"


STAGE_FNS: dict[str, StageFn] = {
    "seed": _seed,
    "etf_list": _etf_list,
    "calendar": _calendar,
    "daily": _daily,
    "index": _index,
    "shares": _shares,
    "scale": _scale,
    "core": _core,
    "records": _records,
}


def _run() -> None:
    for key in STAGE_LABELS:
        _update(key, state="running", detail="执行中")
        try:
            detail = STAGE_FNS[key](_progress(key))
        except Exception as e:  # noqa: BLE001 - 失败要落状态给页面, 而不是丢进后台线程
            _update(key, state="failed", detail=str(e))
            with _LOCK:
                _STATE.update(state="failed", error=str(e), finished_at=_now())
            return
        _update(key, state="done", detail=detail)
    with _LOCK:
        _STATE.update(state="done", stage=None, finished_at=_now())


def start() -> dict[str, Any]:
    """后台启动一键准备; 已在运行时返回当前状态而不是重复启动。"""
    with _LOCK:
        if _STATE.get("state") == "running":
            return _copy()
        _STATE.clear()
        _STATE.update(
            state="running",
            stage=None,
            percent=0,
            started_at=_now(),
            finished_at=None,
            error=None,
            stages=_fresh_stages(),
        )
        threading.Thread(target=_run, name="dailyscope-bootstrap", daemon=True).start()
        return _copy()
