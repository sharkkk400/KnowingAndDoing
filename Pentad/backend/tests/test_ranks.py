"""截面秩: 并列取平均、乱序输入与小样本口径。"""

from __future__ import annotations

import math

import pytest

from services.scoring.core.score import rank_z
from services.scoring.ranks import average_ranks


def test_average_ranks_ties_share_mean_rank() -> None:
    assert average_ranks([10.0, 20.0, 20.0, 30.0]) == [1.0, 2.5, 2.5, 4.0]


def test_average_ranks_follows_value_order() -> None:
    assert average_ranks([3.0, 1.0, 2.0]) == [3.0, 1.0, 2.0]


def test_rank_z_is_monotone_and_neutral_for_missing() -> None:
    values = [math.nan] + [float(i) for i in range(20)]

    z = rank_z(values)

    assert z[0] == 0.0
    assert z[1] < z[20]
    assert min(z[1:]) >= -1.0
    assert max(z[1:]) <= 1.0


def test_rank_z_centre_is_zero() -> None:
    z = rank_z([float(i) for i in range(21)])

    assert z[10] == pytest.approx(0.0)
