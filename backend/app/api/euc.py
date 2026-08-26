"""Authenticated Stage 2.1 EUC ingestion and inventory endpoints."""

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel, Field

from ..config import settings
from ..euc.service import (
    analyze_euc,
    export_manifest,
    get_analysis,
    get_inventory,
    ingest_euc,
    list_assets,
)
from ..euc.validation import EUCValidationError
from ..euc.dependency.services import DependencyService
from ..euc.intelligence import IntelligenceService
from ..euc.migration import MigrationService
from ..euc.application_model import ApplicationModelService
from ..security import Principal, current_principal


router = APIRouter(prefix="/api/v1/euc", tags=["euc-inventory"])
dependency_service = DependencyService()
intelligence_service = IntelligenceService()
migration_service = MigrationService()
application_model_service = ApplicationModelService()


class DependencyImpactRequest(BaseModel):
    node_id: str | None = None
    sheet_id: str | None = None
    cell_address: str | None = None
    max_depth: int = Field(default=12, ge=1, le=50)


class IntelligenceAnalysisRequest(BaseModel):
    profile: str = Field(default="DEFAULT", min_length=2, max_length=80)


class FindingStatusRequest(BaseModel):
    status: str = Field(min_length=2, max_length=40)
    reason: str = Field(min_length=3, max_length=2000)
    expires_at: str | None = Field(default=None, max_length=80)


class MigrationOverrideRequest(BaseModel):
    manual_mode: str = Field(min_length=3, max_length=40)
    reason: str = Field(min_length=3, max_length=2000)


class ApplicationModelRequest(BaseModel):
    target_profile: str = Field(default="WEB_POSTGRES_FASTAPI_REACT", min_length=3, max_length=80)


class ApplicationReviewRequest(BaseModel):
    decision: str = Field(min_length=3, max_length=20)
    reason: str = Field(min_length=3, max_length=2000)


class ApplicationGenerationRequest(BaseModel):
    mode: str = Field(default="MODEL_ONLY", min_length=3, max_length=30)
    target_profile: str = Field(default="WEB_POSTGRES_FASTAPI_REACT", min_length=3, max_length=80)


def _error(exc: Exception) -> HTTPException:
    if isinstance(exc, PermissionError):
        return HTTPException(status_code=403, detail={"code": "ACCESS_DENIED", "message": str(exc)})
    if isinstance(exc, KeyError):
        return HTTPException(status_code=404, detail={"code": "NOT_FOUND", "message": str(exc).strip("'")})
    if isinstance(exc, EUCValidationError):
        return HTTPException(status_code=422, detail={"code": exc.code, "message": str(exc)})
    if isinstance(exc, (ValueError, TimeoutError)):
        return HTTPException(status_code=400, detail={"code": "INVALID_DEPENDENCY_REQUEST", "message": str(exc)})
    return HTTPException(status_code=500, detail={"code": "ANALYSIS_FAILURE", "message": str(exc)})


@router.post("", status_code=201)
async def upload_euc(
    repository_id: str = Form(...),
    file: UploadFile = File(...),
    principal: Principal = Depends(current_principal),
):
    try:
        payload = await file.read(settings.euc_max_file_bytes + 1)
        return ingest_euc(repository_id.strip(), file.filename or "upload", payload, principal.user_id)
    except Exception as exc:
        raise _error(exc) from exc
    finally:
        await file.close()


@router.get("")
async def portfolio(
    repository_id: str | None = Query(default=None),
    search: str = Query(default="", max_length=200),
    principal: Principal = Depends(current_principal),
):
    return {"assets": list_assets(principal.user_id, repository_id, search.strip())}


@router.post("/{euc_id}/analysis")
async def start_analysis(euc_id: str, principal: Principal = Depends(current_principal)):
    try:
        return analyze_euc(euc_id, principal.user_id)
    except Exception as exc:
        raise _error(exc) from exc


@router.get("/{euc_id}/analysis/{analysis_id}")
async def analysis_status(euc_id: str, analysis_id: str, principal: Principal = Depends(current_principal)):
    try:
        return get_analysis(euc_id, analysis_id, principal.user_id)
    except Exception as exc:
        raise _error(exc) from exc


@router.get("/{euc_id}/inventory")
async def inventory(
    euc_id: str,
    include: str = Query(default="overview"),
    limit: int = Query(default=100, ge=1, le=500),
    cursor: int = Query(default=0, ge=0),
    principal: Principal = Depends(current_principal),
):
    allowed = {"overview", "sheets", "formulas", "objects", "dependencies"}
    requested = {item.strip() for item in include.split(",") if item.strip()}
    if requested - allowed:
        raise HTTPException(status_code=400, detail={"code": "INVALID_SECTION", "message": "Unknown inventory section."})
    try:
        return get_inventory(euc_id, principal.user_id, include, limit, cursor)
    except Exception as exc:
        raise _error(exc) from exc


@router.get("/{euc_id}/export")
async def export_inventory(euc_id: str, principal: Principal = Depends(current_principal)):
    try:
        filename, payload = export_manifest(euc_id, principal.user_id)
        return Response(payload, media_type="application/json", headers={
            "Content-Disposition": f'attachment; filename="{filename}"'
        })
    except Exception as exc:
        raise _error(exc) from exc


@router.post("/{euc_id}/dependency/analysis")
async def build_dependency_graph(euc_id: str, principal: Principal = Depends(current_principal)):
    try:
        return dependency_service.build(euc_id, principal.user_id)
    except Exception as exc:
        raise _error(exc) from exc


@router.get("/{euc_id}/dependency/overview")
async def dependency_overview(euc_id: str, principal: Principal = Depends(current_principal)):
    try:
        return dependency_service.overview(euc_id, principal.user_id)
    except Exception as exc:
        raise _error(exc) from exc


@router.get("/{euc_id}/dependency/sheets")
async def dependency_sheets(euc_id: str, principal: Principal = Depends(current_principal)):
    try:
        return dependency_service.sheets(euc_id, principal.user_id)
    except Exception as exc:
        raise _error(exc) from exc


@router.get("/{euc_id}/dependency/hotspots")
async def dependency_hotspots(
    euc_id: str,
    limit: int = Query(default=50, ge=1, le=200),
    principal: Principal = Depends(current_principal),
):
    try:
        return {"hotspots": dependency_service.hotspots(euc_id, principal.user_id, limit)}
    except Exception as exc:
        raise _error(exc) from exc


@router.get("/{euc_id}/dependency/cycles")
async def dependency_cycles(euc_id: str, principal: Principal = Depends(current_principal)):
    try:
        return {"cycles": dependency_service.cycles(euc_id, principal.user_id)}
    except Exception as exc:
        raise _error(exc) from exc


@router.get("/{euc_id}/dependency/broken")
async def broken_dependencies(
    euc_id: str,
    limit: int = Query(default=200, ge=1, le=500),
    principal: Principal = Depends(current_principal),
):
    try:
        return {"references": dependency_service.broken(euc_id, principal.user_id, limit)}
    except Exception as exc:
        raise _error(exc) from exc


@router.get("/{euc_id}/dependency/search")
async def dependency_search(
    euc_id: str,
    query: str = Query(min_length=1, max_length=200),
    limit: int = Query(default=50, ge=1, le=100),
    principal: Principal = Depends(current_principal),
):
    try:
        return {"nodes": dependency_service.search(euc_id, principal.user_id, query.strip(), limit)}
    except Exception as exc:
        raise _error(exc) from exc


def _lineage_node(euc_id: str, principal: Principal, node_id: str | None,
                  sheet_id: str | None, cell_address: str | None) -> str:
    if node_id:
        return node_id
    if not sheet_id or not cell_address:
        raise ValueError("Provide node_id, or both sheet_id and cell_address")
    return dependency_service.resolve_cell_node(
        euc_id, principal.user_id, sheet_id, cell_address
    )["node_id"]


@router.get("/{euc_id}/dependency/upstream")
async def dependency_upstream(
    euc_id: str,
    node_id: str | None = None,
    sheet_id: str | None = None,
    cell_address: str | None = None,
    depth: int = Query(default=6, ge=1, le=50),
    principal: Principal = Depends(current_principal),
):
    try:
        resolved = _lineage_node(euc_id, principal, node_id, sheet_id, cell_address)
        return dependency_service.lineage(euc_id, principal.user_id, resolved, "upstream", depth)
    except Exception as exc:
        raise _error(exc) from exc


@router.get("/{euc_id}/dependency/downstream")
async def dependency_downstream(
    euc_id: str,
    node_id: str | None = None,
    sheet_id: str | None = None,
    cell_address: str | None = None,
    depth: int = Query(default=6, ge=1, le=50),
    principal: Principal = Depends(current_principal),
):
    try:
        resolved = _lineage_node(euc_id, principal, node_id, sheet_id, cell_address)
        return dependency_service.lineage(euc_id, principal.user_id, resolved, "downstream", depth)
    except Exception as exc:
        raise _error(exc) from exc


@router.post("/{euc_id}/impact")
async def dependency_impact(
    euc_id: str,
    request: DependencyImpactRequest,
    principal: Principal = Depends(current_principal),
):
    try:
        resolved = _lineage_node(
            euc_id, principal, request.node_id, request.sheet_id, request.cell_address
        )
        return dependency_service.impact(euc_id, principal.user_id, resolved, request.max_depth)
    except Exception as exc:
        raise _error(exc) from exc


@router.post("/{euc_id}/intelligence/analysis")
async def build_intelligence(
    euc_id: str,
    request: IntelligenceAnalysisRequest,
    principal: Principal = Depends(current_principal),
):
    try:
        return intelligence_service.build(euc_id, principal.user_id, request.profile)
    except Exception as exc:
        raise _error(exc) from exc


@router.get("/{euc_id}/intelligence")
async def intelligence_overview(euc_id: str, principal: Principal = Depends(current_principal)):
    try:
        return intelligence_service.overview(euc_id, principal.user_id)
    except Exception as exc:
        raise _error(exc) from exc


@router.get("/{euc_id}/complexity")
async def complexity_detail(euc_id: str, principal: Principal = Depends(current_principal)):
    try:
        return intelligence_service.complexity(euc_id, principal.user_id)
    except Exception as exc:
        raise _error(exc) from exc


@router.get("/{euc_id}/risk/explain")
async def risk_explanation(euc_id: str, principal: Principal = Depends(current_principal)):
    try:
        return intelligence_service.explain_risk(euc_id, principal.user_id)
    except Exception as exc:
        raise _error(exc) from exc


@router.get("/{euc_id}/controls")
async def control_inventory(euc_id: str, principal: Principal = Depends(current_principal)):
    try:
        return intelligence_service.controls(euc_id, principal.user_id)
    except Exception as exc:
        raise _error(exc) from exc


@router.get("/{euc_id}/findings")
async def intelligence_findings(
    euc_id: str,
    severity: str | None = None,
    category: str | None = None,
    sheet_id: str | None = None,
    status: str | None = None,
    rule_id: str | None = None,
    limit: int = Query(default=200, ge=1, le=500),
    principal: Principal = Depends(current_principal),
):
    try:
        return intelligence_service.findings(
            euc_id, principal.user_id, severity=severity, category=category,
            sheet_id=sheet_id, status=status, rule_id=rule_id, limit=limit,
        )
    except Exception as exc:
        raise _error(exc) from exc


@router.get("/{euc_id}/findings/{finding_id}")
async def finding_detail(euc_id: str, finding_id: str, principal: Principal = Depends(current_principal)):
    try:
        return intelligence_service.finding_detail(euc_id, principal.user_id, finding_id)
    except Exception as exc:
        raise _error(exc) from exc


@router.patch("/{euc_id}/findings/{finding_id}/status")
async def update_finding_status(
    euc_id: str,
    finding_id: str,
    request: FindingStatusRequest,
    principal: Principal = Depends(current_principal),
):
    try:
        return intelligence_service.update_finding(
            euc_id, principal.user_id, finding_id, request.status,
            request.reason, request.expires_at,
        )
    except Exception as exc:
        raise _error(exc) from exc


@router.post("/{euc_id}/migration/analyze")
async def analyze_migration(euc_id: str, principal: Principal = Depends(current_principal)):
    try:
        return migration_service.analyze(euc_id, principal.user_id)
    except Exception as exc:
        raise _error(exc) from exc


@router.get("/{euc_id}/migration")
async def migration_overview(euc_id: str, principal: Principal = Depends(current_principal)):
    try:
        return migration_service.overview(euc_id, principal.user_id)
    except Exception as exc:
        raise _error(exc) from exc


@router.get("/{euc_id}/migration/readiness")
async def migration_readiness(euc_id: str, principal: Principal = Depends(current_principal)):
    try:
        return migration_service.readiness(euc_id, principal.user_id)
    except Exception as exc:
        raise _error(exc) from exc


@router.get("/{euc_id}/migration/blockers")
async def migration_blockers(euc_id: str, principal: Principal = Depends(current_principal)):
    try:
        return migration_service.blockers(euc_id, principal.user_id)
    except Exception as exc:
        raise _error(exc) from exc


@router.get("/{euc_id}/migration/components")
async def migration_components(
    euc_id: str,
    mode: str | None = None,
    source_type: str | None = None,
    wave: int | None = Query(default=None, ge=0, le=20),
    principal: Principal = Depends(current_principal),
):
    try:
        return migration_service.components(euc_id, principal.user_id, mode, source_type, wave)
    except Exception as exc:
        raise _error(exc) from exc


@router.get("/{euc_id}/migration/waves")
async def migration_waves(euc_id: str, principal: Principal = Depends(current_principal)):
    try:
        return migration_service.waves(euc_id, principal.user_id)
    except Exception as exc:
        raise _error(exc) from exc


@router.get("/{euc_id}/migration/target")
async def migration_target(euc_id: str, principal: Principal = Depends(current_principal)):
    try:
        return migration_service.target(euc_id, principal.user_id)
    except Exception as exc:
        raise _error(exc) from exc


@router.get("/{euc_id}/migration/controls")
async def migration_controls(euc_id: str, principal: Principal = Depends(current_principal)):
    try:
        return migration_service.controls(euc_id, principal.user_id)
    except Exception as exc:
        raise _error(exc) from exc


@router.get("/{euc_id}/migration/validation")
async def migration_validation(euc_id: str, principal: Principal = Depends(current_principal)):
    try:
        return migration_service.validation(euc_id, principal.user_id)
    except Exception as exc:
        raise _error(exc) from exc


@router.post("/{euc_id}/migration/components/{unit_id}/override")
async def override_migration_component(
    euc_id: str,
    unit_id: str,
    request: MigrationOverrideRequest,
    principal: Principal = Depends(current_principal),
):
    try:
        return migration_service.override(
            euc_id, unit_id, principal.user_id, request.manual_mode, request.reason
        )
    except Exception as exc:
        raise _error(exc) from exc


@router.post("/{euc_id}/application-model")
async def build_application_model(
    euc_id: str,
    request: ApplicationModelRequest,
    principal: Principal = Depends(current_principal),
):
    try:
        return application_model_service.build(euc_id, principal.user_id, request.target_profile)
    except Exception as exc:
        raise _error(exc) from exc


@router.get("/{euc_id}/application-model")
async def application_model_overview(euc_id: str, principal: Principal = Depends(current_principal)):
    try:
        return application_model_service.overview(euc_id, principal.user_id)
    except Exception as exc:
        raise _error(exc) from exc


@router.get("/{euc_id}/application-model/manifest")
async def application_model_manifest(euc_id: str, principal: Principal = Depends(current_principal)):
    try:
        return application_model_service.manifest(euc_id, principal.user_id)
    except Exception as exc:
        raise _error(exc) from exc


@router.get("/{euc_id}/application-model/components")
async def application_model_components(
    euc_id: str,
    component_type: str | None = None,
    principal: Principal = Depends(current_principal),
):
    try:
        return application_model_service.components(euc_id, principal.user_id, component_type)
    except Exception as exc:
        raise _error(exc) from exc


@router.get("/{euc_id}/application-model/lineage")
async def application_model_lineage(
    euc_id: str,
    query: str = Query(default="", max_length=200),
    principal: Principal = Depends(current_principal),
):
    try:
        return application_model_service.lineage(euc_id, principal.user_id, query.strip())
    except Exception as exc:
        raise _error(exc) from exc


@router.post("/{euc_id}/application-model/components/{component_id}/review")
async def review_application_component(
    euc_id: str,
    component_id: str,
    request: ApplicationReviewRequest,
    principal: Principal = Depends(current_principal),
):
    try:
        return application_model_service.review(
            euc_id, component_id, principal.user_id, request.decision, request.reason
        )
    except Exception as exc:
        raise _error(exc) from exc


@router.post("/{euc_id}/application-model/approve")
async def approve_application_model(euc_id: str, principal: Principal = Depends(current_principal)):
    try:
        return application_model_service.approve(euc_id, principal.user_id)
    except Exception as exc:
        raise _error(exc) from exc


@router.post("/{euc_id}/application-model/generate")
async def generate_application(
    euc_id: str,
    request: ApplicationGenerationRequest,
    principal: Principal = Depends(current_principal),
):
    try:
        return application_model_service.generate(
            euc_id, principal.user_id, request.mode, request.target_profile
        )
    except Exception as exc:
        raise _error(exc) from exc


@router.get("/{euc_id}/application-model/generation")
async def application_generation(euc_id: str, principal: Principal = Depends(current_principal)):
    try:
        return application_model_service.generation(euc_id, principal.user_id)
    except Exception as exc:
        raise _error(exc) from exc


@router.get("/{euc_id}/application-model/generation/{generation_run_id}/download")
async def download_application_generation(
    euc_id: str,
    generation_run_id: str,
    principal: Principal = Depends(current_principal),
):
    try:
        filename, payload = application_model_service.download(euc_id, generation_run_id, principal.user_id)
        return Response(payload, media_type="application/zip", headers={
            "Content-Disposition": f'attachment; filename="{filename}"'
        })
    except Exception as exc:
        raise _error(exc) from exc


@router.get("/{euc_id}/lineage/{node_id:path}")
async def dependency_lineage(
    euc_id: str,
    node_id: str,
    direction: str = Query(default="both", pattern="^(upstream|downstream|both)$"),
    depth: int = Query(default=6, ge=1, le=50),
    principal: Principal = Depends(current_principal),
):
    try:
        return dependency_service.lineage(euc_id, principal.user_id, node_id, direction, depth)
    except Exception as exc:
        raise _error(exc) from exc
