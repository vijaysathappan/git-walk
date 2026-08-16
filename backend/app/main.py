"""
FastAPI REST API — Upload, Provision & Real-Time Sync Endpoints.

Serves as the central backend for Git Walk:
  • POST /api/v1/upload-and-provision   → upload .xlsx, create SQLite table, inject manifest
  • POST /api/v1/realtime-sync          → cell-level sync from Excel taskpane → SQLite
"""

import os
import asyncio
import io
import json
import logging
import re
import shutil
import sqlite3
import tempfile
import urllib.error
import urllib.request
import uuid
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd
from openpyxl import load_workbook
from fastapi import Depends, FastAPI, File, Form, HTTPException, Query, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from starlette.background import BackgroundTask

from .config import settings
from .database import (
    DB_PATH,
    VersionConflictError,
    advance_branch_head,
    add_dataset_member,
    apply_bulk_updates,
    apply_workbook_commit,
    authenticate_working_copy_identity,
    column_exists,
    create_sqlite_table_from_df,
    delete_user_ai_settings,
    get_audit_history,
    get_dataset_members,
    get_workspace_snapshot,
    get_user_ai_settings,
    get_kpis,
    get_table_page,
    get_table_snapshot,
    initialize_product_schema,
    list_datasets,
    list_active_presence,
    read_cell,
    resolve_repository_owner,
    remove_dataset_presence,
    remove_dataset_member,
    register_dataset,
    rollback_batch,
    save_user_ai_settings,
    store_initial_formula_metadata,
    table_exists,
    touch_dataset_presence,
    user_can_access_table,
    user_can_edit_table,
    validate_working_copy,
    validate_identifier,
    working_copy_required,
)
from .api.repositories import router as repositories_router
from .api.commits import router as commits_router
from .api.merge_requests import router as merge_requests_router
from .api.governance import router as governance_router
from .schemas import (
    AIConfigRequest,
    AIInsightRequest,
    BulkSyncRequest,
    CellValueResponse,
    DatasetMemberRequest,
    LoginRequest,
    LoginVerifyRequest,
    WorkbookAuthRequest,
    PresenceRequest,
    RollbackRequest,
    SyncRequest,
    SyncResponse,
    WorkbookCommitRequest,
)
from .security import (
    Principal,
    create_session_token,
    current_principal,
    logout_session,
    send_login_code,
    verify_login_code,
)
from .secret_store import decrypt_secret, encrypt_secret
from .services.workbook_service import issue_branch_workbook
from .services.commit_service import CommitActor, commit_service
from .repositories.commit_store import BranchHeadChangedError
from .repositories.governance_store import (
    list_audit_events,
    repository_id_for_table,
    repository_insights,
)
from .repositories.merge_store import branch_context
from .services.merge_service import MergeActor, merge_service
from .security_uploads import (
    UnsafeWorkbookError,
    inspect_xlsx,
    validate_workbook_dimensions,
    worksheet_data_dimensions,
)
from .observability import (
    metric_timer,
    new_request_context,
    record_audit_event,
    record_metric,
    record_security_event,
    structured_log,
)

# ═══════════════════════════════════════════════════════════════════════════
# Application Factory
# ═══════════════════════════════════════════════════════════════════════════
@asynccontextmanager
async def lifespan(_app: FastAPI):
    initialize_product_schema()
    cleanup_abandoned_uploads()
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
app.include_router(repositories_router)
app.include_router(commits_router)
app.include_router(merge_requests_router)
app.include_router(governance_router)

logging.basicConfig(
    level=getattr(logging, settings.log_level, logging.INFO),
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)


@app.middleware("http")
async def request_observability(request: Request, call_next):
    context = new_request_context(
        request.headers.get("X-Request-ID"), request.headers.get("X-Trace-ID")
    )
    started = asyncio.get_running_loop().time()
    status_code = 500
    try:
        response = await call_next(request)
        status_code = response.status_code
        return response
    except Exception:
        structured_log(logging.ERROR, "request_failed", path=request.url.path, method=request.method)
        raise
    finally:
        duration_ms = (asyncio.get_running_loop().time() - started) * 1000
        record_metric(
            "http_request_latency", duration_ms, "ms",
            status="SUCCESS" if status_code < 500 else "FAILED",
            tags={"method": request.method, "path": request.url.path, "status": status_code},
        )
        structured_log(
            logging.INFO, "request_completed", method=request.method,
            path=request.url.path, status=status_code, duration_ms=round(duration_ms, 2),
        )
        if 'response' in locals():
            response.headers["X-Request-ID"] = context.request_id
            response.headers["X-Trace-ID"] = context.trace_id
            response.headers["X-Content-Type-Options"] = "nosniff"
            response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
            response.headers["Cache-Control"] = "no-store"

# ── CORS — Allow all origins for local dev ───────────────────────────────
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=[
        "X-Table-ID",
        "X-Row-Count",
        "X-Column-Count",
        "X-Owner-User-ID",
        "X-Branch-Table-ID",
        "X-Repository-ID",
        "X-Branch-ID",
        "X-Working-Copy-ID",
        "X-Request-ID",
        "X-Trace-ID",
    ],
)

# Temp directory for storing processed files (cleaned up manually or by OS)
_UPLOAD_DIR = tempfile.mkdtemp(prefix="excelsync_uploads_")


def cleanup_abandoned_uploads() -> None:
    cutoff = datetime.now(timezone.utc).timestamp() - settings.temp_file_max_age_hours * 3600
    roots = [Path(tempfile.gettempdir())]
    prefixes = ("excelsync_uploads_", "gitwalk_working_copy_", "xlsx_inject_")
    for root in roots:
        for item in root.iterdir():
            try:
                if item.is_dir() and item.name.startswith(prefixes) and item.stat().st_mtime < cutoff:
                    shutil.rmtree(item, ignore_errors=True)
            except OSError:
                continue


def _parse_xlsx(
    path: str,
) -> tuple[list[str], dict[str, pd.DataFrame], dict[str, list[dict[str, object]]]]:
    workbook = load_workbook(path, read_only=True, data_only=False)
    try:
        sheet_names = workbook.sheetnames
        formulas_by_sheet = {}
        for sheet in workbook.worksheets:
            rows, columns = worksheet_data_dimensions(sheet)
            validate_workbook_dimensions(sheet_names, rows, columns)
            formulas_by_sheet[sheet.title] = [
                {
                    "row_position": row_index - 2,
                    "column_position": column_index - 1,
                    "formula": cell.value,
                }
                for row_index, row in enumerate(sheet.iter_rows(min_row=2), start=2)
                for column_index, cell in enumerate(row, start=1)
                if cell.data_type == "f" and isinstance(cell.value, str)
            ]
    finally:
        workbook.close()
    excel_file = pd.ExcelFile(path, engine="openpyxl")
    try:
        frames = pd.read_excel(excel_file, sheet_name=None)
        return sheet_names, frames, formulas_by_sheet
    finally:
        excel_file.close()


def _cleanup_download(input_path: str, output_path: str) -> None:
    Path(input_path).unlink(missing_ok=True)
    shutil.rmtree(Path(output_path).parent, ignore_errors=True)


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
        record_security_event(
            "ACCESS_DENIED", user_id=principal.user_id,
            details={"table_id": normalized, "write": write},
        )
        raise HTTPException(status_code=403, detail=detail)
    return normalized


def _valid_email(email: str) -> str:
    normalized = email.strip().lower()
    if not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", normalized):
        raise HTTPException(status_code=400, detail="Enter a valid email address.")
    return normalized


def _validate_workbook_identity(table_id: str, principal: Principal, payload) -> None:
    if not working_copy_required(table_id):
        return
    try:
        validate_working_copy(
            table_id=table_id,
            user_id=principal.user_id,
            repository_id=payload.repository_id,
            branch_id=payload.branch_id,
            working_copy_id=payload.working_copy_id,
            base_commit_id=payload.base_commit_id,
            issued_at=payload.issued_at,
            signature=payload.signature,
        )
    except PermissionError as exc:
        message = str(exc)
        if "no longer active" in message:
            raise HTTPException(
                status_code=409,
                detail={
                    "code": "WORKING_COPY_CLOSED",
                    "message": "This workspace has already been merged. Download latest main or create a new workspace.",
                },
            ) from exc
        record_security_event(
            "WORKING_COPY_IDENTITY_REJECTED", user_id=principal.user_id,
            details={"table_id": table_id, "reason": message},
        )
        raise HTTPException(status_code=403, detail=message) from exc


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
    try:
        dev_otp = send_login_code(email)
        record_audit_event(
            "LOGIN_REQUESTED", actor_user_id="USR_SYSTEM", actor_type="SYSTEM",
            payload={"email": email},
        )
    except Exception as exc:
        record_security_event(
            "LOGIN_REQUEST_BLOCKED", details={"email": email, "reason": str(exc)}
        )
        raise
    response = {"status": "sent", "email": email}
    if dev_otp:
        response["dev_otp"] = dev_otp
    return response


@app.post("/api/v1/auth/verify-code")
async def verify_code(payload: LoginVerifyRequest):
    email = _valid_email(payload.email)
    try:
        user, token = verify_login_code(email, payload.code)
    except Exception as exc:
        record_audit_event(
            "LOGIN_FAILED", actor_user_id="USR_SYSTEM", actor_type="SYSTEM",
            payload={"email": email}, status="FAILED", failure_reason="Invalid or expired code",
        )
        record_security_event("LOGIN_FAILED", details={"email": email, "reason": str(exc)})
        raise
    record_audit_event(
        "LOGIN_SUCCESS", actor_user_id=user["user_id"], payload={"email": email}
    )
    return {"token": token, "user": user}


@app.post("/api/v1/auth/workbook")
async def authenticate_workbook(payload: WorkbookAuthRequest):
    try:
        user = authenticate_working_copy_identity(**payload.model_dump())
    except PermissionError as exc:
        record_security_event(
            "WORKBOOK_AUTH_REJECTED",
            details={"working_copy_id": payload.working_copy_id, "reason": str(exc)},
        )
        raise HTTPException(status_code=401, detail=str(exc)) from exc
    token = create_session_token(user["user_id"], user["email"])
    record_audit_event(
        "WORKBOOK_AUTHENTICATED", actor_user_id=user["user_id"],
        repository_id=payload.repository_id, branch_id=payload.branch_id,
        working_copy_id=payload.working_copy_id,
    )
    return {"token": token, "user": user}


@app.get("/api/v1/auth/me")
async def auth_me(principal: Principal = Depends(current_principal)):
    return {"user_id": principal.user_id, "email": principal.email}


@app.post("/api/v1/auth/logout")
async def auth_logout(principal: Principal = Depends(current_principal)):
    logout_session(principal)
    record_audit_event("LOGOUT", actor_user_id=principal.user_id)
    return {"status": "signed_out"}


@app.post("/api/v1/upload-and-provision")
async def upload_and_provision(
    file: UploadFile = File(...),
    repository_name: str | None = Form(default=None),
    description: str | None = Form(default=None),
    category_id: str = Form(default="CAT_UNSORTED"),
    visibility: str = Form(default="private"),
    business_owner: str | None = Form(default=None),
    owner_email: str | None = Form(default=None),
    owner_employee_id: str | None = Form(default=None),
    data_classification: str = Form(default="internal"),
    retention_policy: str | None = Form(default=None),
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
    try:
        contents = await file.read(settings.max_upload_bytes + 1)
        upload_profile = inspect_xlsx(contents, original_name, file.content_type)
    except UnsafeWorkbookError as exc:
        record_audit_event(
            "WORKBOOK_UPLOAD_REJECTED", actor_user_id=principal.user_id,
            payload={"filename": original_name}, status="FAILED", failure_reason=str(exc),
        )
        record_security_event(
            "UNSAFE_WORKBOOK_UPLOAD", user_id=principal.user_id,
            details={"filename": original_name, "reason": str(exc)},
        )
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    safe_name = upload_profile["safe_filename"]
    input_path = os.path.join(_UPLOAD_DIR, f"raw_{uuid.uuid4().hex}_{safe_name}")
    output_path = os.path.join(
        _UPLOAD_DIR, f"configured_{uuid.uuid4().hex}_{safe_name}"
    )

    try:
        with open(input_path, "wb") as f:
            f.write(contents)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"File save error: {exc}")

    # ── Parse Excel with pandas ──────────────────────────────────────────
    try:
        with metric_timer("workbook_parsing_time", user_id=principal.user_id):
            sheet_names, frames, formulas_by_sheet = await asyncio.wait_for(
                asyncio.to_thread(_parse_xlsx, input_path),
                timeout=settings.upload_processing_timeout_seconds,
            )
        for frame in frames.values():
            validate_workbook_dimensions(sheet_names, len(frame.index), len(frame.columns))
    except (Exception, asyncio.TimeoutError) as exc:
        Path(input_path).unlink(missing_ok=True)
        record_metric("upload_failure", 1, "count", status="FAILED", user_id=principal.user_id)
        raise HTTPException(
            status_code=400,
            detail=f"Failed to parse Excel file: {exc}",
        )

    if not any(len(frame.index) or len(frame.columns) for frame in frames.values()):
        raise HTTPException(
            status_code=400,
            detail="The uploaded Excel file contains no data rows.",
        )

    owner_user_id = principal.user_id
    normalized_owner_email = (owner_email or principal.email).strip().lower()
    if normalized_owner_email != principal.email.lower() or owner_employee_id:
        normalized_owner_email = _valid_email(normalized_owner_email)
        delegated_owner = resolve_repository_owner(
            normalized_owner_email, owner_employee_id
        )
        owner_user_id = delegated_owner["user_id"]

    # ── Generate unique table name ───────────────────────────────────────
    short_uuid = uuid.uuid4().hex[:8].upper()
    table_id = f"QUEUE_BOARD_{short_uuid}"

    # ── Provision SQLite table & seed data ───────────────────────────────
    sheet_tables = []
    provisioned_results = []
    try:
        for index, sheet_name in enumerate(sheet_names):
            physical_table = (
                table_id if index == 0 else f"SHEET_DATA_{uuid.uuid4().hex[:12].upper()}"
            )
            sheet_result = create_sqlite_table_from_df(physical_table, frames[sheet_name])
            sheet_tables.append({"name": sheet_name, "table_id": physical_table})
            provisioned_results.append(sheet_result)
        result = provisioned_results[0]
    except RuntimeError as exc:
        raise HTTPException(status_code=500, detail=str(exc))

    # ── Inject Office Web Add-in taskpane manifest ───────────────────────
    register_dataset(
        table_id,
        owner_user_id,
        original_name,
        result["row_count"],
        result["column_count"],
        sheet_names=sheet_names,
        category_id=category_id,
        repository_name=repository_name,
        description=description,
        visibility=visibility,
        business_owner=business_owner or normalized_owner_email,
        data_classification=data_classification,
        retention_policy=retention_policy,
        sheet_tables=sheet_tables,
    )
    if owner_user_id != principal.user_id:
        add_dataset_member(
            table_id, owner_user_id, principal.email, "editor"
        )
    store_initial_formula_metadata(table_id, formulas_by_sheet)
    record_audit_event(
        "WORKBOOK_UPLOADED", actor_user_id=principal.user_id,
        payload={**upload_profile, "filename": original_name, "table_id": table_id},
    )

    try:
        working_copy = issue_branch_workbook(
            table_id, principal.user_id, principal.email, source_workbook=input_path
        )
        output_path = working_copy["path"]
    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail=f"Branch workbook provisioning failed: {exc}",
        ) from exc

    record_audit_event(
        "REPOSITORY_CREATED", actor_user_id=principal.user_id,
        repository_id=working_copy["repository_id"], branch_id=working_copy["branch_id"],
        payload={"table_id": table_id, "filename": original_name},
    )
    record_audit_event(
        "WORKBOOK_VALIDATED", actor_user_id="USR_SYSTEM", actor_type="SYSTEM",
        repository_id=working_copy["repository_id"], branch_id=working_copy["branch_id"],
        payload={"rows": result["row_count"], "columns": result["column_count"],
                 "sheets": len(sheet_names)},
    )
    record_metric("workbook_size", upload_profile["upload_bytes"], "bytes", user_id=principal.user_id, repository_id=working_copy["repository_id"])
    record_metric("workbook_rows", result["row_count"], "count", user_id=principal.user_id, repository_id=working_copy["repository_id"])
    record_metric("workbook_columns", result["column_count"], "count", user_id=principal.user_id, repository_id=working_copy["repository_id"])
    record_metric("workbook_sheets", len(sheet_names), "count", user_id=principal.user_id, repository_id=working_copy["repository_id"])

    # ── Return modified file with metadata headers ───────────────────────
    download_name = f"configured_{table_id}_{safe_name}"
    response = FileResponse(
        path=output_path,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        filename=download_name,
        background=BackgroundTask(_cleanup_download, input_path, output_path),
    )
    response.headers["X-Table-ID"] = table_id
    response.headers["X-Row-Count"] = str(result["row_count"])
    response.headers["X-Column-Count"] = str(result["column_count"])
    response.headers["X-Owner-User-ID"] = principal.user_id
    response.headers["X-Branch-Table-ID"] = working_copy["table_id"]
    response.headers["X-Repository-ID"] = working_copy["repository_id"]
    response.headers["X-Branch-ID"] = working_copy["branch_id"]
    response.headers["X-Working-Copy-ID"] = working_copy["working_copy_id"]
    record_audit_event(
        "WORKING_COPY_CREATED", actor_user_id=principal.user_id,
        repository_id=working_copy["repository_id"], branch_id=working_copy["branch_id"],
        working_copy_id=working_copy["working_copy_id"],
        payload={"table_id": working_copy["table_id"]},
    )
    record_audit_event(
        "WORKBOOK_DOWNLOADED", actor_user_id=principal.user_id,
        repository_id=working_copy["repository_id"], branch_id=working_copy["branch_id"],
        working_copy_id=working_copy["working_copy_id"], payload={"filename": download_name},
    )
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
    _validate_workbook_identity(table_id, principal, payload)
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
    _validate_workbook_identity(table_id, principal, payload)
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
        if working_copy_required(table_id):
            return commit_service.commit(
                payload, CommitActor(principal.user_id, principal.email)
            )
        result = apply_workbook_commit(
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
        advance_branch_head(table_id, result["batch_id"])
        return result
    except BranchHeadChangedError as exc:
        raise HTTPException(
            status_code=409,
            detail={
                "code": "BRANCH_HEAD_CHANGED",
                "message": "The branch advanced after this workbook was checked out.",
                "expected_head_commit_id": exc.expected_head,
                "current_head_commit_id": exc.current_head,
            },
        ) from exc
    except PermissionError as exc:
        message = str(exc)
        if "no longer active" in message:
            raise HTTPException(
                status_code=409,
                detail={
                    "code": "WORKING_COPY_CLOSED",
                    "message": "This workspace has already been merged. Download latest main or create a new workspace.",
                },
            ) from exc
        raise HTTPException(status_code=403, detail=message) from exc
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


@app.delete("/api/v1/datasets/{table_id}/members")
async def revoke_member(
    table_id: str,
    email: str,
    principal: Principal = Depends(current_principal),
):
    normalized = _ensure_access(table_id, principal)
    try:
        return remove_dataset_member(normalized, principal.user_id, _valid_email(email))
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@app.get("/api/v1/datasets/{table_id}/workspace")
async def workspace_state(
    table_id: str,
    since_revision: int = Query(default=0, ge=0),
    wait_seconds: int = Query(default=0, ge=0, le=25),
    principal: Principal = Depends(current_principal),
):
    normalized = _ensure_access(table_id, principal)
    deadline = asyncio.get_running_loop().time() + wait_seconds
    while True:
        snapshot = get_workspace_snapshot(normalized)
        if snapshot["revision"] > since_revision or wait_seconds == 0:
            return snapshot
        remaining = deadline - asyncio.get_running_loop().time()
        if remaining <= 0:
            return snapshot
        await asyncio.sleep(min(0.75, remaining))


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
    repository_id = repository_id_for_table(table_id) if table_id else None
    if repository_id:
        context["repository_insights"] = repository_insights(repository_id)
        context["audit_events"] = list_audit_events(repository_id=repository_id, limit=30)
    if payload.branch_id:
        branch = branch_context(payload.branch_id)
        if not branch or not repository_id or branch["repository_id"] != repository_id:
            raise HTTPException(status_code=403, detail="Branch is not accessible in this repository.")
        context["branch"] = {
            key: branch.get(key) for key in
            ("branch_id", "branch_name", "branch_type", "base_commit_id", "head_commit_id", "status")
        }
    if payload.merge_request_id:
        try:
            context["merge_request"] = merge_service.get_request(
                payload.merge_request_id, MergeActor(principal.user_id, principal.email)
            )
        except (PermissionError, ValueError) as exc:
            raise HTTPException(status_code=403, detail=str(exc)) from exc
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
                        "surface anomalies and risks, and recommend concise actions. "
                        "You are advisory only: never claim to approve, merge, or revert. "
                        "Prioritize formulas converted to static values, validation failures, "
                        "structural changes, duplicates, and unusually large value changes."
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
            "HTTP-Referer": settings.app_url,
            "X-Title": "Git Walk",
        },
        method="POST",
    )
    record_audit_event(
        "AI_ANALYSIS_REQUESTED", actor_user_id=principal.user_id, actor_type="USER",
        repository_id=repository_id, branch_id=payload.branch_id,
        merge_request_id=payload.merge_request_id,
        payload={"model": model, "question_length": len(payload.question)},
    )
    try:
        with urllib.request.urlopen(request, timeout=45) as response:
            result = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise HTTPException(status_code=502, detail=f"OpenRouter request failed: {detail}")
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"OpenRouter request failed: {exc}")

    record_audit_event(
        "AI_RECOMMENDATION_GENERATED", actor_user_id=principal.user_id, actor_type="AI",
        repository_id=repository_id, branch_id=payload.branch_id,
        merge_request_id=payload.merge_request_id,
        payload={"model": model},
    )

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
