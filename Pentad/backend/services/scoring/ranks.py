"""截面秩: 并列取平均的秩变换, 供因子打分、分位与 Rank IC 共用。

三处调用方(因子 rank_z、分位 _pct_rank、Spearman)原先各自实现一套并列处理,
口径必须一致, 否则同一批分数在不同视图里名次会不同。
"""

from __future__ import annotations

from collections.abc import Sequence


def average_ranks(values: Sequence[float]) -> list[float]:
    """1 基平均秩: 并列元素取平均名次; 输入需全部为有限值。"""
    order = sorted(range(len(values)), key=lambda i: values[i])
    ranks = [0.0] * len(values)
    start = 0
    while start < len(order):
        end = start
        while end + 1 < len(order) and values[order[end + 1]] == values[order[start]]:
            end += 1
        rank = (start + end) / 2 + 1
        for k in range(start, end + 1):
            ranks[order[k]] = rank
        start = end + 1
    return ranks
