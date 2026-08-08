"""
Pydantic v2 schemas for request/response validation.
"""

from typing import Any

from pydantic import BaseModel, Field
from datetime import datetime


class SyncRequest(BaseModel):
    """Schema for real-time cell sync requests from the Excel taskpane."""

    table_id: str = Field(
        ...,
        description="The dynamically provisioned SQLite table name (e.g. QUEUE_BOARD_<UUID>)",
        examples=["QUEUE_BOARD_a1b2c3d4"],
    )
    row_id: int = Field(
        ...,
        description="The ROW_ID (auto-increment PK) of the row being edited",
        ge=1,
    )
    column_name: str = Field(
        ...,
        description="The sanitized column name to update",
        examples=["EMPLOYEE_NAME"],
    )
    new_value: str | None = Field(
        None,
        description="The new cell value as a string (None for cleared cells)",
    )
    source: str = "excel"
    commit_message: str | None = None


class SyncResponse(BaseModel):
    """Schema for sync operation responses."""

    status: str = Field(
        ...,
        description="Operation result: SUCCESS or ERROR",
        examples=["SUCCESS"],
    )
    timestamp: str = Field(
        default_factory=lambda: datetime.utcnow().isoformat() + "Z",
        description="ISO 8601 timestamp of the operation",
    )
    message: str | None = Field(
        None,
        description="Optional detail message",
    )
    persisted_value: str | int | float | bool | None = Field(
        None,
        description="Value read back from SQLite after the commit",
    )
    changed: bool = Field(
        ...,
        description="True when this request changed the stored value",
    )
    database_path: str = Field(
        ...,
        description="Canonical SQLite file updated by the backend",
    )


class CellValueResponse(BaseModel):
    """Read-only response used to verify a selected Excel cell."""

    table_id: str
    row_id: int
    column_name: str
    value: str | int | float | bool | None = None
    database_path: str


class UploadResponse(BaseModel):
    """Metadata returned alongside the file download (as headers)."""

    table_id: str
    row_count: int
    column_count: int


class LoginRequest(BaseModel):
    email: str = Field(..., min_length=5, max_length=254)


class LoginVerifyRequest(LoginRequest):
    code: str = Field(..., min_length=6, max_length=6)


class BulkCellChange(BaseModel):
    row_id: int = Field(..., ge=1)
    column_name: str
    new_value: Any = None


class BulkSyncRequest(BaseModel):
    table_id: str
    changes: list[BulkCellChange] = Field(..., min_length=1, max_length=5000)
    source: str = "excel"
    commit_message: str | None = Field(default=None, max_length=300)


class WorkbookCommitRequest(BaseModel):
    table_id: str
    base_version: int = Field(..., ge=0)
    updates: list[BulkCellChange] = Field(default_factory=list, max_length=5000)
    insert_rows: list[dict[str, Any]] = Field(default_factory=list, max_length=2000)
    delete_row_ids: list[int] = Field(default_factory=list, max_length=2000)
    new_columns: list[str] = Field(default_factory=list, max_length=100)
    delete_columns: list[str] = Field(default_factory=list, max_length=100)
    source: str = "excel_commit"
    commit_message: str = Field(..., min_length=1, max_length=300)


class RollbackRequest(BaseModel):
    table_id: str
    batch_id: str


class DatasetMemberRequest(BaseModel):
    email: str = Field(..., min_length=5, max_length=254)
    role: str = Field(default="viewer", pattern="^(viewer|editor)$")


class PresenceRequest(BaseModel):
    client_id: str = Field(..., min_length=8, max_length=100)
    surface: str = Field(..., pattern="^(browser|excel)$")
    activity: str = Field(default="viewing", pattern="^(viewing|editing|idle)$")


class AIInsightRequest(BaseModel):
    table_id: str | None = None
    model: str | None = None
    question: str = Field(..., min_length=3, max_length=1000)


class AIConfigRequest(BaseModel):
    api_key: str = Field(..., min_length=10, max_length=500)
    model: str = Field(..., min_length=3, max_length=200)
