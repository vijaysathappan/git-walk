"""Stage 1 category, repository, branch, and working-copy routes."""

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import FileResponse
from starlette.background import BackgroundTask
import shutil
from pathlib import Path

from ..database import (
    create_category,
    delete_branch,
    delete_repository,
    get_branch_sheet_page,
    get_repository,
    list_categories,
    list_repository_branches,
    list_user_working_copies,
    move_repository,
    repository_name_available,
    working_copy_checkout_options,
    user_can_access_branch,
    user_can_work_on_repository,
)
from ..schemas import CategoryCreateRequest, RepositoryCategoryRequest, WorkingCopyRequest
from ..security import Principal, current_principal
from ..repositories.merge_store import branch_context
from ..services.workbook_service import export_branch_workbook, issue_branch_workbook
from ..observability import record_audit_event


router = APIRouter(prefix="/api/v1", tags=["repositories"])


@router.get("/categories")
async def categories(_principal: Principal = Depends(current_principal)):
    return {"categories": list_categories()}


@router.get("/repositories/name-availability")
async def repository_availability(
    name: str = Query(min_length=1, max_length=120),
    _principal: Principal = Depends(current_principal),
):
    return repository_name_available(name)


@router.post("/categories")
async def add_category(
    payload: CategoryCreateRequest,
    principal: Principal = Depends(current_principal),
):
    try:
        result = create_category(payload.name, payload.description, payload.parent_category_id)
        record_audit_event(
            "CATEGORY_CREATED", actor_user_id=principal.user_id,
            payload={"category_id": result["category_id"], "name": result["name"]},
        )
        return result
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.get("/repositories/{table_id}")
async def repository_detail(
    table_id: str,
    principal: Principal = Depends(current_principal),
):
    repository = get_repository(table_id.strip().upper(), principal.user_id)
    if not repository:
        raise HTTPException(status_code=404, detail="Repository does not exist or is not accessible")
    return repository


@router.patch("/repositories/{table_id}/category")
async def repository_category(
    table_id: str,
    payload: RepositoryCategoryRequest,
    principal: Principal = Depends(current_principal),
):
    try:
        result = move_repository(
            table_id.strip().upper(), payload.category_id, principal.user_id
        )
        record_audit_event(
            "REPOSITORY_UPDATED", actor_user_id=principal.user_id,
            repository_id=result["repository_id"],
            payload={"category_id": payload.category_id},
        )
        return result
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.get("/repositories/{table_id}/branches")
async def repository_branches(
    table_id: str,
    principal: Principal = Depends(current_principal),
):
    repository = get_repository(table_id.strip().upper(), principal.user_id)
    if not repository:
        raise HTTPException(status_code=404, detail="Repository does not exist or is not accessible")
    return {"branches": list_repository_branches(table_id.strip().upper(), principal.user_id)}


@router.get("/repositories/{table_id}/branches/{branch_id}/sheets/{sheet_id}/records")
async def repository_sheet_records(
    table_id: str,
    branch_id: str,
    sheet_id: str,
    limit: int = Query(default=100, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
    principal: Principal = Depends(current_principal),
):
    try:
        return get_branch_sheet_page(
            table_id.strip().upper(), branch_id, sheet_id,
            principal.user_id, limit, offset,
        )
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.get("/repositories/{table_id}/branches/{branch_id}/download")
async def download_repository_branch(
    table_id: str,
    branch_id: str,
    principal: Principal = Depends(current_principal),
):
    normalized = table_id.strip().upper()
    repository = get_repository(normalized, principal.user_id)
    branch = branch_context(branch_id)
    if (
        not repository or not branch
        or branch["repository_id"] != repository["repository_id"]
        or not user_can_access_branch(branch_id, principal.user_id)
    ):
        raise HTTPException(status_code=404, detail="Branch does not exist or is not accessible")
    result = export_branch_workbook(
        branch["data_table_id"], branch_id, branch["branch_name"]
    )
    record_audit_event(
        "WORKBOOK_DOWNLOADED", actor_user_id=principal.user_id,
        repository_id=branch["repository_id"], branch_id=branch_id,
        payload={"purpose": "complete_branch_export"},
    )
    return FileResponse(
        result["path"],
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        filename=f"{branch['branch_name'].replace('/', '_')}.xlsx",
        background=BackgroundTask(shutil.rmtree, Path(result["path"]).parent, True),
    )


@router.delete("/repositories/{table_id}")
async def remove_repository(
    table_id: str,
    principal: Principal = Depends(current_principal),
):
    try:
        result = delete_repository(table_id.strip().upper(), principal.user_id)
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc
    record_audit_event(
        "REPOSITORY_DELETED", actor_user_id=principal.user_id,
        repository_id=result["repository_id"], payload={"table_id": result["table_id"]},
    )
    return result


@router.delete("/branches/{branch_id}")
async def remove_branch(
    branch_id: str,
    principal: Principal = Depends(current_principal),
):
    context = branch_context(branch_id)
    try:
        result = delete_branch(branch_id, principal.user_id)
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc
    record_audit_event(
        "BRANCH_DELETED", actor_user_id=principal.user_id,
        repository_id=context["repository_id"] if context else None,
        branch_id=branch_id, payload={"working_copy_status": "REVOKED"},
    )
    return result


@router.post("/repositories/{table_id}/work-on-workbook")
async def work_on_workbook(
    table_id: str,
    payload: WorkingCopyRequest,
    principal: Principal = Depends(current_principal),
):
    normalized = table_id.strip().upper()
    if not user_can_work_on_repository(normalized, principal.user_id):
        raise HTTPException(status_code=403, detail="Editor access is required to create a branch")
    try:
        result = issue_branch_workbook(
            normalized, principal.user_id, principal.email,
            branch_mode=payload.mode, branch_id=payload.branch_id,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    response = FileResponse(
        result["path"],
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        filename=f"gitwalk_{result['branch_name'].replace('/', '_')}.xlsx",
        background=BackgroundTask(shutil.rmtree, Path(result["path"]).parent, True),
    )
    response.headers["X-Table-ID"] = normalized
    response.headers["X-Branch-Table-ID"] = result["table_id"]
    response.headers["X-Repository-ID"] = result["repository_id"]
    response.headers["X-Branch-ID"] = result["branch_id"]
    response.headers["X-Working-Copy-ID"] = result["working_copy_id"]
    record_audit_event(
        "WORKING_COPY_CREATED", actor_user_id=principal.user_id,
        repository_id=result["repository_id"], branch_id=result["branch_id"],
        working_copy_id=result["working_copy_id"],
        payload={"branch_name": result["branch_name"]},
    )
    record_audit_event(
        "WORKBOOK_DOWNLOADED", actor_user_id=principal.user_id,
        repository_id=result["repository_id"], branch_id=result["branch_id"],
        working_copy_id=result["working_copy_id"],
        payload={"purpose": "working_copy"},
    )
    return response


@router.get("/repositories/{table_id}/checkout-options")
async def checkout_options(
    table_id: str,
    principal: Principal = Depends(current_principal),
):
    try:
        return working_copy_checkout_options(
            table_id.strip().upper(), principal.user_id
        )
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.get("/working-copies/mine")
async def my_working_copies(principal: Principal = Depends(current_principal)):
    return {"working_copies": list_user_working_copies(principal.user_id)}
