"""
FastAPI REST API — Upload, Provision & Real-Time Sync Endpoints.

Serves as the central backend for ExcelSQLiteLiveSync:
  • POST /api/v1/upload-and-provision   → upload .xlsx, create SQLite table, inject manifest
  • POST /api/v1/realtime-sync          → cell-level sync from Excel taskpane → SQLite
"""

import os
import tempfile
import uuid
from datetime import datetime, timezone

import pandas as pd
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse

from .database import (
    DB_PATH,
    column_exists,
    create_sqlite_table_from_df,
    read_cell,
    table_exists,
    update_cell,
    validate_identifier,
)
from .openxml_injector import inject_taskpane_manifest
from .schemas import CellValueResponse, SyncRequest, SyncResponse

# ═══════════════════════════════════════════════════════════════════════════
# Application Factory
# ═══════════════════════════════════════════════════════════════════════════
app = FastAPI(
    title="ExcelSQLiteLiveSync API",
    description=(
        "Upload Excel files, auto-provision SQLite queue tables, inject Office "
        "Web Add-in manifests, and sync cell edits in real time."
    ),
    version="1.0.0",
)

# ── CORS — Allow all origins for local dev ───────────────────────────────
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["X-Table-ID", "X-Row-Count", "X-Column-Count"],
)

# Temp directory for storing processed files (cleaned up manually or by OS)
_UPLOAD_DIR = tempfile.mkdtemp(prefix="excelsync_uploads_")


# ═══════════════════════════════════════════════════════════════════════════
# Endpoints
# ═══════════════════════════════════════════════════════════════════════════


@app.post("/api/v1/upload-and-provision")
async def upload_and_provision(file: UploadFile = File(...)):
    """
    Upload an .xlsx file → parse → create & seed SQLite table → inject
    taskpane manifest → return modified file as download.

    Response Headers:
        X-Table-ID      — The generated table name
        X-Row-Count     — Number of rows seeded
        X-Column-Count  — Number of columns
    """
    # ── Validate file type ───────────────────────────────────────────────
    if not file.filename or not file.filename.lower().endswith(".xlsx"):
        raise HTTPException(
            status_code=400,
            detail="Only .xlsx files are supported.",
        )

    # ── Save uploaded file to a temp location ────────────────────────────
    original_name = file.filename
    safe_name = original_name.replace(" ", "_")
    input_path = os.path.join(_UPLOAD_DIR, f"raw_{uuid.uuid4().hex}_{safe_name}")
    output_path = os.path.join(
        _UPLOAD_DIR, f"configured_{uuid.uuid4().hex}_{safe_name}"
    )

    try:
        contents = await file.read()
        with open(input_path, "wb") as f:
            f.write(contents)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"File save error: {exc}")

    # ── Parse Excel with pandas ──────────────────────────────────────────
    try:
        df = pd.read_excel(input_path, engine="openpyxl")
    except Exception as exc:
        raise HTTPException(
            status_code=400,
            detail=f"Failed to parse Excel file: {exc}",
        )

    if df.empty:
        raise HTTPException(
            status_code=400,
            detail="The uploaded Excel file contains no data rows.",
        )

    # ── Generate unique table name ───────────────────────────────────────
    short_uuid = uuid.uuid4().hex[:8].upper()
    table_id = f"QUEUE_BOARD_{short_uuid}"

    # ── Provision SQLite table & seed data ───────────────────────────────
    try:
        result = create_sqlite_table_from_df(table_id, df)
    except RuntimeError as exc:
        raise HTTPException(status_code=500, detail=str(exc))

    # ── Inject Office Web Add-in taskpane manifest ───────────────────────
    try:
        inject_taskpane_manifest(
            input_xlsx_path=input_path,
            output_xlsx_path=output_path,
            manifest_url="https://localhost:3000/taskpane.html",
            table_id=table_id,
        )
    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail=f"Manifest injection failed: {exc}",
        )

    # ── Return modified file with metadata headers ───────────────────────
    download_name = f"configured_{table_id}_{safe_name}"
    response = FileResponse(
        path=output_path,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        filename=download_name,
    )
    response.headers["X-Table-ID"] = table_id
    response.headers["X-Row-Count"] = str(result["row_count"])
    response.headers["X-Column-Count"] = str(result["column_count"])
    return response


@app.post("/api/v1/realtime-sync", response_model=SyncResponse)
async def realtime_sync(payload: SyncRequest):
    """
    Receive a single cell-edit event from the Excel taskpane and apply it
    to the corresponding SQLite row.
    """
    table_id = payload.table_id.strip().upper()
    column_name = payload.column_name.strip().upper()
    row_id = payload.row_id
    new_value = payload.new_value

    # ── Validate identifiers ─────────────────────────────────────────────
    if not validate_identifier(table_id):
        raise HTTPException(
            status_code=400,
            detail=f"Invalid table identifier: {table_id}",
        )
    if not validate_identifier(column_name):
        raise HTTPException(
            status_code=400,
            detail=f"Invalid column identifier: {column_name}",
        )

    # ── Check table and column exist ─────────────────────────────────────
    if not table_exists(table_id):
        raise HTTPException(
            status_code=404,
            detail=f"Table '{table_id}' does not exist.",
        )
    if not column_exists(table_id, column_name):
        raise HTTPException(
            status_code=404,
            detail=f"Column '{column_name}' not found in table '{table_id}'.",
        )

    # ── Execute update ───────────────────────────────────────────────────
    try:
        update_result = update_cell(table_id, column_name, row_id, new_value)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except RuntimeError as exc:
        raise HTTPException(status_code=500, detail=str(exc))

    action = "Updated" if update_result["changed"] else "Verified"
    return SyncResponse(
        status="SUCCESS",
        timestamp=datetime.now(timezone.utc).isoformat(),
        message=f"{action} {table_id}.{column_name} @ ROW_ID={row_id}",
        persisted_value=update_result["persisted_value"],
        changed=update_result["changed"],
        database_path=str(DB_PATH),
    )


@app.get("/api/v1/cell-value", response_model=CellValueResponse)
async def get_cell_value(table_id: str, row_id: int, column_name: str):
    """Read a single persisted value without modifying SQLite."""
    normalized_table = table_id.strip().upper()
    normalized_column = column_name.strip().upper()

    if not validate_identifier(normalized_table):
        raise HTTPException(status_code=400, detail="Invalid table identifier.")
    if not validate_identifier(normalized_column):
        raise HTTPException(status_code=400, detail="Invalid column identifier.")
    if not table_exists(normalized_table):
        raise HTTPException(status_code=404, detail="Table does not exist.")
    if not column_exists(normalized_table, normalized_column):
        raise HTTPException(status_code=404, detail="Column does not exist.")

    try:
        value = read_cell(normalized_table, normalized_column, row_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except RuntimeError as exc:
        raise HTTPException(status_code=500, detail=str(exc))

    return CellValueResponse(
        table_id=normalized_table,
        row_id=row_id,
        column_name=normalized_column,
        value=value,
        database_path=str(DB_PATH),
    )


@app.get("/api/v1/realtime-sync")
async def realtime_sync_help():
    return {
        "status": "ok",
        "message": "Use POST /api/v1/realtime-sync with JSON payload to update SQLite.",
    }


# ═══════════════════════════════════════════════════════════════════════════
# Health check
# ═══════════════════════════════════════════════════════════════════════════
@app.get("/health")
async def health():
    return {"status": "ok", "service": "ExcelSQLiteLiveSync"}
