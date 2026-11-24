"""core8 日频核心分 + 排名缓冲带: 每日评分, 每 5 个交易日换仓, 跌出前 15 才卖。

核心认知(2022-01..2026-11, 236 个五日采样日, A股指数型-股票 + 规模≥2亿):
- 15 个窗口描述子做岭回归定权没有样本外效果(扩张窗口 OOS 为负); 固定符号的 8 因子
  在 2022-2026 每年截面 IC 为正, 权重不随年份调整。
- 因子方向: 深回撤(dd60)、短期超跌(z20)、长动量(r250)为正; 高波动、份额拥挤
  (flow_z_60)与放量(amount_z_60)为负; MACD 柱体相对日波动(hist_norm)为正,
  穿轴天数(zero_cross_age)为正。份额拥挤是"反向"因子: 净流入越多, 后续越弱。
- 5 日全换: 毛 11.8%/年、回撤 25.1%; 扣一跳价差 + 万1.5 佣金后净 6.8%、回撤 27.9%。
- 排名缓冲带: 已持有名字跌出前 15 才卖, 每期换出 3.79/5 -> 2.90/5, 净 8.7%/年、
  回撤 25.3%; 毛收益同时从 68.5% 升到 74.1%, 不是单纯省成本。
- 沪深300 年线门控曾把回撤压到 15.7%, 但扩张窗口 walk-forward 只有 +2~5%/年
  (2024 年被 9 月底急涨甩下车), 未落地。
- 高位高波单边扣分: vol20≥45% 且收盘在 250 交易日最高价 3% 以内时总分 −0.10, 只减不加。
  2022-2026 累计 48.8%→52.1%(2024 +34.9%→+37.8%), 2015-2021 59.2%→59.7%; 事件口径
  命中名 5 日超额两段同为负(-0.3~-0.5%)但按节点聚类 t 仅 -0.3~-1.3, 定位是尾部保险而非 alpha。
  曾试 −0.20/10% 宽口径: 熔涨日几乎全市场命中(2024-10-08 数千行), 等于把最强的动量名换出,
  同一段反而 -5.7pp; 只在"贴着年内新高"时扣分两段才都不亏。单用"高波动"更不稳(2015-21 +16pp、
  2022-26 -5.5pp), 必须与"年内高位"成对; 老登波动 8-20% 天然豁免, 低波高位(正常估值抬升)不罚。
  白酒/光伏/新能源/半导体在 2019-2021 最好名次 6-13、从未进前 5, 该规则对它们无感。

时点纪律: 只用 signal 日及之前的行情/份额; MACD 用全历史递推序列, 不引用未来数据。
本文件只放纯计算; 取数与单日建仓在 core_data.py, 节点回填在 core_backfill.py。
"""

from __future__ import annotations

import math
import statistics
from bisect import bisect_left
from collections.abc import Sequence
from typing import Any

from services.kline import states as macd_states
from services.scoring.ranks import average_ranks

HOLD_TOP = 5
HOLD_BUFFER_RANK = 15  # 排名跌出前 15 才卖; 前 5 全换会多付约 1.1pp/年成本
REBALANCE_EVERY = 5  # 交易日; 与回测网格一致
CORE_ANCHOR = "2015-01-05"  # 换仓日网格锚点: 第 1/6/11... 个交易日; 全量历史从 2015 起算
# 注意: 改锚点会平移整条网格(2015-01-05 与旧 2022-01-04 网格相位差 1 个交易日),
# 必须 core_backfill + 日度/周度记录全量重建, 且旧网格的节点/筛选缓存要先清空,
# 否则 fitted_core_* 里会并存两套网格的节点。周度层不受影响的原因是
# weekly/records 以 min(节点日) 截断起点(2022-01-07)。
CORE_WEIGHTS: dict[str, float] = {
    "dd60": 0.20,
    "z20": 0.20,
    "r250": 0.10,
    "vol20": -0.15,
    "flow_z_60": -0.15,
    "amount_z_60": -0.10,
    "hist_norm": 0.10,
    "zero_cross_age": 0.10,
}
CORE_FEATURES: tuple[str, ...] = tuple(CORE_WEIGHTS)  # 顺序与权重表一致
FACTOR_LABELS: dict[str, str] = {
    "dd60": "60日回撤",
    "z20": "20日超跌",
    "r250": "250日动量",
    "vol20": "20日年化波动",
    "flow_z_60": "5日份额拥挤",
    "amount_z_60": "5日放量",
    "hist_norm": "MACD柱体强度",
    "zero_cross_age": "MACD穿轴天数",
}
FACTOR_KINDS: dict[str, str] = {  # 前端格式化用: pct 百分比 / num 纯数值 / days 天数
    "dd60": "pct",
    "z20": "num",
    "r250": "pct",
    "vol20": "pct",
    "flow_z_60": "num",
    "amount_z_60": "num",
    "hist_norm": "num",
    "zero_cross_age": "days",
}
MACD_BARS = 60  # 柱体形状与穿轴天数的观察窗
HIGH_VOL_MIN = 0.45  # 年化 20 日波动: 老登多在 9-20%, 双创顶部 57-94%, 45% 只命中极端段
HIGH_POS_WINDOW = 250  # 年内高位口径; 60 日口径会把回撤中的反弹也算成高位
HIGH_POS_DRAWDOWN = -0.03  # 贴年内新高才算疯牛; 放宽到 10% 会在熔涨日全市场命中, 反而跑输
HIGH_VOL_PENALTY = 0.10  # 策略分单边扣减(只减不加); 约等于半个因子的权重, 不改变主线排序


def _finite(value: Any) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return math.nan
    return number if math.isfinite(number) else math.nan


def _key_date(key: int) -> str:
    return f"{key // 10000:04d}-{key // 100 % 100:02d}-{key % 100:02d}"


def rank_z(values: Sequence[float]) -> list[float]:
    """当日截面百分位(并列取平均), 映射到 [-1, 1]; 缺失给 0(中性)。

    不用标准差 z: 离散量(穿轴天数)在长尾下会被单个极值压扁, 秩变换更稳。
    """
    out = [0.0] * len(values)
    idx = [i for i, value in enumerate(values) if math.isfinite(value)]
    n = len(idx)
    if n < 20:
        return out
    ranks = average_ranks([values[i] for i in idx])
    for pos, i in enumerate(idx):
        out[i] = (ranks[pos] / (n + 1) - 0.5) * 2
    return out


def _macd_shape(
    out: dict[str, float],
    bars: Sequence[dict[str, Any]],
    series: Any,
    signal: str,
    vol20: float,
) -> None:
    if series is None or not math.isfinite(vol20) or vol20 <= 0:
        return
    key = int(signal.replace("-", ""))
    labels = series.labels
    idx = bisect_left(labels, key)
    if idx < MACD_BARS or idx >= len(labels) or labels[idx] != key:
        return
    lo = idx - MACD_BARS + 1
    hist = [_finite(series.hist[i]) for i in range(lo, idx + 1)]
    dif = [_finite(series.dif[i]) for i in range(lo, idx + 1)]
    dea = [_finite(series.dea[i]) for i in range(lo, idx + 1)]
    if any(not math.isfinite(v) for v in hist[-6:]) or any(not math.isfinite(v) for v in dif + dea):
        return
    dates = [_key_date(int(labels[i])) for i in range(lo, idx + 1)]
    close_map = {b["date"]: float(b["close"]) for b in bars}
    if any(d not in close_map for d in dates):
        return
    sig_d = vol20 / math.sqrt(252)
    if sig_d <= 0:
        return
    hrel = [hist[i] / close_map[dates[i]] for i in range(MACD_BARS)]
    out["hist_norm"] = hrel[-1] / sig_d
    age = float(MACD_BARS)
    for i in range(MACD_BARS - 1, 0, -1):
        if (dif[i] - dea[i] > 0) != (dif[i - 1] - dea[i - 1] > 0):
            age = float(MACD_BARS - 1 - i)
            break
    out["zero_cross_age"] = age


def high_vol_penalty(features: dict[str, float]) -> float:
    """年内高位 + 高波动的单边扣分: 条件不满足或数据不足都返回 0, 只减不加。"""
    vol = _finite(features.get("vol20"))
    dd = _finite(features.get("dd250"))
    if not (math.isfinite(vol) and math.isfinite(dd)):
        return 0.0
    if vol >= HIGH_VOL_MIN and dd >= HIGH_POS_DRAWDOWN:
        return HIGH_VOL_PENALTY
    return 0.0


def describe(
    row: dict[str, Any],
    bars: Sequence[dict[str, Any]],
    shares: Sequence[dict[str, Any]],
    series: Any,
    signal: str,
) -> dict[str, float]:
    """窗口内描述子; 不足样本或数据缺失给 NaN, 由 rank_z 转成中性 0。"""
    out = {name: math.nan for name in CORE_FEATURES}
    if len(bars) < 2:
        return out
    out["dd60"] = _finite(row.get("dd60"))
    out["r250"] = _finite(row.get("r250"))
    vol20 = _finite(row.get("vol20"))
    out["vol20"] = vol20
    r20 = _finite(row.get("r20"))
    if len(bars) >= 61 and math.isfinite(r20) and math.isfinite(vol20) and vol20:
        out["z20"] = r20 / (vol20 / math.sqrt(252) * math.sqrt(20))
    if len(bars) >= 60:
        amounts = [float(b["volume"]) * float(b["close"]) for b in bars[-60:]]
        sd = statistics.pstdev(amounts)
        if sd and math.isfinite(sd):
            out["amount_z_60"] = (statistics.fmean(amounts[-5:]) - statistics.fmean(amounts)) / sd
    if len(shares) >= 21:
        growths = [
            float(shares[i]["shares_yi"]) / float(shares[i - 5]["shares_yi"]) - 1
            for i in range(5, len(shares))
            if shares[i - 5].get("shares_yi") and shares[i].get("shares_yi")
        ]
        flow = _finite(row.get("flow_5d"))
        sd_f = statistics.pstdev(growths) if len(growths) > 1 else 0.0
        if math.isfinite(flow) and len(growths) >= 15 and sd_f and math.isfinite(sd_f):
            out["flow_z_60"] = (flow - statistics.fmean(growths)) / sd_f
    if len(bars) >= HIGH_POS_WINDOW:
        peak = max(float(b["close"]) for b in bars[-HIGH_POS_WINDOW:])
        if peak:
            out["dd250"] = float(bars[-1]["close"]) / peak - 1
    _macd_shape(out, bars, series, signal, vol20)
    return out


def factor_rows(features: dict[str, float], z: dict[str, float]) -> list[dict[str, Any]]:
    """单只标的的 8 因子拆解 + 命中时的扣分行, 供页面展示公式构成与合计。"""
    out = []
    for name in CORE_FEATURES:
        value = _finite(features.get(name))
        weight = CORE_WEIGHTS[name]
        rank = z.get(name, 0.0)
        out.append(
            {
                "key": name,
                "label": FACTOR_LABELS[name],
                "kind": FACTOR_KINDS[name],
                "value": value if math.isfinite(value) else None,
                "z": round(rank, 6),
                "weight": weight,
                "contrib": round(weight * rank, 6),
            }
        )
    penalty = high_vol_penalty(features)
    if penalty:
        dd = _finite(features.get("dd250"))
        out.append(
            {
                "key": "high_vol_penalty",
                "label": "高位高波惩罚",
                "kind": "pct",
                "value": dd if math.isfinite(dd) else None,
                "z": None,
                "weight": None,
                "contrib": round(-penalty, 6),
            }
        )
    return out


def score_rows(
    rows: Sequence[dict[str, Any]],
    bars_by_code: dict[str, list[dict[str, Any]]],
    shares_by_code: dict[str, list[dict[str, Any]]],
    provider: macd_states.MacdStateProvider,
    signal: str,
) -> list[dict[str, Any]]:
    """截面评分: 8 因子秩变换后按固定符号加权, 返回按分降序的行(附 core_rank)。"""
    desc = {
        r["code"]: describe(
            r,
            bars_by_code.get(r["code"], []),
            shares_by_code.get(r["code"], []),
            provider.day_series(r["code"]),
            signal,
        )
        for r in rows
    }
    z = {name: rank_z([desc[r["code"]][name] for r in rows]) for name in CORE_FEATURES}
    scored: list[dict[str, Any]] = []
    for i, row in enumerate(rows):
        item = dict(row)
        item["core_features"] = desc[row["code"]]
        item["core_factors"] = factor_rows(desc[row["code"]], {name: z[name][i] for name in CORE_FEATURES})
        item["core_score"] = round(
            sum(CORE_WEIGHTS[name] * z[name][i] for name in CORE_FEATURES) - high_vol_penalty(desc[row["code"]]),
            6,
        )
        scored.append(item)
    scored.sort(key=lambda r: -r["core_score"])
    for rank, row in enumerate(scored, 1):
        row["core_rank"] = rank
    return scored
