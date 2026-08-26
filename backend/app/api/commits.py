"""Stage 2 commit graph, reconstructed state, metrics, and lineage APIs."""

from fastapi import APIRouter, Depends, HTTPException, Query

from ..database import user_can_access_branch
from ..repositories.commit_store import (
    branch_metrics,
    get_cell_history,
    get_commit,
    list_branch_commits,
    reconstruct_branch,
)
from ..security import Principal, current_principal


router = APIRouter(prefix="/api/v1", tags=["semantic-versioning"])


def _branch_access(branch_id: str, principal: Principal) -> None:
    if not user_can_access_branch(branch_id, principal.user_id):
        raise HTTPException(status_code=404, detail="Branch does not exist or is not accessible")


@router.get("/branches/{branch_id}/state")
async def branch_state(
    branch_id: str,
    commit_id: str | None = None,
    principal: Principal = Depends(current_principal),
):
    _branch_access(branch_id, principal)
    try:
        return reconstruct_branch(branch_id, commit_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.get("/branches/{branch_id}/commits")
async def branch_commits(
    branch_id: str,
    limit: int = Query(default=100, ge=1, le=500),
    principal: Principal = Depends(current_principal),
):
    _branch_access(branch_id, principal)
    return {"commits": list_branch_commits(branch_id, limit)}


@router.get("/branches/{branch_id}/metrics")
async def metrics(
    branch_id: str,
    principal: Principal = Depends(current_principal),
):
    _branch_access(branch_id, principal)
    return branch_metrics(branch_id)


@router.get("/commits/{commit_id}")
async def commit_detail(
    commit_id: str,
    principal: Principal = Depends(current_principal),
):
    commit = get_commit(commit_id)
    if not commit:
        raise HTTPException(status_code=404, detail="Commit does not exist")
    _branch_access(commit["branch_id"], principal)
    return commit


@router.get("/branches/{branch_id}/cells/{sheet_id}/{row_id}/{column_id}/history")
async def cell_history(
    branch_id: str,
    sheet_id: str,
    row_id: str,
    column_id: str,
    limit: int = Query(default=100, ge=1, le=500),
    principal: Principal = Depends(current_principal),
):
    _branch_access(branch_id, principal)
    return {
        "history": get_cell_history(
            branch_id, sheet_id, row_id, column_id, limit
        )
    }
