"""Read the same prior-share core8 ranking used by the weak-spell replay."""
import json
import sqlite3
import sys
from pathlib import Path

project = Path(__file__).resolve().parents[1] / "Pentad"
sys.path.insert(0, str(project / "backend"))
from services.scoring.core.data import load_context, score_signal

signal = sys.argv[1]
conn = sqlite3.connect((project / ".localdata/dailyscope.db").as_uri() + "?mode=ro", uri=True)
conn.row_factory = sqlite3.Row
rows = score_signal(load_context(conn, signal), signal, shares_before=True)
print(json.dumps([["sh" + r["code"], dict(date=signal, score=r["core_score"], rank=r["core_rank"],
    poolSize=len(rows), factors=r["core_factors"])] for r in rows if r["code"] in {"512800", "515220", "515450"}]))
