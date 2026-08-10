from app.main import app


def test_product_api_contract_is_registered():
    paths = app.openapi()["paths"]
    expected = {
        "/api/v1/auth/request-code": {"post"},
        "/api/v1/auth/verify-code": {"post"},
        "/api/v1/auth/logout": {"post"},
        "/api/v1/upload-and-provision": {"post"},
        "/api/v1/realtime-sync": {"get", "post"},
        "/api/v1/bulk-sync": {"post"},
        "/api/v1/workbook-commit": {"post"},
        "/api/v1/datasets/{table_id}/data": {"get"},
        "/api/v1/datasets/{table_id}/snapshot": {"get"},
        "/api/v1/datasets/{table_id}/history": {"get"},
        "/api/v1/datasets/{table_id}/members": {"get", "post", "delete"},
        "/api/v1/datasets/{table_id}/workspace": {"get"},
        "/api/v1/datasets/{table_id}/presence": {"get", "post", "delete"},
        "/api/v1/datasets/rollback": {"post"},
        "/api/v1/analytics/kpis": {"get"},
        "/api/v1/datasets/{table_id}/export": {"get"},
        "/api/v1/ai/insights": {"post"},
        "/api/v1/ai/config": {"post", "delete"},
        "/api/v1/categories": {"get", "post"},
        "/api/v1/repositories/{table_id}": {"get"},
        "/api/v1/repositories/{table_id}/category": {"patch"},
        "/api/v1/repositories/{table_id}/branches": {"get"},
        "/api/v1/repositories/{table_id}/work-on-workbook": {"post"},
        "/api/v1/working-copies/mine": {"get"},
        "/api/v1/branches/{branch_id}/state": {"get"},
        "/api/v1/branches/{branch_id}/commits": {"get"},
        "/api/v1/branches/{branch_id}/metrics": {"get"},
        "/api/v1/commits/{commit_id}": {"get"},
        "/api/v1/branches/{branch_id}/cells/{sheet_id}/{row_id}/{column_id}/history": {"get"},
        "/api/v1/branches/{branch_id}/divergence": {"get"},
        "/api/v1/branches/{branch_id}/sync": {"post"},
        "/api/v1/repositories/{table_id}/merge-requests": {"get"},
        "/api/v1/merge-requests": {"post"},
        "/api/v1/merge-requests/{merge_request_id}": {"get"},
        "/api/v1/merge-requests/{merge_request_id}/conflicts/{conflict_id}/resolve": {"post"},
        "/api/v1/merge-requests/{merge_request_id}/review": {"post"},
        "/api/v1/merge-requests/{merge_request_id}/merge": {"post"},
        "/api/v1/commits/{commit_id}/revert": {"post"},
        "/api/v1/audit/events": {"get"},
        "/api/v1/observability/metrics": {"get"},
        "/api/v1/security/posture": {"get"},
        "/api/v1/repositories/{table_id}/insights": {"get"},
        "/api/v1/branches/{branch_id}/blame": {"get"},
        "/api/v1/branches/{branch_id}/rows/{sheet_id}/{row_id}/history": {"get"},
        "/api/v1/branches/{branch_id}/cells/{sheet_id}/{row_id}/{column_id}/traceability": {"get"},
    }

    for path, methods in expected.items():
        assert path in paths
        assert methods.issubset(paths[path])
