"""DailyScope 后端入口: 原始数据 + 日度复盘接口。"""

from __future__ import annotations

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from data.store.database import get_conn
from ops import scheduler as refresh_scheduler
from pages.daily import router as dailypick_api
from pages.daily.review import store as daily_store
from pages.etf import router as etfs_api
from pages.jobs import readiness as dataset_api
from pages.jobs import router as data_api

app = FastAPI(title="DailyScope", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
def _init_db() -> None:
    daily_store.ensure_schema(get_conn())
    refresh_scheduler.start()


@app.on_event("shutdown")
def _stop_refresh() -> None:
    refresh_scheduler.stop()


@app.get("/api/health")
def health() -> dict:
    return {"ok": True}


app.include_router(etfs_api.router)
app.include_router(data_api.router)
app.include_router(dataset_api.router)
app.include_router(dailypick_api.router)
