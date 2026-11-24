"""收盘自动刷新链的调度器: 槽位时刻、失败重试与运行时状态。

手动按钮仍是权威入口, 这里只回答"什么时刻跑哪条链"; 链的具体步骤(均幂等)在
ops/refresh_chain 里:
- 18:30 主链: 日K增量 → 指数补抓 → 份额补缺 → core8 节点 → 日度记录。
- 22:30 补一趟, 主要等中证指数当晚发布。
- 次日 00:20 份额链: 交易所份额 T+1 发布(00:00 之后), 强制重拉最近 4 个交易日,
  先补算前一晚用 T-1 份额建出的最新节点(完整排名定下开盘补买/顺延卖), 再重算最近
  交易日的日度记录, 让快照落到"份额已完整"的终态。收盘主链也会兜底补算一次。

任何一步失败都不推进"今晚已完成"标记, 冷却 30 分钟后重试; 重试 3 次仍失败则
放弃当晚(下一槽位的链会自然补上)。网抓全程受 kline 请求级节流, 主链约 10 分钟。
"""

from __future__ import annotations

import threading
import time
from datetime import datetime, timedelta
from typing import Any

from ops import refresh_chain

# 00:20 份额回补(T+1 数据 00:00 后才发布); 18:30 收盘主链; 22:30 等中证指数。
RUN_SLOTS = (("shares", (0, 20)), ("close", (18, 30)), ("late", (22, 30)))
CHECK_INTERVAL_SEC = 60
RETRY_COOLDOWN_SEC = 30 * 60
MAX_ATTEMPTS_PER_SLOT = 3

_STATE_LOCK = threading.Lock()
_CHAIN_LOCK = threading.Lock()
_STOP = threading.Event()
_STARTED = False
_DONE: dict[str, str] = {}
_ATTEMPTS: dict[str, int] = {}
_COOLDOWN_UNTIL: dict[str, float] = {}
_STATE: dict[str, Any] = {
    "state": "idle",
    "slot": None,
    "stage": None,
    "signal_date": None,
    "started_at": None,
    "finished_at": None,
    "detail": None,
    "next_run": None,
}


def _set(**fields: Any) -> None:
    with _STATE_LOCK:
        _STATE.update(fields)


def status() -> dict[str, Any]:
    with _STATE_LOCK:
        data = dict(_STATE)
        data["done"] = dict(_DONE)
    return data


def _stamp(now: datetime) -> str:
    return now.strftime("%Y-%m-%d %H:%M:%S")


def _report(stage: str | None, detail: str | None = None) -> None:
    """刷新链的运行阶段回调: 每步开始/结束时更新对外状态。"""
    _set(stage=stage, detail=detail)


def _chain(slot: str) -> dict[str, Any]:
    return refresh_chain.shares_chain(_report) if slot == "shares" else refresh_chain.close_chain(_report)


def run_chain(slot: str = "manual") -> dict[str, Any]:
    """同步跑对应槽位的链(供调度线程使用); 状态写入模块级 _STATE 供接口查询。"""
    now = datetime.now()
    with _CHAIN_LOCK:
        _set(
            state="running",
            slot=slot,
            stage="starting",
            started_at=_stamp(now),
            finished_at=None,
            detail=None,
        )
        try:
            result = _chain(slot)
        except Exception as e:  # noqa: BLE001 - 后台失败要落状态, 由重试机制兜底
            _set(state="failed", stage=None, detail=str(e), finished_at=_stamp(datetime.now()))
            raise
        signal_date = result.get("last_bar") or _STATE["signal_date"]
        _set(
            state="skipped" if result.get("skipped") else "done",
            stage=None,
            signal_date=signal_date,
            detail=str(result),
            finished_at=_stamp(datetime.now()),
        )
        return result


def _slot_key(today: str, slot: str) -> str:
    return f"{today}:{slot}"


def _due_slot(now: datetime) -> str | None:
    """当前时刻应执行、且今晚还没成功的槽位; 早于第一个槽位返回 None。"""
    today = now.strftime("%Y-%m-%d")
    for slot, (hour, minute) in RUN_SLOTS:
        if now.hour < hour or (now.hour == hour and now.minute < minute):
            return None
        if _DONE.get(slot) != today:
            return slot
    return None


def _next_run(now: datetime) -> str:
    for _, (hour, minute) in RUN_SLOTS:
        target = now.replace(hour=hour, minute=minute, second=0, microsecond=0)
        if target > now:
            return _stamp(target)
    first = (now + timedelta(days=1)).replace(hour=RUN_SLOTS[0][1][0], minute=RUN_SLOTS[0][1][1], second=0)
    return _stamp(first)


def _mark_done(slot: str, today: str) -> None:
    with _STATE_LOCK:
        _DONE[slot] = today


def _manual_bootstrap_running() -> bool:
    """手动「一键准备」是空库初始化/全量补数的权威入口, 运行期间自动链让路。

    两套全量拉取并发会重复请求并放大限流风险; 让路不丢事: 准备结束后下一个 tick
    仍会发现槽位未完成, 自动链再按增量补一遍即可。
    """
    from ops import bootstrap  # 延迟导入: 页面域反向依赖调度器, 模块级导入容易成环

    return bool(bootstrap.status()["state"] == "running")


def _tick(now: datetime) -> None:
    _set(next_run=_next_run(now))
    if _manual_bootstrap_running():
        return
    slot = _due_slot(now)
    if slot is None:
        return
    # 周末不抓行情; 但周五份额周六凌晨才发布, 周六的份额槽位照常跑一趟。
    if now.weekday() >= 5 and not (slot == "shares" and now.weekday() == 5):
        return
    today = now.strftime("%Y-%m-%d")
    key = _slot_key(today, slot)
    if _ATTEMPTS.get(key, 0) >= MAX_ATTEMPTS_PER_SLOT:
        _mark_done(slot, today)
        return
    if _COOLDOWN_UNTIL.get(key, 0) > time.time():
        return
    try:
        run_chain(slot)
        _mark_done(slot, today)
    except Exception:  # noqa: BLE001 - 单晚失败不终止调度线程
        _ATTEMPTS[key] = _ATTEMPTS.get(key, 0) + 1
        _COOLDOWN_UNTIL[key] = time.time() + RETRY_COOLDOWN_SEC


def _loop() -> None:
    while not _STOP.is_set():
        try:
            _tick(datetime.now())
        except Exception as e:  # noqa: BLE001 - 调度线程必须存活到下一次 tick
            _set(state="failed", detail=f"调度异常: {e}")
        _STOP.wait(CHECK_INTERVAL_SEC)


def start() -> None:
    """FastAPI 启动时调用; 重复调用只起一个线程。"""
    global _STARTED
    if _STARTED:
        return
    _STARTED = True
    threading.Thread(target=_loop, name="daily-refresh", daemon=True).start()


def stop() -> None:
    global _STARTED
    _STOP.set()
    _STARTED = False
