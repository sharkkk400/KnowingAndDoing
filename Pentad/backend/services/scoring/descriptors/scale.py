"""份额口径归一: 折算/拆分是口径变化, 不是申购赎回。

份额折算会让单日份额整倍跳变(159582 2026-07-10: 1.52 亿份 → 8.56 亿份), 而腾讯
前复权价格保持连续, 于是 `close × shares` 的规模、5 日份额增速会被凭空放大 5 倍,
在截面 z 分数里直接压过趋势项。这里把窗口内的历史份额按**已甄别**的折算倍率
折算到最新口径, 只保留真实申赎; 未甄别的跳变不猜测, 标记为可疑, 由调用方把
资金因子按缺失处理, 避免把折算当申购。

甄别来源: data.fetch.adjust 用未复权/前复权比值台阶确认, 结果存在 etf_share_scale。
"""

from __future__ import annotations

from typing import Any

UNVERIFIED_JUMP_RATIO = 1.5  # 单日份额倍率超 1.5 且无甄别结论 → 资金因子按缺失处理


def normalize(points: list[dict[str, Any]], events: list[dict[str, Any]]) -> None:
    """原地把 points 的 shares_yi 折算到最新口径; 同时写 shares_raw / scale / event。

    events: [{"date", "ratio", "method"}] 按日期升序; 只有 method='split' 参与折算,
    method='flow' 仅表示"跳变已甄别为真实申赎", 不改变数值, 但会标记该日已验明。
    """
    splits = [(e["date"], float(e["ratio"])) for e in events if e.get("method") == "split"]
    known = {e["date"]: e.get("method") for e in events}
    for point in points:
        raw = point.get("shares_raw", point["shares_yi"])
        point["shares_raw"] = raw
        point["event"] = known.get(point["date"])
        scale = 1.0
        for date, ratio in splits:
            if point["date"] < date:
                scale *= ratio
        point["scale"] = scale
        if raw is not None:
            point["shares_yi"] = raw * scale


def unverified_jump(points: list[dict[str, Any]]) -> dict[str, Any] | None:
    """窗口内最大的一笔未甄别大跳变, 无则 None; 只读 raw 值, 与归一结果无关。"""
    worst: dict[str, Any] | None = None
    for prev, cur in zip(points, points[1:]):
        ratio = _ratio(prev, cur)
        if ratio is None or cur.get("event"):
            continue
        if not (ratio >= UNVERIFIED_JUMP_RATIO or ratio <= 1 / UNVERIFIED_JUMP_RATIO):
            continue
        if worst is None or max(ratio, 1 / ratio) > max(worst["ratio"], 1 / worst["ratio"]):
            worst = {"date": cur["date"], "ratio": ratio}
    return worst


def split_events(points: list[dict[str, Any]]) -> int:
    return sum(1 for p in points if p.get("event") == "split")


def _ratio(prev: dict[str, Any], cur: dict[str, Any]) -> float | None:
    a, b = prev.get("shares_raw"), cur.get("shares_raw")
    if not a or not b or a <= 0:
        return None
    return float(b) / float(a)
