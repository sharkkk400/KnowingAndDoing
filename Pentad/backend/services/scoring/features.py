"""周度截面特征：只使用 signal_date 及之前的数据构造 AI 分析上下文。

防后视镜边界:
1) 标的池 = signal_date 当日真有 K 线的 ETF, 未来上市标的不会出现;
2) 只输出收益/比率类特征, 不把绝对 qfq 价位当作"当时已知信息";
3) 份额取 <= signal_date 的最后一条, 缺失即 None, 不用未来值回填;
4) 本模块不读取任何 signal_date 之后的行, 评估逻辑单独放在 evaluate.py。
"""

from __future__ import annotations

import math
import sqlite3
import statistics
from typing import Any

from services.kline import states as macd_states
from services.scoring.descriptors import factors, profile, scale

DOMESTIC_EQUITY = "指数型-股票"
# 底层含港股的产品仍被数据源记为"指数型-股票", 但交易时段/汇率/估值体系不同, 不进 A 股周度池
HK_NAME_HINTS = ("港股", "恒生", "恒指", "香港", "H股", "沪港深", "沪深港", "AH")
MIN_BARS = 62
DEFAULT_MIN_AUM_YI = 2.0
HISTORY_DAYS = 270  # 交易日回溯, 覆盖 250 日(52 周)位置 + 60 日动量 + 缓冲
SHARES_HISTORY_DAYS = 40
FLOW_WINDOW = 6  # 5 日份额增速用 6 个点(首点为基期)

EXT_R20 = 0.25  # 20 日涨幅超过 25% 视为拥挤
EXT_R5 = 0.08  # 单周涨幅超过 8% 视为短期过热
EXT_FLOW = 0.50  # 5 日份额增长超过 50% 视为资金拥挤
EXT_VOL = 0.45  # 年化波动超过 45% 视为高波动
PULLBACK_R5_MIN = -0.08  # 近 5 日跌幅超过 8% 视为回调过深
PULLBACK_R5_MAX = 0.02  # 近 5 日涨幅超过 2% 视为未回调(追高)
TREND_WEIGHT = 0.60  # 趋势分占总分 60%: MACD 定方向, 多因子只做确认


def trading_days(conn: sqlite3.Connection) -> list[str]:
    return [r["date"] for r in conn.execute("SELECT date FROM trade_calendar ORDER BY date")]


def load_meta(conn: sqlite3.Connection) -> dict[str, dict[str, Any]]:
    return {r["code"]: dict(r) for r in conn.execute("SELECT code, name, fund_type FROM etfs")}


def is_a_share(name: str | None) -> bool:
    """名称未命中港股系关键词即视为 A 股底层; 无名称时保留, 不误杀。"""
    return name is None or not any(hint in name for hint in HK_NAME_HINTS)


def equity_a_share_codes(meta: dict[str, dict[str, Any]]) -> set[str]:
    """日度链路共用的标的池: 指数型-股票 且 A 股底层(剔除港股系)。"""
    return {
        code for code, info in meta.items() if info.get("fund_type") == DOMESTIC_EQUITY and is_a_share(info.get("name"))
    }


def is_candidate(row: dict[str, Any], min_aum: float = DEFAULT_MIN_AUM_YI) -> bool:
    """是否进入评分池: 指数型-股票、A 股底层、规模达标; 三条缺一不可。"""
    return row["fund_type"] == DOMESTIC_EQUITY and (row["aum_yi"] or 0) >= min_aum and is_a_share(row.get("name"))


def select_candidates(
    rows: list[dict[str, Any]],
    min_aum: float = DEFAULT_MIN_AUM_YI,
) -> list[dict[str, Any]]:
    """从特征行里挑出评分池; records/screen/live/core 四处必须同口径。"""
    return [row for row in rows if is_candidate(row, min_aum)]


def _load_by_code(conn: sqlite3.Connection, sql: str, start: str, end: str) -> dict[str, list[dict[str, Any]]]:
    result: dict[str, list[dict[str, Any]]] = {}
    for r in conn.execute(sql, (start, end)):
        result.setdefault(r["code"], []).append(dict(r))
    return result


def load_daily(conn: sqlite3.Connection, start: str, end: str) -> dict[str, list[dict[str, Any]]]:
    return _load_by_code(
        conn,
        "SELECT date, code, close, volume FROM etf_daily WHERE date BETWEEN ? AND ? ORDER BY code, date",
        start,
        end,
    )


def load_shares(conn: sqlite3.Connection, start: str, end: str) -> dict[str, list[dict[str, Any]]]:
    """读取份额并把已甄别的折算事件折算到最新口径(见 scale.py)。"""
    rows = _load_by_code(
        conn,
        "SELECT date, code, shares_yi FROM etf_shares WHERE date BETWEEN ? AND ? ORDER BY code, date",
        start,
        end,
    )
    events: dict[str, list[dict[str, Any]]] = {}
    for e in conn.execute("SELECT code, date, ratio, method FROM etf_share_scale WHERE date <= ?", (end,)):
        events.setdefault(e["code"], []).append(dict(e))
    for code, points in rows.items():
        scale.normalize(points, events.get(code, []))
    return rows


def load_index(conn: sqlite3.Connection, start: str, end: str) -> dict[str, list[dict[str, Any]]]:
    return _load_by_code(
        conn,
        "SELECT date, code, close FROM index_daily WHERE date BETWEEN ? AND ? ORDER BY code, date",
        start,
        end,
    )


def _ret(closes: list[float], n: int) -> float | None:
    if len(closes) <= n or closes[-1 - n] <= 0:
        return None
    return closes[-1] / closes[-1 - n] - 1


def _pct_change(values: list[float], n: int) -> float | None:
    if len(values) <= n or not values[-1 - n]:
        return None
    return values[-1] / values[-1 - n] - 1


def build_features(
    signal: str,
    meta: dict[str, dict[str, Any]],
    daily: dict[str, list[dict[str, Any]]],
    shares: dict[str, list[dict[str, Any]]],
    bench: dict[str, float] | None = None,
) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for code, bars in daily.items():
        if bars[-1]["date"] != signal or len(bars) < MIN_BARS:
            continue
        closes = [b["close"] for b in bars]
        volumes = [b["volume"] for b in bars]
        if any(c is None or c <= 0 for c in closes[-61:]) or any(v is None or v <= 0 for v in volumes[-20:]):
            continue
        rets = [closes[i] / closes[i - 1] - 1 for i in range(len(closes) - 20, len(closes))]
        pool = [s for s in shares.get(code, []) if s["date"] <= signal]
        shares_yi = shares_raw = flow = flow_raw = None
        suspect = False
        split_5d = 0
        # 份额更新通常滞后一天: 取 signal_date 及之前最后一条, 仍是"当时已知"的规模。
        if pool and pool[-1]["shares_yi"]:
            shares_yi, shares_raw = pool[-1]["shares_yi"], pool[-1].get("shares_raw")
            if len(pool) >= FLOW_WINDOW:
                window = pool[-FLOW_WINDOW:]
                flow = _pct_change([s["shares_yi"] for s in window], FLOW_WINDOW - 1)
                flow_raw = _pct_change([s.get("shares_raw") or s["shares_yi"] for s in window], FLOW_WINDOW - 1)
                suspect = scale.unverified_jump(window) is not None
                split_5d = scale.split_events(window)
        info = meta.get(code, {})
        r20 = _ret(closes, 20)
        rows.append(
            {
                "code": code,
                "name": info.get("name"),
                "fund_type": info.get("fund_type"),
                "close": closes[-1],
                "r5": _ret(closes, 5),
                "r20": r20,
                "r60": _ret(closes, 60),
                "vol20": statistics.pstdev(rets) * math.sqrt(252),
                "dd60": closes[-1] / max(closes[-60:]) - 1,
                "ma20_dev": closes[-1] / statistics.fmean(closes[-20:]) - 1,
                "ma60_dev": closes[-1] / statistics.fmean(closes[-60:]) - 1,
                "shares_yi": shares_yi,
                "shares_raw": shares_raw,
                "flow_5d": flow,
                "flow_5d_raw": flow_raw,
                "flow_suspect": suspect,
                "share_split_5d": split_5d,
                "aum_yi": closes[-1] * shares_yi if shares_yi else None,
                **profile.build(bars, pool, r20 or 0.0),
                **factors.build(bars, bench),
            }
        )
    return rows


def attach_macd(rows: list[dict[str, Any]], signal: str, provider: macd_states.MacdStateProvider) -> None:
    """给候选行补三周期 MACD 状态与趋势分; 只用 ≤ signal 的行情。"""
    for row in rows:
        states = provider.states(row["code"], signal, row["close"])
        row["macd_states"] = states
        row["trend_score"] = macd_states.trend_score(states)
        row["macd_weak"] = macd_weak(row)


def macd_weak(row: dict[str, Any]) -> bool:
    """日线在水下且走弱 = 趋势已破, 不再继续持有(供 AI 规则池补齐判断)。"""
    day = (row.get("macd_states") or {}).get("day") or {}
    return day.get("zone") == "below" and day.get("trend") == "falling"


def _z(values: list[float | None]) -> tuple[float, float]:
    clean = [v for v in values if v is not None and math.isfinite(v)]
    if len(clean) < 2:
        return 0.0, 1.0
    return statistics.fmean(clean), statistics.pstdev(clean) or 1e-9


def score(rows: list[dict[str, Any]]) -> None:
    """趋势主项 + 多因子确认: 综合分 = 0.6*趋势分 + 0.4*core。

    趋势分来自日/周/月 MACD 四象限(±1); core 是动量/资金/波动/规模的截面 z 组合。
    权重固定, 避免每周临时调参。未甄别的份额大跳变(可能是未识别的折算)不进入
    资金因子: 既不计自身的 z, 也不污染截面均值/方差。
    """
    flow_clean = [None if r.get("flow_suspect") else r["flow_5d"] for r in rows]
    stats = {
        "r20": _z([r["r20"] for r in rows]),
        "r60": _z([r["r60"] for r in rows]),
        "r5": _z([r["r5"] for r in rows]),
        "vol20": _z([r["vol20"] for r in rows]),
        "flow_5d": _z(flow_clean),
        "aum_yi": _z([r["aum_yi"] for r in rows]),
    }

    def z(key: str, value: float | None) -> float:
        mean, std = stats[key]
        return ((value if value is not None else mean) - mean) / std

    for r in rows:
        momentum = 0.67 * z("r20", r["r20"]) + 0.33 * z("r60", r["r60"])
        flow_z = 0.0 if r.get("flow_suspect") else z("flow_5d", r["flow_5d"])
        core = (
            0.50 * momentum
            - 0.20 * z("r5", r["r5"])
            - 0.10 * z("vol20", r["vol20"])
            + 0.15 * flow_z
            + 0.05 * z("aum_yi", r["aum_yi"])
        )
        r["core_score"] = round(core, 4)
        r["baseline_score"] = round(TREND_WEIGHT * (r.get("trend_score") or 0.0) + (1 - TREND_WEIGHT) * core, 4)
        r["extended"] = bool(
            (r["r20"] or 0) > EXT_R20
            or (r["r5"] or 0) > EXT_R5
            or (not r.get("flow_suspect") and (r["flow_5d"] or 0) > EXT_FLOW)
            or r["vol20"] > EXT_VOL
        )
        r["pullback_in_uptrend"] = bool(
            (r["r20"] or 0) > 0
            and (r["r60"] or 0) > 0
            and PULLBACK_R5_MIN <= (r["r5"] or 0) <= PULLBACK_R5_MAX
            and not r.get("flow_suspect")
            and (r["flow_5d"] or 0) > 0
            and r["vol20"] < EXT_VOL
        )
