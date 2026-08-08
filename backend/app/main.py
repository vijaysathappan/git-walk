"""
FastAPI REST API — Upload, Provision & Real-Time Sync Endpoints.

Serves as the central backend for Git Walk:
  • POST /api/v1/upload-and-provision   → upload .xlsx, create SQLite table, inject manifest
  • POST /api/v1/realtime-sync          → cell-level sync from Excel taskpane → SQLite
"""

import os
import io
import json
import re
import sqlite3
import tempfile
import urllib.error
import urllib.request
import uuid
from contextlib import asynccontextmanager
from datetime import datetime, timezone

import pandas as pd
from fastapi import Depends, FastAPI, File, HTTPException, Query, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse

from .config import settings
from .database import (
    DB_PATH,
    VersionConflictError,
    add_dataset_member,
    apply_bulk_updates,
    apply_workbook_commit,
    column_exists,
    create_sqlite_table_from_df,
    delete_user_ai_settings,
    get_audit_history,
    get_dataset_members,
    get_user_ai_settings,
    get_kpis,
    get_table_page,
    get_table_snapshot,
    initialize_product_schema,
    list_datasets,
    list_active_presence,
    read_cell,
    remove_dataset_presence,
    register_dataset,
    rollback_batch,
    save_user_ai_settings,
    table_exists,
    touch_dataset_presence,
    user_can_access_table,
    user_can_edit_table,
    validate_identifier,
)
from .openxml_injector import inject_taskpane_manifest
from .schemas import (
    AIConfigRequest,
    AIInsightRequest,
    BulkSyncRequest,
    CellValueResponse,
    DatasetMemberRequest,
    LoginRequest,
    LoginVerifyRequest,
    PresenceRequest,
    RollbackRequest,
    SyncRequest,
    SyncResponse,
    WorkbookCommitRequest,
)
from .security import Principal, current_principal, send_login_code, verify_login_code
from .secret_store import decrypt_secret, encrypt_secret

# ═══════════════════════════════════════════════════════════════════════════
# Application Factory
# ═══════════════════════════════════════════════════════════════════════════
@asynccontextmanager
async def lifespan(_app: FastAPI):
    initialize_product_schema()
    yield


app = FastAPI(
    title="Git Walk API",
    description=(
        "Upload Excel files, auto-provision SQLite queue tables, inject Office "
        "Web Add-in manifests, and sync cell edits in real time."
    ),
    version="2.0.0",
    lifespan=lifespan,
)

# ── CORS — Allow all origins for local dev ───────────────────────────────
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=[
        "X-Table-ID",
        "X-Row-Count",
        "X-Column-Count",
        "X-Owner-User-ID",
    ],
)

# Temp directory for storing processed files (cleaned up manually or by OS)
_UPLOAD_DIR = tempfile.mkdtemp(prefix="excelsync_uploads_")


def _normalize_table_id(table_id: str) -> str:
    normalized = table_id.strip().upper()
    if not validate_identifier(normalized):
        raise HTTPException(status_code=400, detail="Invalid table identifier.")
    return normalized


def _ensure_access(table_id: str, principal: Principal, write: bool = False) -> str:
    normalized = _normalize_table_id(table_id)
    if not table_exists(normalized):
        raise HTTPException(status_code=404, detail="Dataset does not exist.")
    allowed = (
        user_can_edit_table(normalized, principal.user_id)
        if write else user_can_access_table(normalized, principal.user_id)
    )
    if not allowed:
        detail = "Editor access is required." if write else "You do not have access to this dataset."
        raise HTTPException(status_code=403, detail=detail)
    return normalized


def _valid_email(email: str) -> str:
    normalized = email.strip().lower()
    if not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", normalized):
        raise HTTPException(status_code=400, detail="Enter a valid email address.")
    return normalized


def _ai_credentials(principal: Principal) -> tuple[str, str, bool]:
    stored = get_user_ai_settings(principal.user_id)
    if stored:
        try:
            return decrypt_secret(stored["api_key_encrypted"]), stored["model"], True
        except ValueError as exc:
            raise HTTPException(status_code=500, detail="Saved AI credentials cannot be decrypted.") from exc
    return settings.openrouter_api_key, settings.openrouter_model, False


def _openrouter_models(api_key: str) -> list[str]:
    request = urllib.request.Request(
        "https://openrouter.ai/api/v1/models",
        headers={"Authorization": f"Bearer {api_key}"},
        method="GET",
    )
    with urllib.request.urlopen(request, timeout=20) as response:
        payload = json.loads(response.read().decode("utf-8"))
    return sorted(
        item["id"] for item in payload.get("data", [])
        if isinstance(item, dict) and item.get("id")
    )


# ═══════════════════════════════════════════════════════════════════════════
# Endpoints
# ═══════════════════════════════════════════════════════════════════════════


@app.post("/api/v1/auth/request-code")
async def request_login_code(payload: LoginRequest):
    email = _valid_email(payload.email)
    dev_otp = send_login_code(email)
    response = {"status": "sent", "email": email}
    if dev_otp:
        response["dev_otp"] = dev_otp
    return response


@app.post("/api/v1/auth/verify-code")
async def verify_code(payload: LoginVerifyRequest):
    email = _valid_email(payload.email)
    user, token = verify_login_code(email, payload.code)
    return {"token": token, "user": user}


@app.get("/api/v1/auth/me")
async def auth_me(principal: Principal = Depends(current_principal)):
    return {"user_id": principal.user_id, "email": principal.email}


@app.post("/api/v1/upload-and-provision")
async def upload_and_provision(
    file: UploadFile = File(...),
    principal: Principal = Depends(current_principal),
):
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

    register_dataset(
        table_id,
        principal.user_id,
        original_name,
        result["row_count"],
        result["column_count"],
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
    response.headers["X-Owner-User-ID"] = principal.user_id
    return response


@app.post("/api/v1/realtime-sync", response_model=SyncResponse)
async def realtime_sync(
    payload: SyncRequest,
    principal: Principal = Depends(current_principal),
):
    """
    Receive a single cell-edit event from the Excel taskpane and apply it
    to the corresponding SQLite row.
    """
    table_id = _ensure_access(payload.table_id, principal, write=True)
    column_name = payload.column_name.strip().upper()
    row_id = payload.row_id
    new_value = payload.new_value

    # ── Validate identifiers ─────────────────────────────────────────────
    if not validate_identifier(column_name):
        raise HTTPException(
            status_code=400,
            detail=f"Invalid column identifier: {column_name}",
        )

    # ── Check table and column exist ─────────────────────────────────────
    if not column_exists(table_id, column_name):
        raise HTTPException(
            status_code=404,
            detail=f"Column '{column_name}' not found in table '{table_id}'.",
        )

    # ── Execute update ───────────────────────────────────────────────────
    try:
        batch = apply_bulk_updates(
            table_id,
            [{"row_id": row_id, "column_name": column_name, "new_value": new_value}],
            principal.user_id,
            principal.email,
            source=payload.source,
            commit_message=payload.commit_message,
        )
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except RuntimeError as exc:
        raise HTTPException(status_code=500, detail=str(exc))

    update_result = batch["results"][0]
    action = "Updated" if update_result["changed"] else "Verified"
    return SyncResponse(
        status="SUCCESS",
        timestamp=datetime.now(timezone.utc).isoformat(),
        message=f"{action} {table_id}.{column_name} @ ROW_ID={row_id}",
        persisted_value=update_result["persisted_value"],
        changed=update_result["changed"],
        database_path=str(DB_PATH),
    )


@app.post("/api/v1/bulk-sync")
async def bulk_sync(
    payload: BulkSyncRequest,
    principal: Principal = Depends(current_principal),
):
    table_id = _ensure_access(payload.table_id, principal, write=True)
    try:
        return apply_bulk_updates(
            table_id,
            [change.model_dump() for change in payload.changes],
            principal.user_id,
            principal.email,
            source=payload.source,
            commit_message=payload.commit_message,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except RuntimeError as exc:
        raise HTTPException(status_code=500, detail=str(exc))


@app.post("/api/v1/workbook-commit")
async def workbook_commit(
    payload: WorkbookCommitRequest,
    principal: Principal = Depends(current_principal),
):
    table_id = _ensure_access(payload.table_id, principal, write=True)
    try:
        return apply_workbook_commit(
            table_id=table_id,
            base_version=payload.base_version,
            updates=[change.model_dump() for change in payload.updates],
            insert_rows=payload.insert_rows,
            delete_row_ids=payload.delete_row_ids,
            new_columns=payload.new_columns,
            delete_columns=payload.delete_columns,
            user_id=principal.user_id,
            user_email=principal.email,
            source=payload.source,
            commit_message=payload.commit_message,
        )
    except VersionConflictError as exc:
        raise HTTPException(
            status_code=409,
            detail={
                "code": "VERSION_CONFLICT",
                "message": "The server changed after this workbook was last pulled.",
                "base_version": payload.base_version,
                "current_version": exc.current_version,
            },
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except RuntimeError as exc:
        raise HTTPException(status_code=500, detail=str(exc))


@app.get("/api/v1/cell-value", response_model=CellValueResponse)
async def get_cell_value(
    table_id: str,
    row_id: int,
    column_name: str,
    principal: Principal = Depends(current_principal),
):
    """Read a single persisted value without modifying SQLite."""
    normalized_table = _ensure_access(table_id, principal)
    normalized_column = column_name.strip().upper()

    if not validate_identifier(normalized_column):
        raise HTTPException(status_code=400, detail="Invalid column identifier.")
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


@app.get("/api/v1/datasets")
async def datasets(principal: Principal = Depends(current_principal)):
    return {"datasets": list_datasets(principal.user_id)}


@app.get("/api/v1/datasets/{table_id}/data")
async def dataset_data(
    table_id: str,
    limit: int = Query(default=100, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
    principal: Principal = Depends(current_principal),
):
    normalized = _ensure_access(table_id, principal)
    try:
        return get_table_page(normalized, limit, offset)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc))


@app.get("/api/v1/datasets/{table_id}/snapshot")
async def dataset_snapshot(
    table_id: str,
    version: int | None = Query(default=None, ge=0),
    principal: Principal = Depends(current_principal),
):
    normalized = _ensure_access(table_id, principal)
    try:
        return get_table_snapshot(normalized, version=version)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@app.get("/api/v1/datasets/{table_id}/history")
async def dataset_history(
    table_id: str,
    limit: int = Query(default=100, ge=1, le=1000),
    principal: Principal = Depends(current_principal),
):
    normalized = _ensure_access(table_id, principal)
    return {"history": get_audit_history(normalized, limit)}


@app.get("/api/v1/datasets/{table_id}/members")
async def dataset_members(
    table_id: str,
    principal: Principal = Depends(current_principal),
):
    normalized = _ensure_access(table_id, principal)
    return {"members": get_dataset_members(normalized)}


@app.post("/api/v1/datasets/{table_id}/members")
async def add_member(
    table_id: str,
    payload: DatasetMemberRequest,
    principal: Principal = Depends(current_principal),
):
    normalized = _ensure_access(table_id, principal)
    try:
        return add_dataset_member(
            normalized, principal.user_id, _valid_email(payload.email), payload.role
        )
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@app.get("/api/v1/datasets/{table_id}/presence")
async def dataset_presence(
    table_id: str,
    principal: Principal = Depends(current_principal),
):
    normalized = _ensure_access(table_id, principal)
    return {"active_users": list_active_presence(normalized)}


@app.post("/api/v1/datasets/{table_id}/presence")
async def heartbeat_presence(
    table_id: str,
    payload: PresenceRequest,
    principal: Principal = Depends(current_principal),
):
    normalized = _ensure_access(table_id, principal)
    touch_dataset_presence(
        normalized, principal.user_id, payload.client_id,
        payload.surface, payload.activity,
    )
    return {"active_users": list_active_presence(normalized)}


@app.delete("/api/v1/datasets/{table_id}/presence")
async def leave_dataset_presence(
    table_id: str,
    client_id: str,
    principal: Principal = Depends(current_principal),
):
    normalized = _ensure_access(table_id, principal)
    remove_dataset_presence(normalized, principal.user_id, client_id)
    return {"status": "offline"}


@app.post("/api/v1/datasets/rollback")
async def rollback_change_set(
    payload: RollbackRequest,
    principal: Principal = Depends(current_principal),
):
    normalized = _ensure_access(payload.table_id, principal, write=True)
    try:
        return rollback_batch(normalized, payload.batch_id, principal.user_id, principal.email)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc))


@app.get("/api/v1/analytics/kpis")
async def analytics_kpis(
    table_id: str | None = None,
    principal: Principal = Depends(current_principal),
):
    normalized = _ensure_access(table_id, principal) if table_id else None
    return get_kpis(principal.user_id, normalized)


@app.get("/api/v1/datasets/{table_id}/export")
async def export_dataset(
    table_id: str,
    format: str = Query(default="xlsx", pattern="^(xlsx|csv)$"),
    principal: Principal = Depends(current_principal),
):
    normalized = _ensure_access(table_id, principal)
    conn = sqlite3.connect(str(DB_PATH))
    try:
        frame = pd.read_sql_query(f'SELECT * FROM "{normalized}" ORDER BY ROW_ID', conn)
    finally:
        conn.close()

    if format == "csv":
        content = io.BytesIO(frame.to_csv(index=False).encode("utf-8"))
        media_type = "text/csv"
    else:
        content = io.BytesIO()
        with pd.ExcelWriter(content, engine="openpyxl") as writer:
            frame.to_excel(writer, index=False, sheet_name="Latest Data")
        content.seek(0)
        media_type = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"

    return StreamingResponse(
        content,
        media_type=media_type,
        headers={"Content-Disposition": f'attachment; filename="{normalized}.{format}"'},
    )


@app.get("/api/v1/ai/models")
async def ai_models(principal: Principal = Depends(current_principal)):
    api_key, model, user_configured = _ai_credentials(principal)
    models = settings.openrouter_models
    if api_key:
        try:
            models = _openrouter_models(api_key)
        except Exception:
            models = list(dict.fromkeys([model, *settings.openrouter_models]))
    return {
        "configured": bool(api_key),
        "user_configured": user_configured,
        "masked_key": f"...{api_key[-4:]}" if api_key else None,
        "default_model": model,
        "models": models,
    }


@app.post("/api/v1/ai/config")
async def save_ai_config(
    payload: AIConfigRequest,
    principal: Principal = Depends(current_principal),
):
    api_key = payload.api_key.strip()
    model = payload.model.strip()
    if not api_key.startswith("sk-or-"):
        raise HTTPException(status_code=400, detail="Enter a valid OpenRouter API key.")
    if not re.fullmatch(r"[A-Za-z0-9._:/-]+", model):
        raise HTTPException(status_code=400, detail="Invalid OpenRouter model identifier.")
    save_user_ai_settings(principal.user_id, encrypt_secret(api_key), model)
    return {
        "configured": True,
        "user_configured": True,
        "masked_key": f"...{api_key[-4:]}",
        "default_model": model,
    }


@app.delete("/api/v1/ai/config")
async def clear_ai_config(principal: Principal = Depends(current_principal)):
    delete_user_ai_settings(principal.user_id)
    return {"configured": bool(settings.openrouter_api_key)}


@app.post("/api/v1/ai/insights")
async def ai_insights(
    payload: AIInsightRequest,
    principal: Principal = Depends(current_principal),
):
    api_key, configured_model, user_configured = _ai_credentials(principal)
    if not api_key:
        raise HTTPException(
            status_code=503,
            detail="Connect an OpenRouter API key in Git Walk's AI copilot settings.",
        )
    table_id = _ensure_access(payload.table_id, principal) if payload.table_id else None
    context = {
        "kpis": get_kpis(principal.user_id, table_id),
        "recent_changes": get_audit_history(table_id, 20) if table_id else [],
    }
    model = payload.model or configured_model
    if not user_configured and model not in settings.openrouter_models:
        raise HTTPException(status_code=400, detail="Model is not in OPENROUTER_MODELS.")

    request_body = json.dumps(
        {
            "model": model,
            "messages": [
                {
                    "role": "system",
                    "content": (
                        "You are a data-governance copilot. Analyze change history, "
                        "surface anomalies and risks, and recommend concise actions."
                    ),
                },
                {
                    "role": "user",
                    "content": f"Question: {payload.question}\nContext: {json.dumps(context, default=str)}",
                },
            ],
        }
    ).encode("utf-8")
    request = urllib.request.Request(
        "https://openrouter.ai/api/v1/chat/completions",
        data=request_body,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "HTTP-Referer": "https://localhost:3000",
            "X-Title": "Git Walk",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=45) as response:
            result = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise HTTPException(status_code=502, detail=f"OpenRouter request failed: {detail}")
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"OpenRouter request failed: {exc}")

    return {
        "model": model,
        "insight": result["choices"][0]["message"]["content"],
    }


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
    return {"status": "ok", "service": "Git Walk"}
