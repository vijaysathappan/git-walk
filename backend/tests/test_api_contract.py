from app.main import app


def test_product_api_contract_is_registered():
    paths = app.openapi()["paths"]
    expected = {
        "/api/v1/auth/request-code": {"post"},
        "/api/v1/auth/verify-code": {"post"},
        "/api/v1/upload-and-provision": {"post"},
        "/api/v1/realtime-sync": {"get", "post"},
        "/api/v1/bulk-sync": {"post"},
        "/api/v1/workbook-commit": {"post"},
        "/api/v1/datasets/{table_id}/data": {"get"},
        "/api/v1/datasets/{table_id}/snapshot": {"get"},
        "/api/v1/datasets/{table_id}/history": {"get"},
        "/api/v1/datasets/{table_id}/members": {"get", "post"},
        "/api/v1/datasets/{table_id}/presence": {"get", "post", "delete"},
        "/api/v1/datasets/rollback": {"post"},
        "/api/v1/analytics/kpis": {"get"},
        "/api/v1/datasets/{table_id}/export": {"get"},
        "/api/v1/ai/insights": {"post"},
        "/api/v1/ai/config": {"post", "delete"},
    }

    for path, methods in expected.items():
        assert path in paths
        assert methods.issubset(paths[path])
