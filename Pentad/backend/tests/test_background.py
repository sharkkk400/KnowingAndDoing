"""后台任务执行器: 状态流转、同 key 互斥与失败落状态。"""

from __future__ import annotations

import threading

import pytest

from ops.background import ProgressFn, TaskBusy, TaskRunner


def _wait_state(runner: TaskRunner, key: str, state: str) -> dict:
    """等后台线程把状态写到位(任务本身很短, 轮询几十毫秒即可)。"""
    for _ in range(200):
        status = runner.status(key)
        if status["state"] == state:
            return status
        threading.Event().wait(0.01)
    raise AssertionError(f"{key} 未进入 {state}, 当前 {runner.status(key)}")


def test_start_runs_work_and_records_result() -> None:
    runner = TaskRunner()
    finished = threading.Event()

    def work(progress: ProgressFn) -> dict:
        progress(1, 2, "半程")
        return {"days": 3}

    runner.start("records", work, on_finished=finished.set)

    status = _wait_state(runner, "records", "done")
    assert status["result"] == {"days": 3}
    assert finished.wait(1)
    assert runner.is_running("records") is False
    assert runner.status("records")["state"] == "done"


def test_same_key_cannot_run_twice() -> None:
    runner = TaskRunner()
    gate = threading.Event()
    runner.start("records", lambda progress: gate.wait(1) and {"ok": True})

    with pytest.raises(TaskBusy):
        runner.start("records", lambda progress: {"ok": True})

    gate.set()
    assert _wait_state(runner, "records", "done")["result"] == {"ok": True}


def test_failure_is_captured_in_status() -> None:
    runner = TaskRunner()

    def boom(progress: ProgressFn) -> dict:
        raise RuntimeError("数据库被锁")

    runner.start("core", boom)

    status = _wait_state(runner, "core", "failed")
    assert status["error"] == "数据库被锁"
    assert runner.status("unknown") == {"state": "idle"}
