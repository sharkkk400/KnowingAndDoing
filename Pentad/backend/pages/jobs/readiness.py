"""回测数据就绪度：缺口、异常值、份额/指数覆盖与周度网格规模, 并提供 /api/dataset 只读接口。

口径说明:
- 缺口 = 标的[首根,末根]区间内的交易日槽位数 - 实际行数; 停牌也会计入,
  所以"缺口"是待解释项而不是错误项;
- 异常值只做可疑标记: 零/负价格、零成交量、单日涨跌超 30%(疑似除权或坏数据);
- 不做幸存者偏差修复: 已退市标的整体不在库内, 审计只能如实报告在册规模。
"""

from __future__ import annotations

from bisect import bisect_left, bisect_right
from typing import Any

from fastapi import APIRouter

from data.config import BACKFILL_START_DATE, INDEX_CODES
from data.store import daily_repo, index_repo, shares_repo
from data.store.database import get_conn

_JUMP_THRESHOLD = 0.3  # 单日 |涨跌| 超 30% 基本不是正常 ETF 波动(涨停板最宽 20%)
_TOP_GAPS = 5
_JUMP_SQL = f"""
    SELECT COUNT(*) AS n FROM (
        SELECT close, LAG(close) OVER (PARTITION BY code ORDER BY date) AS prev FROM etf_daily {{where}}
    ) WHERE prev > 0 AND close > 0 AND ABS(close / prev - 1) > {_JUMP_THRESHOLD}
"""


def dataset_summary() -> dict[str, Any]:
    calendar = [r["date"] for r in get_conn().execute("SELECT date FROM trade_calendar ORDER BY date")]
    spans = daily_repo.stats_per_code()
    gaps = _gaps(calendar, spans)
    return {
        "calendar": {
            "days": len(calendar),
            "first": calendar[0] if calendar else None,
            "last": calendar[-1] if calendar else None,
        },
        "daily": _daily_stats(spans),
        "shares": _shares_stats(),
        "share_scale": _share_scale_stats(),
        "index": _index_stats(),
        "gaps": gaps,
        "anomalies": _anomalies(),
        "list_date_missing": (
            get_conn().execute("SELECT COUNT(*) AS n FROM etfs WHERE list_date IS NULL").fetchone()["n"]
        ),
    }


def _daily_stats(spans: dict[str, tuple[str, str, int]]) -> dict[str, Any]:
    firsts = [s[0] for s in spans.values()]
    lasts = [s[1] for s in spans.values()]
    no_data = (
        get_conn()
        .execute("SELECT COUNT(*) AS n FROM etfs e WHERE NOT EXISTS (SELECT 1 FROM etf_daily d WHERE d.code = e.code)")
        .fetchone()["n"]
    )
    return {
        "codes": len(spans),
        "rows": sum(s[2] for s in spans.values()),
        "first": min(firsts) if firsts else None,
        "last": max(lasts) if lasts else None,
        "no_data": no_data,
    }


def _shares_stats() -> dict[str, Any]:
    row = (
        get_conn()
        .execute("SELECT COUNT(DISTINCT code) AS codes, COUNT(*) AS n, MIN(date) AS f, MAX(date) AS l FROM etf_shares")
        .fetchone()
    )
    return {"codes": row["codes"], "rows": row["n"], "first": row["f"], "last": row["l"]}


def _share_scale_stats() -> dict[str, Any]:
    """份额跳变甄别覆盖度: 折算(split)/真实申赎(flow)/待甄别(未入库)。"""
    jumps = shares_repo.jump_candidates()
    methods = {(e["code"], e["date"]): e["method"] for e in shares_repo.scale_events()}
    splits = [j for j in jumps if methods.get((j["code"], j["date"])) == "split"]
    flows = sum(1 for j in jumps if methods.get((j["code"], j["date"])) == "flow")
    return {
        "threshold": shares_repo.JUMP_SCAN_RATIO,
        "jumps": len(jumps),
        "split": len(splits),
        "flow": flows,
        "unverified": len(jumps) - len(splits) - flows,
        "recent_split": [
            {"code": j["code"], "date": j["date"], "ratio": round(j["ratio"], 3)}
            for j in sorted(splits, key=lambda x: x["date"])[-5:]
        ],
    }


def _index_stats() -> dict[str, Any]:
    row = (
        get_conn()
        .execute("SELECT COUNT(DISTINCT code) AS codes, COUNT(*) AS n, MAX(date) AS l FROM index_daily")
        .fetchone()
    )
    return {"configured": len(INDEX_CODES), "codes": row["codes"], "rows": row["n"], "last": row["l"]}


def _gaps(calendar: list[str], spans: dict[str, tuple[str, str, int]]) -> dict[str, Any]:
    """逐标的核对区间内交易日槽位; 返回汇总与缺口最大的几只用例。"""
    total = 0
    affected = 0
    detail: list[dict[str, Any]] = []
    for code, (first, last, rows) in spans.items():
        slots = bisect_right(calendar, last) - bisect_left(calendar, first)
        missing = max(0, slots - rows)
        if missing:
            affected += 1
            total += missing
            detail.append({"code": code, "missing": missing, "first": first, "last": last})
    detail.sort(key=lambda x: -x["missing"])
    return {"codes": affected, "days": total, "top": detail[:_TOP_GAPS]}


def _anomalies() -> dict[str, Any]:
    """全历史与份额起点后的可疑行数。

    2015 前的负价/巨幅跳变集中在 510050/510880, 是腾讯前复权因子失效导致的假价格;
    回测窗口以份额起点(BACKFILL_START_DATE)为界即可规避, 更早历史需改缓存后复权。
    """
    conn = get_conn()
    since = BACKFILL_START_DATE

    def scalar(sql: str, params: tuple[str, ...] = ()) -> int:
        return int(conn.execute(sql, params).fetchone()["n"])

    result: dict[str, Any] = {"since": since}
    for key, cond in (
        ("zero_volume", "volume IS NULL OR volume <= 0"),
        ("bad_close", "close IS NULL OR close <= 0"),
    ):
        result[key] = scalar(f"SELECT COUNT(*) AS n FROM etf_daily WHERE ({cond}) AND date >= ?", (since,))
        result[f"{key}_all"] = scalar(f"SELECT COUNT(*) AS n FROM etf_daily WHERE {cond}")
    result["jump_gt_30pct"] = scalar(_JUMP_SQL.format(where="WHERE date >= ?"), (since,))
    result["jump_gt_30pct_all"] = scalar(_JUMP_SQL.format(where=""))
    return result


def index_coverage() -> list[dict[str, Any]]:
    """配置内的全部指数覆盖(未入库的也列出), 供页面核对。"""
    stats = index_repo.stats_per_code()
    names = {r["code"]: r["name"] for r in get_conn().execute("SELECT code, name FROM indices")}
    return [
        {
            "code": code,
            "name": names.get(code),
            "first": stats.get(code, (None, None, 0))[0],
            "last": stats.get(code, (None, None, 0))[1],
            "rows": stats.get(code, (None, None, 0))[2],
        }
        for code in INDEX_CODES
    ]


router = APIRouter(prefix="/api/dataset", tags=["dataset"])


@router.get("/summary")
def summary() -> dict[str, Any]:
    return dataset_summary()


@router.get("/indices")
def indices() -> list[dict[str, Any]]:
    return index_coverage()
