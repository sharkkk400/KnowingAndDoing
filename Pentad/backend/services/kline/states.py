"""信号日的日/周/月 MACD 状态与趋势分。

时点纪律(防后视镜):
1) 日线/周线只取信号日及之前的已收盘 K 线, 周线标签=该周最后交易日;
2) 周线看"上周 vs 上上周": 信号周的周K与信号同日收盘, 拿它比上一周会和日线同源、
   连 2% 的柱体抖动都算放大; 只用已结算的两根周K判断周线动能;
3) 月线用"当月至今"收盘 + 已完成月份递推, 绝不引用未来月末收盘;
4) MACD 从标的上市首根 K 线递推, 预热不足的周期返回 None, 不参与打分。

评分口径(四象限, zone 按当根柱体符号: 红柱=水上/绿柱=水下):
水上走强(红柱放大)= 唯一两周期都跑赢基准的象限 → 满分。
水下走强(绿柱缩短)≠ 见底信号: 事件研究(全部信号周候选, 信号→下周收益)显示其为最差
日线象限(均值 -0.20%/胜率 46.8%, 全样本基准 +0.06%/48.5%)——绿柱缩短只说明本轮下跌
动能暂停, 常见于持续阴跌的中继; 周线口径略正(+0.21%), 故减半扣分而非扣满。
水上走弱(红柱缩短)= 动能衰减但两样本均值 ≈ 0, 方向不明确, 不奖不罚; 真转空由死叉
落到水下走弱扣分。水下走弱(绿柱放大)= 做空动能增强, 回撤子集 -0.60%/胜率 43.5% → 扣满。
柱体持平/零轴记 0。不能比较柱体绝对值——否则会把死叉后的扩张误判成"放大"。
趋势分按 日0.6/周0.3/月0.1 加权, 三周期合计范围 [-1, 1]; 日线最灵敏且权重是周线两倍,
月线只做背景; 缺失周期不参与, 不放大剩余周期。

2026-11-13 教训: 曾实验"滑动窗口相位分"(柱体/自身振幅 + 日周齐升硬门槛,
mechanical-v4), 设计验证时误把"信号→下一交易日"当"信号→下一周", 把次日惯性
(+0.61%/日)当成周度边际; 真实周线口径下日周齐升是一周内短期反转信号
(门槛内 −0.12%/周 vs 全池 +0.11%/周), 已全部回退。此类事件研究必须核对持有期
与换仓口径一致。
"""

from __future__ import annotations

import math
import sqlite3
from array import array
from bisect import bisect_left
from collections.abc import Iterator
from typing import Any

from services.kline import aggregate, macd

# 趋势分权重: 日线主导(周线的两倍), 月线只做背景; 三周期合计最大 ±1。
PERIOD_WEIGHTS: dict[str, float] = {"day": 0.60, "week": 0.30, "month": 0.10}
# 周线回退一根: 信号周的周K与信号同日收盘, 用它比上周等于判日线, 只能看已结算的两根周K。
WEEK_LAG = 1
# 四象限得分, 依据 2026-11 事件研究(139k 日线样本 / 12.6k 回撤子集, 信号→下周收益)。
SIGN: dict[tuple[str, str], float] = {
    ("above", "rising"): 1.0,  # 红柱放大: 全样本 +0.28%/hit 51.0%, 回撤子集 +0.11%/hit 54.0%
    ("above", "falling"): 0.0,  # 红柱缩短: 动能衰减但两样本均值 ≈ 0, 不奖不罚; 死叉转空落 (below, falling)
    ("below", "rising"): -0.5,  # 绿柱缩短: 全样本 -0.20% 最差/hit 46.8%; 周线 +0.21% 故减半
    ("below", "falling"): -1.0,  # 绿柱放大: 回撤子集 -0.60%/hit 43.5%, 做空动能增强
}
PERIODS: tuple[tuple[str, str], ...] = (("day", "日"), ("week", "周"), ("month", "月"))


def trend_score(states: dict[str, dict[str, Any] | None]) -> float:
    """三周期四象限趋势分, 范围 [-1, 1]; 缺失周期不参与, 不放大剩余周期。"""
    total = 0.0
    for period, weight in PERIOD_WEIGHTS.items():
        state = states.get(period)
        if state is not None:
            total += weight * SIGN.get((state["zone"], state["trend"]), 0.0)
    return round(total, 4)


def latest(bars: list[dict[str, Any]], period: str) -> dict[str, Any] | None:
    """最新一根K线的状态(页面实时展示用); 周线同样跳过尚未确认的当周。"""
    return macd.state(bars, period, WEEK_LAG if period == "week" else 0)


def _date_key(day: str) -> int:
    return int(day.replace("-", ""))


def _key_date(key: int) -> str:
    return f"{key // 10000:04d}-{key // 100 % 100:02d}-{key % 100:02d}"


def _value(values: array, index: int) -> float | None:
    value = values[index]
    return None if math.isnan(value) else float(value)


def _values(rows: list[dict[str, Any]], field: str) -> array:
    return array("d", [math.nan if row.get(field) is None else float(row[field]) for row in rows])


def _step(value: float, previous: float, span: int) -> float:
    alpha = 2 / (span + 1)
    return alpha * value + (1 - alpha) * previous


def _forward_closes(bars: list[dict[str, Any]]) -> list[float | None]:
    out: list[float | None] = []
    last: float | None = None
    for bar in bars:
        if bar.get("close") is not None:
            last = float(bar["close"])
        out.append(last)
    return out


class _Series:
    """日线或周线: 标签=该周期最后交易日, 指标已按整段历史递推。"""

    __slots__ = ("labels", "dif", "dea", "hist")

    def __init__(self, enriched: list[dict[str, Any]]) -> None:
        self.labels = array("i", [_date_key(bar["date"]) for bar in enriched])
        self.dif = _values(enriched, "dif")
        self.dea = _values(enriched, "dea")
        self.hist = _values(enriched, "hist")

    def state_at(self, key: int, period: str, lag: int = 0) -> dict[str, Any] | None:
        index = bisect_left(self.labels, key)
        if index < 1 or index >= len(self.labels) or self.labels[index] != key:
            return None
        index -= lag
        if index < 1:
            return None
        last = self._bar(index)
        prev = self._bar(index - 1)
        if last["hist"] is None or prev["hist"] is None:
            return None
        return macd.state([prev, last], period)

    def _bar(self, index: int) -> dict[str, Any]:
        return {
            "date": _key_date(int(self.labels[index])),
            "dif": _value(self.dif, index),
            "dea": _value(self.dea, index),
            "hist": _value(self.hist, index),
        }


class _MonthSeries:
    """月线: 已完成月份用于递推, 当月柱体由调用方传入的信号日收盘补成 MTD。"""

    __slots__ = ("keys", "labels", "start", "fast", "slow", "dif", "dea", "hist")

    def __init__(self, bars: list[dict[str, Any]]) -> None:
        groups = aggregate.resample(bars, "month")
        self.labels = array("i", [_date_key(bar["date"]) for bar in groups])
        self.keys = array("i", [int(label) // 100 for label in self.labels])
        closes = _forward_closes(groups)
        start = next((i for i, value in enumerate(closes) if value is not None), len(groups))
        self.start = start
        values = [float(value) for value in closes[start:] if value is not None]
        fast = macd.ema(values, macd.FAST)
        slow = macd.ema(values, macd.SLOW)
        dif = [f - s for f, s in zip(fast, slow)]
        dea = macd.ema(dif, macd.SIGNAL)
        hist = [2 * (d - e) for d, e in zip(dif, dea)]
        pad = [math.nan] * start
        self.fast = array("d", pad + fast)
        self.slow = array("d", pad + slow)
        self.dif = array("d", pad + dif)
        self.dea = array("d", pad + dea)
        self.hist = array("d", pad + hist)

    def state_at(self, day_key: int, close: float | None) -> dict[str, Any] | None:
        if close is None:
            return None
        month_key = day_key // 100
        index = bisect_left(self.keys, month_key)
        if index >= len(self.keys) or self.keys[index] != month_key:
            return None
        if index <= 0 or index < self.start + macd.MIN_BARS:
            return None
        fast_prev = _value(self.fast, index - 1)
        slow_prev = _value(self.slow, index - 1)
        dif_prev = _value(self.dif, index - 1)
        dea_prev = _value(self.dea, index - 1)
        hist_prev = _value(self.hist, index - 1)
        if fast_prev is None or slow_prev is None or dif_prev is None or dea_prev is None or hist_prev is None:
            return None
        fast = _step(close, fast_prev, macd.FAST)
        slow = _step(close, slow_prev, macd.SLOW)
        dif = fast - slow
        dea = _step(dif, dea_prev, macd.SIGNAL)
        hist = 2 * (dif - dea)
        prev = {"date": _key_date(int(self.labels[index - 1])), "dif": dif_prev, "dea": dea_prev, "hist": hist_prev}
        last = {"date": _key_date(day_key), "dif": dif, "dea": dea, "hist": hist}
        return macd.state([prev, last], "month")


class _CodeStates:
    __slots__ = ("day", "week", "month")

    def __init__(self, bars: list[dict[str, Any]]) -> None:
        self.day = _Series(macd.attach(bars))
        self.week = _Series(macd.attach(aggregate.resample(bars, "week")))
        self.month = _MonthSeries(bars)

    def states(self, signal: str, close: float | None) -> dict[str, dict[str, Any] | None]:
        key = _date_key(signal)
        return {
            "day": self.day.state_at(key, "day"),
            "week": self.week.state_at(key, "week", WEEK_LAG),
            "month": self.month.state_at(key, close),
        }


def _iter_by_code(conn: sqlite3.Connection, end: str) -> Iterator[tuple[str, list[dict[str, Any]]]]:
    cursor = conn.execute(
        "SELECT code, date, open, close, high, low, volume FROM etf_daily WHERE date <= ? ORDER BY code, date",
        (end,),
    )
    code: str | None = None
    bars: list[dict[str, Any]] = []
    for row in cursor:
        if row["code"] != code:
            if code is not None:
                yield code, bars
            code, bars = row["code"], []
        bars.append(dict(row))
    if code is not None:
        yield code, bars


class MacdStateProvider:
    """一次加载全历史, 之后按 (code, signal) 查询; 不缓存 607 个信号的结果以省内存。"""

    def __init__(self, series: dict[str, _CodeStates] | None = None) -> None:
        self._series = series or {}

    @classmethod
    def load(cls, conn: sqlite3.Connection, end: str) -> MacdStateProvider:
        return cls({code: _CodeStates(bars) for code, bars in _iter_by_code(conn, end)})

    @classmethod
    def from_bars(cls, bars_by_code: dict[str, list[dict[str, Any]]]) -> MacdStateProvider:
        """内存 K 线构造: 盘中实时预选要把今日合成 bar 并入序列, 只读库拿不到这根。"""
        return cls({code: _CodeStates(bars) for code, bars in bars_by_code.items()})

    def day_series(self, code: str) -> _Series | None:
        """core8 需要柱体原值(dif/dea/hist), 而不是四象限状态。"""
        item = self._series.get(code)
        return item.day if item is not None else None

    def states(self, code: str, signal: str, close: float | None) -> dict[str, dict[str, Any] | None]:
        item = self._series.get(code)
        if item is None:
            return {period: None for period in PERIOD_WEIGHTS}
        return item.states(signal, close)
