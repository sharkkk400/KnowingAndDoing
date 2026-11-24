"""盘中预演的取数: 现价合成 bar、历史上下文加载与节点持仓读取。

与 live.py 的缓存/响应组装分开: 这里只回答"今天能拿到什么数据", 不关心 TTL 与
页面载荷; 份额与沪深300 截止上一交易日(当日不可得), 与收盘后正式节点的细微差异
统一由 live.py 的说明承担。
"""

from __future__ import annotations

import sqlite3
from typing import Any

from services.scoring import features
from services.scoring.core import store as core_store
from services.scoring.descriptors import cross_section


def synthetic_bar(today: str, quote: dict[str, Any]) -> dict[str, Any] | None:
    """现价合成今日 bar; 停牌(现价<=0)返回 None, 与日K缺失同处理。"""
    price = quote.get("price")
    if not isinstance(price, (int, float)) or price <= 0:
        return None
    return {
        "date": today,
        "open": quote.get("open") or price,
        "close": price,
        "high": quote.get("high") or price,
        "low": quote.get("low") or price,
        "volume": quote.get("volume") or 0.0,
    }


def load_context(conn: sqlite3.Connection, today: str, calendar: list[str]) -> dict[str, Any] | None:
    """加载截至上一交易日的历史上下文; 只做一次 SQL, 供每个缓存窗口复用。"""
    base = calendar.index(today) if today in calendar else len(calendar)
    if base == 0:
        return None
    last_day = calendar[base - 1]
    data_start = calendar[max(0, base - 1 - features.HISTORY_DAYS - 5)]
    shares_start = calendar[max(0, base - 1 - features.SHARES_HISTORY_DAYS - 5)]
    meta = features.load_meta(conn)
    scope = features.equity_a_share_codes(meta)
    raw_daily = features.load_daily(conn, data_start, last_day)
    daily_all = {c: b for c, b in raw_daily.items() if c in scope}
    raw_shares = features.load_shares(conn, shares_start, last_day)
    shares_all = {c: s for c, s in raw_shares.items() if c in scope}
    indices = features.load_index(conn, data_start, last_day)
    bench = indices.get(cross_section.HS300_CODE, [])
    return {
        "last_day": last_day,
        "meta": meta,
        "daily_all": daily_all,
        "daily_dates": {c: [bar["date"] for bar in bars] for c, bars in daily_all.items()},
        "shares_all": shares_all,
        "shares_dates": {c: [bar["date"] for bar in bars] for c, bars in shares_all.items()},
        "bench": bench,
        "bench_dates": [b["date"] for b in bench],
    }


def quote_bar(quote: dict[str, Any], today: str) -> dict[str, Any] | None:
    """只采用行情时间已落到今日的报价: 开盘前拿到的是昨日收盘, 拼成今日 bar 会重复一天。"""
    stamp = str(quote.get("time") or "")
    return synthetic_bar(today, quote) if stamp.startswith(today) else None


def fill_auction_volume(bar: dict[str, Any], history: list[dict[str, Any]]) -> dict[str, Any]:
    """集合竞价 09:25 撮合前成交量为 0, 用上一交易日的成交量占位。

    不占位会被 build_features 的"近 20 日成交量必须有效"整池剔除, 结果今日预演
    在 09:15-09:25 没有任何排名。占位只用于盘中预演, 不落库, 9:25 后行情自带成交量。
    """
    if bar.get("volume"):
        return bar
    if not history:
        return bar
    last = history[-1].get("volume")
    if last and last > 0:
        bar = {**bar, "volume": float(last)}
    return bar


def node_closes(conn: sqlite3.Connection, day: str | None, codes: list[str]) -> dict[str, float]:
    """节点日收盘价 {code: close}: 持仓期涨跌幅的基准。"""
    if not day or not codes:
        return {}
    marks = ",".join("?" * len(codes))
    rows = conn.execute(
        f"SELECT code, close FROM etf_daily WHERE date=? AND code IN ({marks})",
        (day, *codes),
    )
    return {r["code"]: r["close"] for r in rows if r["close"] is not None}


def held_positions(conn: sqlite3.Connection, last_day: str) -> tuple[list[str], list[dict[str, Any]]]:
    """(持仓代码, 卡片用轻量明细): 因子拆解不进预演卡片, 需要时看底部全量表。"""
    node = core_store.node_at(conn, last_day)
    data = core_store.get_node(conn, node) if node else None
    holdings = (data or {}).get("holdings", [])
    closes = node_closes(conn, node, [p["code"] for p in holdings])
    detail = [
        {
            "code": p["code"],
            "name": p.get("name"),
            "core_rank": p["core_rank"],
            "core_score": p["core_score"],
            "action": p["action"],
            "node_close": closes.get(p["code"]),
        }
        for p in holdings
    ]
    return [p["code"] for p in holdings], detail
