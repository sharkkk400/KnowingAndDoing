"""Local comparison workstation; the original refresh chain is available on demand."""
from pathlib import Path

from fastapi import HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from main import app

dist = Path(__file__).resolve().parents[1] / "frontend" / "dist"
app.mount("/assets", StaticFiles(directory=dist / "assets"), name="assets")

@app.get("/{page:path}", include_in_schema=False)
def reference_page(page: str) -> FileResponse:
    if page.startswith("api/"):
        raise HTTPException(status_code=404)
    return FileResponse(dist / "index.html")
