"""
Pydantic v2 schemas for request/response validation.
"""

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
