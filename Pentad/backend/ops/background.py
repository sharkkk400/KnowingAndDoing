"""后台任务执行器: 线程、运行状态与进度, 供各页面的 HTTP 接口复用。

任务函数必须在后台线程里自行取 SQLite 连接(连接是按线程缓存的, 见
data.store.database); 调用方只负责提交任务与轮询状态。同一 key 同时只允许一个
任务运行, 冲突由接口层转成 409。
"""

from __future__ import annotations

import threading
from collections.abc import Callable
from typing import Any

ProgressFn = Callable[[int, int, str], None]
WorkFn = Callable[[ProgressFn], Any]


class TaskBusy(RuntimeError):
    """同一任务已在运行, 接口层据此返回 409。"""

    def __init__(self, key: str) -> None:
        super().__init__(key)
        self.key = key


class TaskRunner:
    """{key: 任务状态} 的轻量注册表: 启动即返回, 结果/错误落在状态里。"""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._status: dict[str, dict[str, Any]] = {}

    def status(self, key: str) -> dict[str, Any]:
        with self._lock:
            return dict(self._status.get(key) or {"state": "idle"})

    def statuses(self) -> dict[str, dict[str, Any]]:
        with self._lock:
            return {key: dict(value) for key, value in self._status.items()}

    def is_running(self, key: str) -> bool:
        with self._lock:
            return self._status.get(key, {}).get("state") == "running"

    def running_keys(self) -> list[str]:
        with self._lock:
            return [key for key, value in self._status.items() if value.get("state") == "running"]

    def start(
        self,
        key: str,
        work: WorkFn,
        *,
        on_finished: Callable[[], None] | None = None,
    ) -> dict[str, Any]:
        """提交任务; 已在运行时抛 TaskBusy。on_finished 在任务成功/失败后都会执行。"""
        with self._lock:
            if self._status.get(key, {}).get("state") == "running":
                raise TaskBusy(key)
            self._status[key] = {"state": "running", "done": 0, "total": 0, "msg": "启动中"}

        def progress(done: int, total: int, msg: str) -> None:
            self._set(key, {"state": "running", "done": done, "total": total, "msg": msg})

        def run() -> None:
            try:
                result = work(progress)
                self._set(key, {"state": "done", "result": result})
            except Exception as error:  # noqa: BLE001 - 后台任务失败要落状态而不是炸掉线程
                self._set(key, {"state": "failed", "error": str(error)})
            finally:
                if on_finished is not None:
                    on_finished()

        threading.Thread(target=run, daemon=True, name=f"task-{key}").start()
        return {"state": "running"}

    def _set(self, key: str, fields: dict[str, Any]) -> None:
        with self._lock:
            self._status[key] = fields
