"""core8 换仓节点与持仓时间线: 节点收益、买卖动作、每只标的的持有区间。

节点收益按混合执行口径结算: 预备排名掉出缓冲带的仓位周四收盘卖出, 完整目标里新买入
和顺延卖出的仓位在周五开盘成交; 连续持有不动。等权、不扣费用, 与日度记录同口径。
节点列表另给两条对照基准: 评分前 10 名等权(看集中到 5 只是否划算)与沪深300 同区间指数
涨跌(看绝对收益里有多少是市场给的), 两者都不含交易成本。
时间线把连续持有合并成一段, 买入价/卖出价用真实成交价(开盘或收盘)。
"""

from __future__ import annotations

import sqlite3
from typing import Any

from pages.daily.review import attribution, execution
from pages.daily.review.execution import load_price_range, price_at
from services.scoring import features
from services.scoring.core import store as core_store
from services.scoring.descriptors import themes

TOP_BENCH_N = 10  # 对照基准: 节点评分前 10 名等权持有, 用来衡量只买 5 只的取舍


def _sell_marks(conn: sqlite3.Connection, start: str | None, end: str | None) -> dict[str, dict[str, str]]:
    """{节点日: {code: close/open}}: 卖出动作由预备排名决定在周四收盘还是周五开盘。"""
    sql = "SELECT signal_date, code, pre_rank FROM fitted_core_pick WHERE action = 'sell'"
    params: list[Any] = []
    if start:
        sql += " AND signal_date >= ?"
        params.append(start)
    if end:
        sql += " AND signal_date <= ?"
        params.append(end)
    marks: dict[str, dict[str, str]] = {}
    for row in conn.execute(sql, params):
        marks.setdefault(row["signal_date"], {})[row["code"]] = execution.sell_at(row["pre_rank"])
    return marks


def _plans(conn: sqlite3.Connection, end: str | None) -> dict[str, Any]:
    """节点链路必须从更早的节点推过来, 状态链才连续。"""
    return execution.plans(core_store.holdings_by_node(conn, end=end), core_store.pre_ranks_by_node(conn, end=end))


def _codes(holdings: dict[str, list[dict[str, Any]]], plans: dict[str, Any]) -> list[str]:
    """区间结算要用到持仓 + 顺延卖出的价格; 周四收盘卖的腿不产生收益, 不必取价。"""
    sold = {c for plan in plans.values() for c in plan["sell_open"]}
    return sorted({p["code"] for items in holdings.values() for p in items} | sold)


def _top_codes(
    conn: sqlite3.Connection,
    start: str | None,
    end: str | None,
    n: int = TOP_BENCH_N,
) -> dict[str, list[str]]:
    """{节点日: 评分前 n 名}: 对照基准按节点当场排名取, 与持仓名单同一时点。"""
    sql = "SELECT signal_date, code FROM fitted_core_pick WHERE core_rank <= ?"
    params: list[Any] = [n]
    if start:
        sql += " AND signal_date >= ?"
        params.append(start)
    if end:
        sql += " AND signal_date <= ?"
        params.append(end)
    sql += " ORDER BY signal_date, core_rank"
    out: dict[str, list[str]] = {}
    for row in conn.execute(sql, params):
        out.setdefault(row["signal_date"], []).append(row["code"])
    return out


def _index_closes(conn: sqlite3.Connection, code: str, start: str, end: str) -> dict[str, float]:
    rows = conn.execute(
        "SELECT date, close FROM index_daily WHERE code = ? AND date BETWEEN ? AND ? AND close IS NOT NULL",
        (code, start, end),
    )
    return {r["date"]: float(r["close"]) for r in rows}


def _equal_weight(
    prices: dict[str, Any],
    codes: list[str],
    start: str | None,
    end: str | None,
) -> float | None:
    """收盘→收盘等权收益; 缺任一端的标的跳过, 一只都算不出就留空。"""
    returns = []
    for code in codes:
        p0, p1 = price_at(prices, code, start), price_at(prices, code, end)
        if p0 and p1:
            returns.append(p1 / p0 - 1)
    return sum(returns) / len(returns) if returns else None


def list_nodes(
    conn: sqlite3.Connection,
    start: str | None = None,
    end: str | None = None,
) -> list[dict[str, Any]]:
    """节点列表: 持仓、买卖动作计数、节点区间收益, 以及前 10 名/沪深300 对照。"""
    nodes = core_store.list_nodes(conn, start, end)
    if not nodes:
        return []
    holdings = core_store.holdings_by_node(conn, start, end)
    counts = core_store.action_counts(conn, start, end)
    plans = _plans(conn, end)
    bench = _top_codes(conn, start, end)
    codes = sorted(set(_codes(holdings, plans)) | {c for items in bench.values() for c in items})
    data_end = max((n["next_rebalance"] or n["signal_date"]) for n in nodes)
    prices = load_price_range(conn, codes, nodes[0]["signal_date"], data_end)
    index = _index_closes(conn, attribution.HS300_CODE, nodes[0]["signal_date"], data_end)
    calendar = features.trading_days(conn)

    out: list[dict[str, Any]] = []
    for node in nodes:
        signal, settle = node["signal_date"], node["next_rebalance"]
        plan = plans.get(signal)
        interval = None
        if plan and settle:
            open_day = execution.next_day(calendar, signal) or settle
            interval = execution.settle(plan, prices, signal, open_day, settle)
        items = holdings.get(signal, [])
        action = counts.get(signal, {})
        index0, index1 = index.get(signal), index.get(settle) if settle else None
        out.append(
            {
                "signal_date": signal,
                "next_rebalance": settle,
                "generated_at": node["generated_at"],
                "rule_version": node["rule_version"],
                "scored": node["scored"],
                "holdings": [{"code": p["code"], "name": p.get("name"), "core_rank": p["core_rank"]} for p in items],
                "counts": {
                    "hold": action.get("hold", 0),
                    "buy": action.get("buy", 0),
                    "sell": action.get("sell", 0),
                },
                "return": (interval or {}).get("mean"),
                "top10_return": _equal_weight(prices, bench.get(signal, []), signal, settle),
                "hs300_return": (index1 / index0 - 1) if index0 and index1 else None,
            }
        )
    return out


def detail(conn: sqlite3.Connection, signal: str) -> dict[str, Any]:
    """单个节点: 持仓/卖出的成交价与区间收益, 以及评分前 20。"""
    node = core_store.get_node(conn, signal)
    if node is None:
        raise ValueError(f"{signal} 不是换仓节点")
    settle = node["next_rebalance"]
    plan = _plans(conn, signal).get(signal) or {"keep": [], "buy": [], "sell_open": [], "sell_close": []}
    picks = node["holdings"] + node["sells"] + node["ranked"]
    codes = sorted({p["code"] for p in picks})
    calendar = features.trading_days(conn)
    open_day = execution.next_day(calendar, signal) or settle
    open_exit = (execution.next_day(calendar, settle) or settle) if settle else None
    load_end = max(d for d in (signal, open_day, settle, open_exit) if d)
    prices = load_price_range(conn, codes, signal, load_end)
    buys = set(plan["buy"])
    # 下一节点顺延卖出的仓位实际出场在次日开盘, 明细按真实成交价展示。
    next_marks = _sell_marks(conn, settle, settle).get(settle, {}) if settle else {}

    def enrich(pick: dict[str, Any]) -> dict[str, Any]:
        row = dict(pick)
        code = pick["code"]
        sell_at = execution.sell_at(pick["pre_rank"]) if pick.get("action") == "sell" else None
        if pick.get("held"):
            entry = price_at(prices, code, open_day, "open") if code in buys else price_at(prices, code, signal)
            if next_marks.get(code) == execution.SELL_OPEN:
                exit_ = price_at(prices, code, open_exit, "open")
            else:
                exit_ = price_at(prices, code, settle)
            ret = exit_ / entry - 1 if entry and exit_ else None
        elif sell_at == "close":
            entry = price_at(prices, code, signal)
            exit_ = None
            ret = 0.0  # 周四收盘已退出, 不再承担后续涨跌
        elif sell_at == "open":
            entry = price_at(prices, code, signal)
            exit_ = price_at(prices, code, open_day, "open")
            ret = exit_ / entry - 1 if entry and exit_ else None
        else:
            entry = price_at(prices, code, signal)
            exit_ = None
            ret = None
        row["theme"] = themes.theme_of(pick.get("name"))
        row["sell_at"] = sell_at
        row["price"] = price_at(prices, code, signal)
        row["entry_price"] = entry if pick.get("held") else None
        row["next_price"] = exit_ if pick.get("held") else None
        row["return"] = ret
        return row

    data = dict(node)
    data["holdings"] = [enrich(p) for p in node["holdings"]]
    data["sells"] = [enrich(p) for p in node["sells"]]
    data["ranked"] = [enrich(p) for p in node["ranked"]]
    if settle:
        data["return"] = execution.settle(plan, prices, signal, open_day or settle, settle)["mean"]
    else:
        data["return"] = None
    return data


def timeline(
    conn: sqlite3.Connection,
    start: str | None = None,
    end: str | None = None,
) -> list[dict[str, Any]]:
    """持仓区间: 连续持有的节点合并成一段, 卖出节点即区间终点。"""
    nodes = core_store.list_nodes(conn, start, end)
    if not nodes:
        return []
    dates = [n["signal_date"] for n in nodes]
    holdings = core_store.holdings_by_node(conn, start, end)
    plans = _plans(conn, end)
    sell_marks = _sell_marks(conn, start, end)
    codes = _codes(holdings, plans)
    data_end = max((n["next_rebalance"] or n["signal_date"]) for n in nodes)
    calendar = features.trading_days(conn)
    prices = load_price_range(conn, codes, dates[0], data_end)

    spells: list[dict[str, Any]] = []
    live: dict[str, dict[str, Any]] = {}
    for date in dates:
        current = {p["code"]: p for p in holdings.get(date, [])}
        for code in [c for c in live if c not in current]:
            spell = live.pop(code)
            spell["exit"] = date
            spells.append(spell)
        for code, pick in current.items():
            opened = live.get(code)
            if opened is None:
                live[code] = {
                    "code": code,
                    "name": pick.get("name"),
                    "theme": themes.theme_of(pick.get("name")),
                    "entry": date,
                    "exit": None,
                    "nodes": 1,
                    "entry_rank": pick["core_rank"],
                    "last_rank": pick["core_rank"],
                }
            else:
                opened["nodes"] += 1
                opened["last_rank"] = pick["core_rank"]
    spells.extend(live.values())

    for spell in spells:
        entry, exit_ = spell["entry"], spell["exit"]
        bought = spell["code"] in set((plans.get(entry) or {}).get("buy", []))
        entry_day = execution.next_day(calendar, entry)
        spell["entry_price"] = (
            price_at(prices, spell["code"], entry_day, "open") if bought else price_at(prices, spell["code"], entry)
        )
        if exit_ is None:
            spell["exit_price"] = None
        elif sell_marks.get(exit_, {}).get(spell["code"]) == execution.SELL_CLOSE:
            spell["exit_price"] = price_at(prices, spell["code"], exit_)
        else:
            spell["exit_price"] = price_at(prices, spell["code"], execution.next_day(calendar, exit_), "open")
        p0, p1 = spell["entry_price"], spell["exit_price"]
        spell["holding"] = exit_ is None
        spell["return"] = p1 / p0 - 1 if p0 and p1 else None
    spells.sort(key=lambda s: (s["entry"], s["code"]))
    return spells
