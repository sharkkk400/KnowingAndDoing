"""fundcode_search 静态清单解析(纯函数, 不触网)。"""

from __future__ import annotations

from data.fetch.etf_list import parse_fundcode_rows

_SAMPLE = (
    'var r = [["510300","HS300ETF","沪深300ETF","指数型-股票","HS300ETF"],'
    '["159915","CYBETF","创业板ETF","指数型-股票","CYBETF"],'
    '["000311","HS300LJ","沪深300ETF联接A","指数型-股票","HS300LJA"],'
    '["511880","HBYJETF","银华日利ETF","货币型-普通货币","HBYJETF"],'
    '["600519","GZMT","贵州茅台","股票型","GZMT"]];'
)


def test_parse_filters_exchange_etf_only() -> None:
    rows = parse_fundcode_rows(_SAMPLE)
    assert [r["code"] for r in rows] == ["510300", "159915", "511880"]
    assert rows[0]["fund_type"] == "指数型-股票"
    assert rows[0]["price"] is None and rows[0]["amount_yi"] is None


def test_parse_garbage_returns_empty() -> None:
    assert parse_fundcode_rows("not json") == []
    assert parse_fundcode_rows("var r = ;") == []
