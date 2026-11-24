"""清单、K 线与份额查询接口（只读）。"""

from __future__ import annotations

from datetime import datetime
from typing import Any, Optional

from fastapi import APIRouter, HTTPException, Query

from data.fetch import realtime
from data.store import calendar_repo, daily_repo, etf_repo, shares_repo
from services.kline import aggregate
from services.kline import macd as macd_mod
from services.kline import states as state_mod

router = APIRouter(prefix="/api/etfs", tags=["etfs"])

# 周/月K与MACD预热都基于完整日线重采样, 只取最近窗口展示。
MAX_DAILY_ROWS = 6000
MAX_QUOTE_CODES = 100


def _all_bars(code: str) -> list[dict[str, Any]]:
    rows = daily_repo.history(code, MAX_DAILY_ROWS)
    if not rows:
        raise HTTPException(status_code=404, detail=f"{code} 无K线数据")
    return rows


def _period_bars(rows: list[dict[str, Any]], period: str) -> list[dict[str, Any]]:
    return macd_mod.attach(aggregate.resample(rows, period))


@router.get("")
def list_etfs() -> list[dict]:
    """全量清单 + 每只标的 K线/份额覆盖状态。"""
    return etf_repo.list_with_coverage()


def _is_trading_session() -> bool:
    """交易时段判定; 有交易日历时排除法定节假日, 空库退化为纯时钟判断。"""
    if not realtime.is_trading_time():
        return False
    today = datetime.now().strftime("%Y-%m-%d")
    last = calendar_repo.last_trading_day(today)
    return last is None or last == today


@router.get("/quotes")
def etf_quotes(codes: str = Query(default="")) -> dict[str, Any]:
    """批量实时行情(腾讯二级市场现价, 不是 IOPV 参考净值)。"""
    wanted = [code.strip() for code in codes.split(",") if code.strip()]
    if not wanted:
        raise HTTPException(status_code=400, detail="codes 不能为空")
    if len(wanted) > MAX_QUOTE_CODES:
        raise HTTPException(status_code=400, detail=f"单次最多查询 {MAX_QUOTE_CODES} 只")
    return {
        "as_of": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "is_trading": _is_trading_session(),
        "quotes": realtime.fetch_quotes(wanted),
    }


@router.get("/{code}/history")
def etf_history(code: str, limit: int = Query(default=800, ge=1, le=6000)) -> dict:
    rows = daily_repo.history(code, limit)
    if not rows:
        raise HTTPException(status_code=404, detail=f"{code} 无K线数据")
    return {"code": code, "rows": rows}


def _live_bar(code: str) -> dict[str, Any] | None:
    """用实时行情合成当日未收盘日K; 取不到行情或现价无效返回 None。"""
    quote = realtime.fetch_quotes([code]).get(code)
    if quote is None:
        return None
    stamp = quote.get("time")
    price = quote.get("price")
    if not isinstance(stamp, str) or len(stamp) < 10 or not isinstance(price, float) or price <= 0:
        return None

    def _num(key: str, fallback: float) -> float:
        value = quote.get(key)
        return value if isinstance(value, float) and value > 0 else fallback

    return {
        "date": stamp[:10],
        "open": _num("open", price),
        "close": price,
        "high": _num("high", price),
        "low": _num("low", price),
        "volume": _num("volume", 0.0),
    }


def _with_live_bar(code: str, rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """追加当日实时K线(库里已有当日K线或行情不可用时原样返回)。"""
    bar = _live_bar(code)
    if bar is None or (rows and str(rows[-1]["date"]) >= bar["date"]):
        return rows
    return [*rows, bar]


@router.get("/{code}/kline")
def etf_kline(
    code: str,
    period: str = Query(default="day"),
    limit: int = Query(default=750, ge=1, le=6000),
    live: bool = Query(default=False),
    end: Optional[str] = Query(default=None, pattern=r"^\d{4}-\d{2}-\d{2}$"),  # noqa: UP045 — py3.9 运行时无法解析 `X | None`
) -> dict:
    """指定周期K线 + MACD; MACD 在全历史上计算后再截取展示窗口, 避免窗口起点失真。

    end 给定时只保留该日及之前的行(含 MACD 预热), 供节点展开查看历史节点附近的走势。
    """
    if period not in aggregate.PERIODS:
        raise HTTPException(status_code=400, detail=f"period 仅支持 {aggregate.PERIODS}")
    rows = _all_bars(code)
    if end and end < rows[-1]["date"]:
        live = False
    if live and period == "day":
        rows = _with_live_bar(code, rows)
    if end:
        rows = [r for r in rows if r["date"] <= end]
    bars = _period_bars(rows, period)
    return {
        "code": code,
        "period": period,
        "bars": bars[-limit:],
        "state": state_mod.latest(bars, period),
    }


@router.get("/{code}/macd-states")
def etf_macd_states(code: str) -> dict:
    """当日/当周/当月的 MACD 收敛扩散与水上水下状态(周线跳过未确认的当周)。"""
    rows = _all_bars(code)
    states = {period: state_mod.latest(_period_bars(rows, period), period) for period in aggregate.PERIODS}
    return {"code": code, "states": states}


@router.get("/{code}/shares")
def etf_shares(code: str, limit: int = Query(default=2000, ge=1, le=5000)) -> dict:
    rows = shares_repo.history(code, limit)
    if not rows:
        raise HTTPException(status_code=404, detail=f"{code} 无份额数据")
    return {"code": code, "rows": rows}
