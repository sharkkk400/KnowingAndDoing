"""MACD(12,26,9)与周期状态: 柱体较上一根上行=走强, 下行=走弱; 柱体符号定水上/水下。"""

from __future__ import annotations

from typing import Any

FAST = 12
SLOW = 26
SIGNAL = 9
# DIF 需 SLOW 根; DEA/柱再需 SIGNAL-1 根, 与常见行情软件的预热口径一致。
MIN_BARS = SLOW + SIGNAL - 2

Bar = dict[str, Any]


def ema(values: list[float], span: int) -> list[float]:
    alpha = 2 / (span + 1)
    out: list[float] = []
    for value in values:
        out.append(value if not out else alpha * value + (1 - alpha) * out[-1])
    return out


def _closes(bars: list[Bar]) -> list[float | None]:
    """缺收盘(停牌/坏数据)沿用前值, 保证序列连续; 序列头部缺失保持 None。"""
    out: list[float | None] = []
    last: float | None = None
    for bar in bars:
        close = bar.get("close")
        if close is not None:
            last = float(close)
        out.append(last)
    return out


def attach(bars: list[Bar]) -> list[Bar]:
    """返回带 dif/dea/hist 的新列表; 预热期字段为 None, 不伪造指标值。"""
    result = [dict(bar) for bar in bars]
    closes = _closes(bars)
    start = next((i for i, value in enumerate(closes) if value is not None), None)
    if start is None:
        return _fill(result, range(len(result)), None, None, None)

    values = [value for value in closes[start:] if value is not None]
    fast = ema(values, FAST)
    slow = ema(values, SLOW)
    dif = [f - s for f, s in zip(fast, slow)]
    dea = ema(dif, SIGNAL)
    hist = [2 * (d - e) for d, e in zip(dif, dea)]

    result = _fill(result, range(start), None, None, None)
    for index in range(start, len(result)):
        offset = index - start
        if offset < SLOW - 1:
            result[index].update(dif=None, dea=None, hist=None)
        elif offset < MIN_BARS:
            result[index].update(dif=dif[offset], dea=None, hist=None)
        else:
            result[index].update(dif=dif[offset], dea=dea[offset], hist=hist[offset])
    return result


def _fill(bars: list[Bar], indexes: range, dif: float | None, dea: float | None, hist: float | None) -> list[Bar]:
    for index in indexes:
        bars[index].update(dif=dif, dea=dea, hist=hist)
    return bars


def state(bars: list[Bar], period: str | None = None, lag: int = 0) -> dict[str, Any] | None:
    """最新一根相对上一根的柱体变化与零轴位置; lag 用于跳过尚未确认的末根; 预热不足返回 None。

    trend 按带符号的柱体差值判定: 上行=rising(走强), 下行=falling(走弱)。
    不能比较绝对值——柱体由 +0.001 翻到 -0.002 时绝对值变大, 但那是死叉转空而非"放大"。
    zone 按当根柱体符号判定: 红柱=above(水上), 绿柱=below(水下), 柱体恰为 0=zero(零轴)。
    不用 DIF/DEA 符号定区——用户看图按柱体颜色读水上/水下, DIF/DEA 同侧时柱体常已翻绿,
    旧口径会把"绿柱区里的形态"标成水上, 与看图口径矛盾。
    flip 标记当根是否穿越零轴(golden/dead), 供展示用。
    """
    if len(bars) < 2 + lag:
        return None
    last, prev = bars[-1 - lag], bars[-2 - lag]
    if last.get("hist") is None or prev.get("hist") is None:
        return None
    hist = float(last["hist"])
    hist_prev = float(prev["hist"])
    if hist > hist_prev:
        trend = "rising"
    elif hist < hist_prev:
        trend = "falling"
    else:
        trend = "flat"
    if hist > 0 >= hist_prev:
        flip = "golden"
    elif hist < 0 <= hist_prev:
        flip = "dead"
    else:
        flip = None
    dif = float(last["dif"])
    dea = float(last["dea"])
    if hist > 0:
        zone = "above"
    elif hist < 0:
        zone = "below"
    else:
        zone = "zero"
    return {
        "period": period,
        "date": last["date"],
        "dif": dif,
        "dea": dea,
        "hist": hist,
        "hist_prev": hist_prev,
        "trend": trend,
        "flip": flip,
        "zone": zone,
    }
