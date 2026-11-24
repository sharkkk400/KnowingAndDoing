"""Jobs 页的 /api/data 出口：后台线程执行回填, 同一任务同时只跑一个实例。

除单个任务外, 提供「一键准备」: 空库按依赖顺序跑通日度复盘所需全部数据。
"""

from __future__ import annotations

from typing import Any, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from ops import bootstrap, jobs, scheduler
from ops.background import ProgressFn, TaskBusy, TaskRunner, WorkFn

router = APIRouter(prefix="/api/data", tags=["data"])

_TASKS = TaskRunner()


class JobRequest(BaseModel):
    job: str
    start_date: Optional[str] = None  # noqa: UP045 — pydantic v2 + py3.9 无法在运行时解析 `X | None`
    end_date: Optional[str] = None  # noqa: UP045


def _work(name: str) -> WorkFn:
    def run(progress: ProgressFn) -> dict:
        return jobs.run_job(name, on_progress=progress)

    return run


@router.post("/jobs")
def start_job(req: JobRequest) -> dict:
    if req.job not in jobs.JOB_FNS:
        raise HTTPException(status_code=400, detail=f"未知任务 {req.job}, 可选: {sorted(jobs.JOB_FNS)}")
    if bootstrap.status()["state"] == "running":
        raise HTTPException(status_code=409, detail="一键准备正在运行, 请等待完成后再单独执行任务")
    try:
        _TASKS.start(req.job, _work(req.job))
    except TaskBusy as error:
        raise HTTPException(status_code=409, detail=f"{req.job} 正在运行") from error
    return {"job": req.job, "state": "running"}


@router.get("/jobs")
def list_jobs() -> dict[str, dict[str, Any]]:
    return _TASKS.statuses()


@router.get("/scheduler")
def scheduler_status() -> dict[str, Any]:
    """收盘自动刷新链的状态: 当前阶段、今晚完成的槽位与下次执行时间。"""
    return scheduler.status()


@router.post("/bootstrap")
def start_bootstrap() -> dict[str, Any]:
    """一键准备: 空库也能从零拉齐日度复盘所需数据(幂等, 重复执行只补缺口)。"""
    busy = _TASKS.running_keys()
    if busy:
        raise HTTPException(status_code=409, detail=f"任务 {busy[0]} 正在运行, 请等待完成后再一键准备")
    return bootstrap.start()


@router.get("/bootstrap")
def bootstrap_status() -> dict[str, Any]:
    """一键准备进度: 各阶段状态/进度与整体百分比。"""
    return bootstrap.status()
