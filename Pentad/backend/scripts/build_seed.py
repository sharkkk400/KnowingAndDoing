"""从本地已有数据库导出预热快照(gzip CSV + manifest)到 backend/seed/。

用法:
    python scripts/build_seed.py [--src ~/.dailyscope/dailyscope.db] [--out seed]

快照含原始数据表(清单/日历/日K/份额/折算/指数)与 fitted_* 派生表(core8 节点 +
日度记录), 派生表按 signal_date 截到日K截止日; 导出后随仓库分发, 新环境一键准备
时先装载再补齐增量。
"""

# ruff: noqa: E402

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from ops import seed


def main() -> None:
    parser = argparse.ArgumentParser(description="导出 DailyScope 预热快照")
    parser.add_argument("--src", default=str(Path.home() / ".dailyscope" / "dailyscope.db"))
    parser.add_argument("--out", default=str(seed.SEED_DIR))
    args = parser.parse_args()
    info = seed.build(args.src, Path(args.out))
    rows = sum(t["rows"] for t in info["tables"].values())
    print(f"cutoff={info['cutoff']} tables={len(info['tables'])} rows={rows} -> {args.out}")


if __name__ == "__main__":
    main()
