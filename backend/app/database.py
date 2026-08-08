"""
SQLite Database Manager — Dynamic Table Provisioning & CRUD Operations.

Uses Python's built-in sqlite3 module for zero-setup database access.
The database file (queue_board.db) is auto-created alongside the backend package.
"""

import json
import sqlite3
import re
import os
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import pandas as pd

# ---------------------------------------------------------------------------
# Database file location: <backend>/queue_board.db
# ---------------------------------------------------------------------------
_DB_DIR = Path(__file__).resolve().parent.parent  # backend/
DB_PATH = _DB_DIR / "queue_board.db"


class VersionConflictError(RuntimeError):
    def __init__(self, current_version: int):
        self.current_version = current_version
        super().__init__(f"Server is at version {current_version}")


def _utcnow() -> str:
    return datetime.now(timezone.utc).isoformat()


def initialize_product_schema() -> None:
    """Create product metadata tables without touching provisioned datasets."""
    conn = _get_connection()
    try:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS APP_USERS (
                USER_ID TEXT PRIMARY KEY,
                EMAIL TEXT NOT NULL UNIQUE COLLATE NOCASE,
                DISPLAY_NAME TEXT,
                ROLE TEXT NOT NULL DEFAULT 'member',
                CREATED_AT TEXT NOT NULL,
                LAST_LOGIN_AT TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS AUTH_LOGIN_CODES (
                ID INTEGER PRIMARY KEY AUTOINCREMENT,
                EMAIL TEXT NOT NULL COLLATE NOCASE,
                CODE_HASH TEXT NOT NULL,
                EXPIRES_AT TEXT NOT NULL,
                USED_AT TEXT,
                CREATED_AT TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS DATASET_REGISTRY (
                TABLE_ID TEXT PRIMARY KEY,
                OWNER_USER_ID TEXT NOT NULL,
                ORIGINAL_FILENAME TEXT,
                ROW_COUNT INTEGER NOT NULL DEFAULT 0,
                COLUMN_COUNT INTEGER NOT NULL DEFAULT 0,
                CREATED_AT TEXT NOT NULL,
                UPDATED_AT TEXT NOT NULL,
                CURRENT_VERSION INTEGER NOT NULL DEFAULT 0,
                FOREIGN KEY (OWNER_USER_ID) REFERENCES APP_USERS(USER_ID)
            );

            CREATE TABLE IF NOT EXISTS AUDIT_COMMITS (
                AUDIT_ID TEXT PRIMARY KEY,
                BATCH_ID TEXT NOT NULL,
                VERSION INTEGER NOT NULL,
                TABLE_ID TEXT NOT NULL,
                ROW_ID INTEGER NOT NULL,
                COLUMN_NAME TEXT NOT NULL,
                OLD_VALUE TEXT,
                NEW_VALUE TEXT,
                USER_ID TEXT NOT NULL,
                USER_EMAIL TEXT NOT NULL,
                SOURCE TEXT NOT NULL,
                STATUS TEXT NOT NULL,
                COMMIT_MESSAGE TEXT,
                RISK_SCORE INTEGER NOT NULL DEFAULT 0,
                CREATED_AT TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS DATASET_MEMBERS (
                TABLE_ID TEXT NOT NULL,
                USER_ID TEXT NOT NULL,
                ROLE TEXT NOT NULL CHECK (ROLE IN ('viewer', 'editor')),
                ADDED_AT TEXT NOT NULL,
                PRIMARY KEY (TABLE_ID, USER_ID),
                FOREIGN KEY (TABLE_ID) REFERENCES DATASET_REGISTRY(TABLE_ID),
                FOREIGN KEY (USER_ID) REFERENCES APP_USERS(USER_ID)
            );

            CREATE TABLE IF NOT EXISTS DATASET_VERSIONS (
                TABLE_ID TEXT NOT NULL,
                VERSION INTEGER NOT NULL,
                BATCH_ID TEXT,
                SNAPSHOT_JSON TEXT NOT NULL,
                COMMIT_MESSAGE TEXT,
                USER_ID TEXT NOT NULL,
                CREATED_AT TEXT NOT NULL,
                PRIMARY KEY (TABLE_ID, VERSION)
            );

            CREATE TABLE IF NOT EXISTS DATASET_PRESENCE (
                TABLE_ID TEXT NOT NULL,
                USER_ID TEXT NOT NULL,
                CLIENT_ID TEXT NOT NULL,
                SURFACE TEXT NOT NULL,
                ACTIVITY TEXT NOT NULL,
                LAST_SEEN TEXT NOT NULL,
                PRIMARY KEY (TABLE_ID, USER_ID, CLIENT_ID)
            );

            CREATE TABLE IF NOT EXISTS USER_AI_SETTINGS (
                USER_ID TEXT PRIMARY KEY,
                API_KEY_ENCRYPTED TEXT NOT NULL,
                MODEL TEXT NOT NULL,
                UPDATED_AT TEXT NOT NULL,
                FOREIGN KEY (USER_ID) REFERENCES APP_USERS(USER_ID)
            );

            CREATE INDEX IF NOT EXISTS IDX_AUDIT_TABLE_VERSION
                ON AUDIT_COMMITS(TABLE_ID, VERSION DESC);
            CREATE INDEX IF NOT EXISTS IDX_AUDIT_BATCH
                ON AUDIT_COMMITS(BATCH_ID);
            CREATE INDEX IF NOT EXISTS IDX_AUDIT_USER
                ON AUDIT_COMMITS(USER_ID, CREATED_AT DESC);
            """
        )
        now = _utcnow()
        conn.execute(
            """
            INSERT OR IGNORE INTO APP_USERS
                (USER_ID, EMAIL, DISPLAY_NAME, ROLE, CREATED_AT, LAST_LOGIN_AT)
            VALUES ('USR_SYSTEM', 'system@local', 'System', 'system', ?, ?)
            """,
            (now, now),
        )
        tables = conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'QUEUE_BOARD_%'"
        ).fetchall()
        for row in tables:
            table_id = row[0]
            row_count = conn.execute(f'SELECT COUNT(*) FROM "{table_id}"').fetchone()[0]
            column_count = len(conn.execute(f'PRAGMA table_info("{table_id}")').fetchall()) - 1
            conn.execute(
                """
                INSERT OR IGNORE INTO DATASET_REGISTRY
                    (TABLE_ID, OWNER_USER_ID, ROW_COUNT, COLUMN_COUNT, CREATED_AT, UPDATED_AT)
                VALUES (?, 'USR_SYSTEM', ?, ?, ?, ?)
                """,
                (table_id, row_count, column_count, now, now),
            )
            current_version = conn.execute(
                "SELECT CURRENT_VERSION FROM DATASET_REGISTRY WHERE TABLE_ID=?",
                (table_id,),
            ).fetchone()[0]
            _store_dataset_version(
                conn, table_id, int(current_version), None,
                "Imported existing dataset state", "USR_SYSTEM", now,
            )
        conn.commit()
    finally:
        conn.close()


def _get_connection() -> sqlite3.Connection:
    """Open (or create) the SQLite database and return a connection."""
    conn = sqlite3.connect(str(DB_PATH))
    conn.execute("PRAGMA journal_mode=WAL;")  # better concurrent read perf
    conn.execute("PRAGMA busy_timeout=5000;")
    conn.execute("PRAGMA foreign_keys=ON;")
    conn.row_factory = sqlite3.Row
    return conn


# ---------------------------------------------------------------------------
# Column-name sanitizer
# ---------------------------------------------------------------------------
_CLEAN_RE = re.compile(r"[^A-Z0-9_]")


def _sanitize_column_name(raw: str) -> str:
    """
    Sanitize a raw Excel header into a safe SQLite column name.

    Rules:
      1. Strip leading/trailing whitespace
      2. Replace spaces & special characters with underscores
      3. Force UPPERCASE
      4. Cap at 30 characters
      5. Ensure it does not start with a digit (prefix with underscore)
    """
    name = raw.strip().upper().replace(" ", "_")
    name = _CLEAN_RE.sub("_", name)
    # collapse consecutive underscores
    name = re.sub(r"_+", "_", name).strip("_")
    if not name:
        name = "COL"
    if name[0].isdigit():
        name = "_" + name
    return name[:30]


# ---------------------------------------------------------------------------
# Pandas dtype → SQLite type mapping
# ---------------------------------------------------------------------------
def _map_dtype(dtype) -> str:
    """Map a pandas Series dtype to a SQLite column type."""
    kind = dtype.kind
    if kind in ("i", "u"):  # signed/unsigned integer
        return "INTEGER"
    if kind == "f":  # floating point
        return "REAL"
    if kind == "b":  # boolean
        return "INTEGER"
    # everything else (object, string, datetime, etc.) → TEXT
    return "TEXT"


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------
def create_sqlite_table_from_df(table_name: str, df: pd.DataFrame) -> dict[str, Any]:
    """
    Dynamically create a SQLite table from a pandas DataFrame and seed it
    with the DataFrame's rows.

    Parameters
    ----------
    table_name : str
        The target table name (already expected to be sanitized by the caller).
    df : pd.DataFrame
        The data parsed from the uploaded Excel file.

    Returns
    -------
    dict
        {"row_count": int, "column_count": int, "columns": list[str]}

    Raises
    ------
    RuntimeError
        On any SQLite error (with automatic rollback).
    """
    # --- Sanitize column names ------------------------------------------------
    sanitized_cols: list[str] = []
    seen: set[str] = set()
    for raw_col in df.columns:
        col = _sanitize_column_name(str(raw_col))
        # deduplicate
        base, suffix = col, 1
        while col in seen:
            col = f"{base}_{suffix}"[:30]
            suffix += 1
        seen.add(col)
        sanitized_cols.append(col)

    # Map pandas dtypes to SQLite types
    col_defs = []
    for col, dtype in zip(sanitized_cols, df.dtypes):
        col_defs.append(f'"{col}" {_map_dtype(dtype)}')

    # Build CREATE TABLE DDL with ROW_ID auto-increment PK
    ddl_columns = ",\n    ".join(
        ["ROW_ID INTEGER PRIMARY KEY AUTOINCREMENT"] + col_defs
    )
    create_sql = f'CREATE TABLE IF NOT EXISTS "{table_name}" (\n    {ddl_columns}\n);'

    # Build INSERT statement
    placeholders = ", ".join(["?"] * len(sanitized_cols))
    col_list = ", ".join(f'"{c}"' for c in sanitized_cols)
    insert_sql = f'INSERT INTO "{table_name}" ({col_list}) VALUES ({placeholders})'

    # Prepare row data — convert NaN/NaT to None for SQLite
    rows: list[tuple] = []
    for _, row in df.iterrows():
        vals = []
        for v in row:
            if pd.isna(v):
                vals.append(None)
            else:
                vals.append(v)
        rows.append(tuple(vals))

    # Execute within a transaction
    conn = _get_connection()
    try:
        cursor = conn.cursor()
        cursor.execute(create_sql)
        cursor.executemany(insert_sql, rows)
        conn.commit()
        return {
            "row_count": len(rows),
            "column_count": len(sanitized_cols),
            "columns": sanitized_cols,
        }
    except Exception as exc:
        conn.rollback()
        raise RuntimeError(f"SQLite table creation failed: {exc}") from exc
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Validation helpers (used by the sync endpoint)
# ---------------------------------------------------------------------------
# Whitelist pattern for identifiers (table names, column names)
_IDENT_RE = re.compile(r"^[A-Z][A-Z0-9_]{0,63}$")


def validate_identifier(name: str) -> bool:
    """Return True if `name` is a safe SQL identifier."""
    return bool(_IDENT_RE.match(name))


def table_exists(table_name: str) -> bool:
    """Check whether a table exists in the database."""
    conn = _get_connection()
    try:
        cursor = conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name=?;",
            (table_name,),
        )
        return cursor.fetchone() is not None
    finally:
        conn.close()


def column_exists(table_name: str, column_name: str) -> bool:
    """Check whether a column exists in the given table."""
    conn = _get_connection()
    try:
        cursor = conn.execute(f'PRAGMA table_info("{table_name}");')
        columns = [row["name"].upper() for row in cursor.fetchall()]
        return column_name.upper() in columns
    finally:
        conn.close()


def read_cell(table_name: str, column_name: str, row_id: int) -> Any:
    """Read one cell from the canonical backend database."""
    if not validate_identifier(table_name):
        raise ValueError(f"Invalid table identifier: {table_name}")
    if not validate_identifier(column_name):
        raise ValueError(f"Invalid column identifier: {column_name}")

    sql = f'SELECT "{column_name}" FROM "{table_name}" WHERE ROW_ID = ?;'
    conn = _get_connection()
    try:
        row = conn.execute(sql, (row_id,)).fetchone()
        if row is None:
            raise ValueError(f"No row with ROW_ID={row_id} in table {table_name}")
        return row[0]
    except ValueError:
        raise
    except Exception as exc:
        raise RuntimeError(f"Cell read failed: {exc}") from exc
    finally:
        conn.close()


def _values_match(requested: Any, persisted: Any) -> bool:
    """Compare values after SQLite column affinity has been applied."""
    if requested is None or persisted is None:
        return requested is None and persisted is None
    return str(requested) == str(persisted)


def update_cell(
    table_name: str, column_name: str, row_id: int, new_value: Any
) -> dict[str, Any]:
    """
    Execute a parameterized UPDATE on a single cell.

    Uses quoted identifiers for table/column but parameterized binding for
    values — safe against SQL injection.
    """
    if not validate_identifier(table_name):
        raise ValueError(f"Invalid table identifier: {table_name}")
    if not validate_identifier(column_name):
        raise ValueError(f"Invalid column identifier: {column_name}")

    select_sql = f'SELECT "{column_name}" FROM "{table_name}" WHERE ROW_ID = ?;'
    update_sql = f'UPDATE "{table_name}" SET "{column_name}" = ? WHERE ROW_ID = ?;'

    conn = _get_connection()
    try:
        conn.execute("BEGIN IMMEDIATE;")
        previous_row = conn.execute(select_sql, (row_id,)).fetchone()
        if previous_row is None:
            raise ValueError(
                f"No row with ROW_ID={row_id} in table {table_name}"
            )

        previous_value = previous_row[0]
        cursor = conn.execute(update_sql, (new_value, row_id))
        if cursor.rowcount == 0:
            raise ValueError(
                f"No row with ROW_ID={row_id} in table {table_name}"
            )
        conn.commit()

        persisted_value = conn.execute(select_sql, (row_id,)).fetchone()[0]
        if not _values_match(new_value, persisted_value):
            raise RuntimeError(
                "SQLite readback did not match the requested value: "
                f"requested={new_value!r}, persisted={persisted_value!r}"
            )

        # Make committed WAL pages promptly visible to external SQLite tools.
        conn.execute("PRAGMA wal_checkpoint(PASSIVE);").fetchone()
        return {
            "previous_value": previous_value,
            "persisted_value": persisted_value,
            "changed": not _values_match(previous_value, persisted_value),
        }
    except ValueError:
        conn.rollback()
        raise
    except RuntimeError:
        conn.rollback()
        raise
    except Exception as exc:
        conn.rollback()
        raise RuntimeError(f"Cell update failed: {exc}") from exc
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Authentication, audit, and product-facing data access
# ---------------------------------------------------------------------------

def create_login_code(email: str, code_hash: str, expires_at: str) -> None:
    conn = _get_connection()
    try:
        conn.execute(
            "UPDATE AUTH_LOGIN_CODES SET USED_AT=? WHERE EMAIL=? AND USED_AT IS NULL",
            (_utcnow(), email.lower()),
        )
        conn.execute(
            """
            INSERT INTO AUTH_LOGIN_CODES (EMAIL, CODE_HASH, EXPIRES_AT, CREATED_AT)
            VALUES (?, ?, ?, ?)
            """,
            (email.lower(), code_hash, expires_at, _utcnow()),
        )
        conn.commit()
    finally:
        conn.close()


def consume_login_code(email: str, code_hash: str) -> bool:
    conn = _get_connection()
    try:
        conn.execute("BEGIN IMMEDIATE")
        row = conn.execute(
            """
            SELECT ID FROM AUTH_LOGIN_CODES
            WHERE EMAIL=? AND CODE_HASH=? AND USED_AT IS NULL AND EXPIRES_AT>?
            ORDER BY ID DESC LIMIT 1
            """,
            (email.lower(), code_hash, _utcnow()),
        ).fetchone()
        if not row:
            conn.rollback()
            return False
        conn.execute("UPDATE AUTH_LOGIN_CODES SET USED_AT=? WHERE ID=?", (_utcnow(), row[0]))
        conn.commit()
        return True
    finally:
        conn.close()


def get_or_create_user(email: str) -> dict[str, Any]:
    normalized = email.strip().lower()
    conn = _get_connection()
    try:
        now = _utcnow()
        row = conn.execute("SELECT * FROM APP_USERS WHERE EMAIL=?", (normalized,)).fetchone()
        if row:
            conn.execute("UPDATE APP_USERS SET LAST_LOGIN_AT=? WHERE USER_ID=?", (now, row["USER_ID"]))
            conn.commit()
            return {key.lower(): row[key] for key in row.keys()}

        user_id = f"USR_{uuid.uuid4().hex[:12].upper()}"
        display_name = normalized.split("@", 1)[0].replace(".", " ").title()
        conn.execute(
            """
            INSERT INTO APP_USERS
                (USER_ID, EMAIL, DISPLAY_NAME, ROLE, CREATED_AT, LAST_LOGIN_AT)
            VALUES (?, ?, ?, 'member', ?, ?)
            """,
            (user_id, normalized, display_name, now, now),
        )
        conn.commit()
        return {
            "user_id": user_id,
            "email": normalized,
            "display_name": display_name,
            "role": "member",
            "created_at": now,
            "last_login_at": now,
        }
    finally:
        conn.close()


def get_user(user_id: str) -> dict[str, Any] | None:
    conn = _get_connection()
    try:
        row = conn.execute("SELECT * FROM APP_USERS WHERE USER_ID=?", (user_id,)).fetchone()
        return {key.lower(): row[key] for key in row.keys()} if row else None
    finally:
        conn.close()


def save_user_ai_settings(user_id: str, encrypted_key: str, model: str) -> None:
    conn = _get_connection()
    try:
        conn.execute(
            """
            INSERT INTO USER_AI_SETTINGS (USER_ID, API_KEY_ENCRYPTED, MODEL, UPDATED_AT)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(USER_ID) DO UPDATE SET
                API_KEY_ENCRYPTED=excluded.API_KEY_ENCRYPTED,
                MODEL=excluded.MODEL,
                UPDATED_AT=excluded.UPDATED_AT
            """,
            (user_id, encrypted_key, model, _utcnow()),
        )
        conn.commit()
    finally:
        conn.close()


def get_user_ai_settings(user_id: str) -> dict[str, Any] | None:
    conn = _get_connection()
    try:
        row = conn.execute(
            "SELECT API_KEY_ENCRYPTED, MODEL, UPDATED_AT FROM USER_AI_SETTINGS WHERE USER_ID=?",
            (user_id,),
        ).fetchone()
        return {
            "api_key_encrypted": row[0], "model": row[1], "updated_at": row[2]
        } if row else None
    finally:
        conn.close()


def delete_user_ai_settings(user_id: str) -> None:
    conn = _get_connection()
    try:
        conn.execute("DELETE FROM USER_AI_SETTINGS WHERE USER_ID=?", (user_id,))
        conn.commit()
    finally:
        conn.close()


def register_dataset(
    table_id: str,
    owner_user_id: str,
    filename: str,
    row_count: int,
    column_count: int,
) -> None:
    conn = _get_connection()
    try:
        now = _utcnow()
        conn.execute(
            """
            INSERT OR REPLACE INTO DATASET_REGISTRY
                (TABLE_ID, OWNER_USER_ID, ORIGINAL_FILENAME, ROW_COUNT,
                 COLUMN_COUNT, CREATED_AT, UPDATED_AT, CURRENT_VERSION)
            VALUES (?, ?, ?, ?, ?, ?, ?, 0)
            """,
            (table_id, owner_user_id, filename, row_count, column_count, now, now),
        )
        _store_dataset_version(
            conn, table_id, 0, None, "Initial workbook import", owner_user_id, now
        )
        conn.commit()
    finally:
        conn.close()


def user_can_access_table(table_id: str, user_id: str) -> bool:
    conn = _get_connection()
    try:
        row = conn.execute(
            """
            SELECT 1 FROM DATASET_REGISTRY D
            WHERE D.TABLE_ID=? AND (
                D.OWNER_USER_ID IN (?, 'USR_SYSTEM') OR EXISTS (
                    SELECT 1 FROM DATASET_MEMBERS M
                    WHERE M.TABLE_ID=D.TABLE_ID AND M.USER_ID=?
                )
            )
            """,
            (table_id, user_id, user_id),
        ).fetchone()
        return row is not None
    finally:
        conn.close()


def user_can_edit_table(table_id: str, user_id: str) -> bool:
    conn = _get_connection()
    try:
        row = conn.execute(
            """
            SELECT 1 FROM DATASET_REGISTRY D
            WHERE D.TABLE_ID=? AND (
                D.OWNER_USER_ID IN (?, 'USR_SYSTEM') OR EXISTS (
                    SELECT 1 FROM DATASET_MEMBERS M
                    WHERE M.TABLE_ID=D.TABLE_ID AND M.USER_ID=? AND M.ROLE='editor'
                )
            )
            """,
            (table_id, user_id, user_id),
        ).fetchone()
        return row is not None
    finally:
        conn.close()


def get_dataset_members(table_id: str) -> list[dict[str, Any]]:
    conn = _get_connection()
    try:
        rows = conn.execute(
            """
            SELECT U.USER_ID, U.EMAIL, U.DISPLAY_NAME, 'owner' AS ROLE, D.CREATED_AT AS ADDED_AT
            FROM DATASET_REGISTRY D JOIN APP_USERS U ON U.USER_ID=D.OWNER_USER_ID
            WHERE D.TABLE_ID=?
            UNION ALL
            SELECT U.USER_ID, U.EMAIL, U.DISPLAY_NAME, M.ROLE, M.ADDED_AT
            FROM DATASET_MEMBERS M JOIN APP_USERS U ON U.USER_ID=M.USER_ID
            WHERE M.TABLE_ID=?
            ORDER BY ROLE, EMAIL
            """,
            (table_id, table_id),
        ).fetchall()
        return [{key.lower(): row[key] for key in row.keys()} for row in rows]
    finally:
        conn.close()


def touch_dataset_presence(
    table_id: str, user_id: str, client_id: str, surface: str, activity: str
) -> None:
    conn = _get_connection()
    try:
        conn.execute(
            """
            INSERT INTO DATASET_PRESENCE
                (TABLE_ID, USER_ID, CLIENT_ID, SURFACE, ACTIVITY, LAST_SEEN)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(TABLE_ID, USER_ID, CLIENT_ID) DO UPDATE SET
                SURFACE=excluded.SURFACE,
                ACTIVITY=excluded.ACTIVITY,
                LAST_SEEN=excluded.LAST_SEEN
            """,
            (table_id, user_id, client_id, surface, activity, _utcnow()),
        )
        conn.commit()
    finally:
        conn.close()


def remove_dataset_presence(table_id: str, user_id: str, client_id: str) -> None:
    conn = _get_connection()
    try:
        conn.execute(
            "DELETE FROM DATASET_PRESENCE WHERE TABLE_ID=? AND USER_ID=? AND CLIENT_ID=?",
            (table_id, user_id, client_id),
        )
        conn.commit()
    finally:
        conn.close()


def list_active_presence(table_id: str, ttl_seconds: int = 45) -> list[dict[str, Any]]:
    cutoff = (datetime.now(timezone.utc).timestamp() - ttl_seconds)
    cutoff_iso = datetime.fromtimestamp(cutoff, timezone.utc).isoformat()
    conn = _get_connection()
    try:
        conn.execute("DELETE FROM DATASET_PRESENCE WHERE LAST_SEEN<?", (cutoff_iso,))
        rows = conn.execute(
            """
            SELECT P.USER_ID, U.EMAIL, U.DISPLAY_NAME,
                   MAX(P.LAST_SEEN) AS LAST_SEEN,
                   GROUP_CONCAT(DISTINCT P.SURFACE) AS SURFACES,
                   GROUP_CONCAT(DISTINCT P.ACTIVITY) AS ACTIVITIES,
                   COUNT(*) AS CLIENT_COUNT
            FROM DATASET_PRESENCE P
            JOIN APP_USERS U ON U.USER_ID=P.USER_ID
            WHERE P.TABLE_ID=? AND P.LAST_SEEN>=?
            GROUP BY P.USER_ID, U.EMAIL, U.DISPLAY_NAME
            ORDER BY LAST_SEEN DESC
            """,
            (table_id, cutoff_iso),
        ).fetchall()
        conn.commit()
        return [
            {
                "user_id": row["USER_ID"],
                "email": row["EMAIL"],
                "display_name": row["DISPLAY_NAME"],
                "last_seen": row["LAST_SEEN"],
                "surfaces": (row["SURFACES"] or "").split(","),
                "activities": (row["ACTIVITIES"] or "").split(","),
                "client_count": row["CLIENT_COUNT"],
            }
            for row in rows
        ]
    finally:
        conn.close()


def add_dataset_member(
    table_id: str, owner_user_id: str, email: str, role: str
) -> dict[str, Any]:
    normalized_role = role.strip().lower()
    if normalized_role not in {"viewer", "editor"}:
        raise ValueError("Role must be viewer or editor")
    conn = _get_connection()
    try:
        owner = conn.execute(
            "SELECT OWNER_USER_ID FROM DATASET_REGISTRY WHERE TABLE_ID=?",
            (table_id,),
        ).fetchone()
        if not owner or owner[0] != owner_user_id:
            raise PermissionError("Only the dataset owner can manage access")
        user = conn.execute(
            "SELECT USER_ID, EMAIL, DISPLAY_NAME FROM APP_USERS WHERE EMAIL=? COLLATE NOCASE",
            (email.strip().lower(),),
        ).fetchone()
        if not user:
            raise ValueError("That collaborator must sign in once before being added")
        if user[0] == owner_user_id:
            raise ValueError("The dataset owner already has full access")
        now = _utcnow()
        conn.execute(
            """
            INSERT INTO DATASET_MEMBERS (TABLE_ID, USER_ID, ROLE, ADDED_AT)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(TABLE_ID, USER_ID) DO UPDATE SET ROLE=excluded.ROLE
            """,
            (table_id, user[0], normalized_role, now),
        )
        conn.commit()
        return {
            "user_id": user[0], "email": user[1], "display_name": user[2],
            "role": normalized_role, "added_at": now,
        }
    finally:
        conn.close()


def list_datasets(user_id: str) -> list[dict[str, Any]]:
    conn = _get_connection()
    try:
        rows = conn.execute(
            """
            SELECT D.*, U.EMAIL AS OWNER_EMAIL,
                   (SELECT COUNT(DISTINCT BATCH_ID) FROM AUDIT_COMMITS A
                    WHERE A.TABLE_ID=D.TABLE_ID) AS COMMIT_COUNT
            FROM DATASET_REGISTRY D
            JOIN APP_USERS U ON U.USER_ID=D.OWNER_USER_ID
            WHERE D.OWNER_USER_ID IN (?, 'USR_SYSTEM') OR EXISTS (
                SELECT 1 FROM DATASET_MEMBERS M
                WHERE M.TABLE_ID=D.TABLE_ID AND M.USER_ID=?
            )
            ORDER BY D.UPDATED_AT DESC
            """,
            (user_id, user_id),
        ).fetchall()
        return [{key.lower(): row[key] for key in row.keys()} for row in rows]
    finally:
        conn.close()


def get_table_page(table_id: str, limit: int = 100, offset: int = 0) -> dict[str, Any]:
    if not validate_identifier(table_id):
        raise ValueError("Invalid table identifier")
    limit = max(1, min(limit, 500))
    offset = max(0, offset)
    conn = _get_connection()
    try:
        columns = [row["name"] for row in conn.execute(f'PRAGMA table_info("{table_id}")')]
        if not columns:
            raise ValueError(f"Table {table_id} does not exist")
        total = conn.execute(f'SELECT COUNT(*) FROM "{table_id}"').fetchone()[0]
        rows = conn.execute(
            f'SELECT * FROM "{table_id}" ORDER BY ROW_ID LIMIT ? OFFSET ?',
            (limit, offset),
        ).fetchall()
        version_row = conn.execute(
            "SELECT CURRENT_VERSION, UPDATED_AT FROM DATASET_REGISTRY WHERE TABLE_ID=?",
            (table_id,),
        ).fetchone()
        return {
            "table_id": table_id,
            "columns": columns,
            "rows": [[row[column] for column in columns] for row in rows],
            "total": total,
            "limit": limit,
            "offset": offset,
            "version": version_row[0] if version_row else 0,
            "updated_at": version_row[1] if version_row else None,
        }
    finally:
        conn.close()


def _snapshot_from_connection(
    conn: sqlite3.Connection, table_id: str, max_rows: int = 100_000
) -> dict[str, Any]:
    column_rows = conn.execute(f'PRAGMA table_info("{table_id}")').fetchall()
    columns = [row["name"] for row in column_rows]
    if not columns:
        raise ValueError(f"Table {table_id} does not exist")
    total = conn.execute(f'SELECT COUNT(*) FROM "{table_id}"').fetchone()[0]
    if total > max_rows:
        raise ValueError(
            f"Dataset has {total} rows; Excel pull is limited to {max_rows} rows"
        )
    rows = conn.execute(f'SELECT * FROM "{table_id}" ORDER BY ROW_ID').fetchall()
    return {
        "table_id": table_id,
        "columns": columns,
        "column_types": [row["type"] or "TEXT" for row in column_rows],
        "rows": [[row[column] for column in columns] for row in rows],
        "total": total,
    }


def _store_dataset_version(
    conn: sqlite3.Connection,
    table_id: str,
    version: int,
    batch_id: str | None,
    commit_message: str,
    user_id: str,
    created_at: str,
) -> None:
    exists = conn.execute(
        "SELECT 1 FROM DATASET_VERSIONS WHERE TABLE_ID=? AND VERSION=?",
        (table_id, version),
    ).fetchone()
    if exists:
        return
    snapshot = _snapshot_from_connection(conn, table_id)
    conn.execute(
        """
        INSERT OR IGNORE INTO DATASET_VERSIONS
            (TABLE_ID, VERSION, BATCH_ID, SNAPSHOT_JSON, COMMIT_MESSAGE,
             USER_ID, CREATED_AT)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        (
            table_id, version, batch_id,
            json.dumps(snapshot, default=str, separators=(",", ":")),
            commit_message, user_id, created_at,
        ),
    )


def get_table_snapshot(
    table_id: str, version: int | None = None, max_rows: int = 100_000
) -> dict[str, Any]:
    """Return a complete ordered dataset snapshot for Excel clone/pull operations."""
    if not validate_identifier(table_id):
        raise ValueError("Invalid table identifier")
    conn = _get_connection()
    try:
        registry = conn.execute(
            "SELECT CURRENT_VERSION, UPDATED_AT FROM DATASET_REGISTRY WHERE TABLE_ID=?",
            (table_id,),
        ).fetchone()
        if not registry:
            raise ValueError(f"Dataset {table_id} is not registered")
        current_version = int(registry[0])
        requested_version = current_version if version is None else version
        if requested_version == current_version:
            snapshot = _snapshot_from_connection(conn, table_id, max_rows)
        else:
            stored = conn.execute(
                "SELECT SNAPSHOT_JSON FROM DATASET_VERSIONS WHERE TABLE_ID=? AND VERSION=?",
                (table_id, requested_version),
            ).fetchone()
            if not stored:
                raise ValueError(f"Version {requested_version} is not available")
            snapshot = json.loads(stored[0])
            if snapshot["total"] > max_rows:
                raise ValueError(
                    f"Dataset has {snapshot['total']} rows; Excel pull is limited to {max_rows} rows"
                )
        snapshot["version"] = requested_version
        snapshot["current_version"] = current_version
        snapshot["updated_at"] = registry[1]
        return snapshot
    finally:
        conn.close()


def _risk_score(changes: list[dict[str, Any]]) -> int:
    sensitive_markers = {"SALARY", "AMOUNT", "PRICE", "STATUS", "EMAIL", "PHONE", "ID"}
    rows = {int(change["row_id"]) for change in changes}
    sensitive = sum(
        1
        for change in changes
        if any(marker in change["column_name"].upper() for marker in sensitive_markers)
    )
    return min(100, len(changes) * 2 + len(rows) * 2 + sensitive * 5)


def apply_bulk_updates(
    table_id: str,
    changes: list[dict[str, Any]],
    user_id: str,
    user_email: str,
    source: str = "excel",
    commit_message: str | None = None,
) -> dict[str, Any]:
    """Atomically apply a range edit and record an immutable change set."""
    if not validate_identifier(table_id):
        raise ValueError("Invalid table identifier")
    if not changes:
        raise ValueError("At least one change is required")
    if len(changes) > 5000:
        raise ValueError("A single sync batch cannot exceed 5000 cells")

    normalized = []
    for change in changes:
        column = str(change["column_name"]).strip().upper()
        row_id = int(change["row_id"])
        if not validate_identifier(column) or row_id < 1:
            raise ValueError("Invalid row or column in bulk change")
        normalized.append({"row_id": row_id, "column_name": column, "new_value": change.get("new_value")})

    conn = _get_connection()
    batch_id = f"CHG_{uuid.uuid4().hex[:12].upper()}"
    now = _utcnow()
    risk = _risk_score(normalized)
    try:
        conn.execute("BEGIN IMMEDIATE")
        columns = {row["name"].upper() for row in conn.execute(f'PRAGMA table_info("{table_id}")')}
        missing = {change["column_name"] for change in normalized} - columns
        if missing:
            raise ValueError(f"Columns not found: {', '.join(sorted(missing))}")

        registry = conn.execute(
            "SELECT CURRENT_VERSION FROM DATASET_REGISTRY WHERE TABLE_ID=?",
            (table_id,),
        ).fetchone()
        if not registry:
            raise ValueError(f"Dataset {table_id} is not registered")
        version = int(registry[0]) + 1
        changed_count = 0
        results = []

        for change in normalized:
            column = change["column_name"]
            row_id = change["row_id"]
            select_sql = f'SELECT "{column}" FROM "{table_id}" WHERE ROW_ID=?'
            row = conn.execute(select_sql, (row_id,)).fetchone()
            if row is None:
                raise ValueError(f"No row with ROW_ID={row_id} in {table_id}")
            old_value = row[0]
            new_value = change["new_value"]
            changed = not _values_match(old_value, new_value)
            if changed:
                conn.execute(
                    f'UPDATE "{table_id}" SET "{column}"=? WHERE ROW_ID=?',
                    (new_value, row_id),
                )
                changed_count += 1

            persisted = conn.execute(select_sql, (row_id,)).fetchone()[0]
            if not _values_match(new_value, persisted):
                raise RuntimeError(f"Readback mismatch at ROW_ID={row_id}, {column}")
            conn.execute(
                """
                INSERT INTO AUDIT_COMMITS
                    (AUDIT_ID, BATCH_ID, VERSION, TABLE_ID, ROW_ID, COLUMN_NAME,
                     OLD_VALUE, NEW_VALUE, USER_ID, USER_EMAIL, SOURCE, STATUS,
                     COMMIT_MESSAGE, RISK_SCORE, CREATED_AT)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    f"AUD_{uuid.uuid4().hex[:16].upper()}", batch_id, version,
                    table_id, row_id, column, json.dumps(old_value), json.dumps(persisted),
                    user_id, user_email, source, "UPDATED" if changed else "NO_CHANGE",
                    commit_message or f"Updated {len(normalized)} cell(s) from {source}",
                    risk, now,
                ),
            )
            results.append({
                "row_id": row_id,
                "column_name": column,
                "persisted_value": persisted,
                "changed": changed,
            })

        conn.execute(
            """
            UPDATE DATASET_REGISTRY
            SET CURRENT_VERSION=?, UPDATED_AT=?
            WHERE TABLE_ID=?
            """,
            (version, now, table_id),
        )
        _store_dataset_version(
            conn,
            table_id,
            version,
            batch_id,
            commit_message or f"Updated {len(normalized)} cell(s) from {source}",
            user_id,
            now,
        )
        conn.commit()
        conn.execute("PRAGMA wal_checkpoint(PASSIVE)").fetchone()
        return {
            "status": "SUCCESS",
            "batch_id": batch_id,
            "version": version,
            "requested_count": len(normalized),
            "changed_count": changed_count,
            "risk_score": risk,
            "timestamp": now,
            "results": results,
        }
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def apply_workbook_commit(
    table_id: str,
    base_version: int,
    updates: list[dict[str, Any]],
    insert_rows: list[dict[str, Any]],
    delete_row_ids: list[int],
    new_columns: list[str],
    delete_columns: list[str],
    user_id: str,
    user_email: str,
    source: str,
    commit_message: str,
) -> dict[str, Any]:
    """Apply a Git-style workbook diff as one version-checked transaction."""
    if not validate_identifier(table_id):
        raise ValueError("Invalid table identifier")

    normalized_updates: dict[tuple[int, str], dict[str, Any]] = {}
    for change in updates:
        row_id = int(change["row_id"])
        column = str(change["column_name"]).strip().upper()
        if row_id < 1 or not validate_identifier(column) or column == "ROW_ID":
            raise ValueError("Invalid row or column in workbook update")
        normalized_updates[(row_id, column)] = {
            "row_id": row_id,
            "column_name": column,
            "new_value": change.get("new_value"),
        }
    updates = list(normalized_updates.values())

    def normalize_columns(values: list[str]) -> list[str]:
        result = []
        for raw in values:
            column = str(raw).strip().upper()
            if not validate_identifier(column) or column == "ROW_ID":
                raise ValueError(f"Invalid workbook column: {raw}")
            if column not in result:
                result.append(column)
        return result

    new_columns = normalize_columns(new_columns)
    delete_columns = normalize_columns(delete_columns)
    if set(new_columns) & set(delete_columns):
        raise ValueError("A column cannot be added and deleted in the same commit")

    normalized_inserts = []
    for raw_row in insert_rows:
        row = {}
        for raw_column, value in raw_row.items():
            column = str(raw_column).strip().upper()
            if not validate_identifier(column) or column == "ROW_ID":
                raise ValueError(f"Invalid inserted-row column: {raw_column}")
            row[column] = value
        normalized_inserts.append(row)

    delete_row_ids = list(dict.fromkeys(int(row_id) for row_id in delete_row_ids))
    if any(row_id < 1 for row_id in delete_row_ids):
        raise ValueError("Invalid ROW_ID in deleted rows")

    operation_size = (
        len(updates) + sum(len(row) for row in normalized_inserts)
        + len(delete_row_ids) + len(new_columns) + len(delete_columns)
    )
    if operation_size == 0:
        raise ValueError("There are no workbook changes to commit")
    if operation_size > 10_000:
        raise ValueError("A workbook commit cannot exceed 10,000 operations")

    conn = _get_connection()
    batch_id = f"CHG_{uuid.uuid4().hex[:12].upper()}"
    now = _utcnow()
    version = base_version + 1
    risk_inputs = updates + [
        {"row_id": 0, "column_name": column}
        for column in new_columns + delete_columns
    ] + [
        {"row_id": 0, "column_name": column}
        for row in normalized_inserts for column in row
    ] + [
        {"row_id": row_id, "column_name": "ROW_ID"}
        for row_id in delete_row_ids
    ]
    risk = _risk_score(risk_inputs)

    def audit(
        row_id: int, column: str, old_value: Any, new_value: Any, status: str
    ) -> None:
        conn.execute(
            """
            INSERT INTO AUDIT_COMMITS
                (AUDIT_ID, BATCH_ID, VERSION, TABLE_ID, ROW_ID, COLUMN_NAME,
                 OLD_VALUE, NEW_VALUE, USER_ID, USER_EMAIL, SOURCE, STATUS,
                 COMMIT_MESSAGE, RISK_SCORE, CREATED_AT)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                f"AUD_{uuid.uuid4().hex[:16].upper()}", batch_id, version,
                table_id, row_id, column,
                json.dumps(old_value, default=str), json.dumps(new_value, default=str),
                user_id, user_email, source, status, commit_message, risk, now,
            ),
        )

    try:
        conn.execute("BEGIN IMMEDIATE")
        registry = conn.execute(
            "SELECT CURRENT_VERSION FROM DATASET_REGISTRY WHERE TABLE_ID=?",
            (table_id,),
        ).fetchone()
        if not registry:
            raise ValueError(f"Dataset {table_id} is not registered")
        current_version = int(registry[0])
        if current_version != base_version:
            raise VersionConflictError(current_version)

        existing = {
            row["name"].upper(): row
            for row in conn.execute(f'PRAGMA table_info("{table_id}")')
        }
        already_present = set(new_columns) & set(existing)
        missing_deleted = set(delete_columns) - set(existing)
        if already_present:
            raise ValueError(f"Columns already exist: {', '.join(sorted(already_present))}")
        if missing_deleted:
            raise ValueError(f"Columns do not exist: {', '.join(sorted(missing_deleted))}")

        future_columns = (set(existing) | set(new_columns)) - set(delete_columns)
        referenced = {change["column_name"] for change in updates}
        referenced.update(column for row in normalized_inserts for column in row)
        missing_references = referenced - future_columns
        if missing_references:
            raise ValueError(
                f"Commit references unavailable columns: {', '.join(sorted(missing_references))}"
            )

        for column in new_columns:
            conn.execute(f'ALTER TABLE "{table_id}" ADD COLUMN "{column}" TEXT')
            audit(0, column, None, "TEXT", "COLUMN_ADDED")

        changed_updates = 0
        for change in updates:
            column = change["column_name"]
            row_id = change["row_id"]
            row = conn.execute(
                f'SELECT "{column}" FROM "{table_id}" WHERE ROW_ID=?',
                (row_id,),
            ).fetchone()
            if row is None:
                raise ValueError(f"No row with ROW_ID={row_id} in {table_id}")
            old_value = row[0]
            new_value = change.get("new_value")
            changed = not _values_match(old_value, new_value)
            if changed:
                conn.execute(
                    f'UPDATE "{table_id}" SET "{column}"=? WHERE ROW_ID=?',
                    (new_value, row_id),
                )
                changed_updates += 1
            persisted = conn.execute(
                f'SELECT "{column}" FROM "{table_id}" WHERE ROW_ID=?',
                (row_id,),
            ).fetchone()[0]
            if not _values_match(new_value, persisted):
                raise RuntimeError(f"Readback mismatch at ROW_ID={row_id}, {column}")
            audit(row_id, column, old_value, persisted, "UPDATED" if changed else "NO_CHANGE")

        inserted_ids = []
        for row in normalized_inserts:
            if row:
                columns = list(row)
                sql = (
                    f'INSERT INTO "{table_id}" ('
                    + ", ".join(f'"{column}"' for column in columns)
                    + ") VALUES ("
                    + ", ".join("?" for _ in columns)
                    + ")"
                )
                cursor = conn.execute(sql, tuple(row[column] for column in columns))
            else:
                cursor = conn.execute(f'INSERT INTO "{table_id}" DEFAULT VALUES')
                columns = []
            row_id = int(cursor.lastrowid)
            inserted_ids.append(row_id)
            if columns:
                persisted = conn.execute(
                    f'SELECT * FROM "{table_id}" WHERE ROW_ID=?', (row_id,)
                ).fetchone()
                for column in columns:
                    audit(row_id, column, None, persisted[column], "INSERTED")
            else:
                audit(row_id, "__ROW__", None, row_id, "INSERTED")

        deleted_count = 0
        for row_id in delete_row_ids:
            row = conn.execute(
                f'SELECT * FROM "{table_id}" WHERE ROW_ID=?', (row_id,)
            ).fetchone()
            if row is None:
                raise ValueError(f"No row with ROW_ID={row_id} in {table_id}")
            for column in row.keys():
                if column.upper() != "ROW_ID" and column.upper() not in delete_columns:
                    audit(row_id, column.upper(), row[column], None, "DELETED")
            conn.execute(f'DELETE FROM "{table_id}" WHERE ROW_ID=?', (row_id,))
            deleted_count += 1

        for column in delete_columns:
            values = conn.execute(
                f'SELECT ROW_ID, "{column}" FROM "{table_id}" ORDER BY ROW_ID'
            ).fetchall()
            old_values = {str(row[0]): row[1] for row in values}
            audit(0, column, old_values, None, "COLUMN_DELETED")
            conn.execute(f'ALTER TABLE "{table_id}" DROP COLUMN "{column}"')

        row_count = conn.execute(f'SELECT COUNT(*) FROM "{table_id}"').fetchone()[0]
        column_count = len(conn.execute(f'PRAGMA table_info("{table_id}")').fetchall()) - 1
        conn.execute(
            """
            UPDATE DATASET_REGISTRY
            SET CURRENT_VERSION=?, UPDATED_AT=?, ROW_COUNT=?, COLUMN_COUNT=?
            WHERE TABLE_ID=?
            """,
            (version, now, row_count, column_count, table_id),
        )
        _store_dataset_version(
            conn, table_id, version, batch_id, commit_message, user_id, now
        )
        conn.commit()
        conn.execute("PRAGMA wal_checkpoint(PASSIVE)").fetchone()
        return {
            "status": "SUCCESS",
            "batch_id": batch_id,
            "version": version,
            "base_version": base_version,
            "changed_updates": changed_updates,
            "inserted_count": len(inserted_ids),
            "inserted_row_ids": inserted_ids,
            "deleted_count": deleted_count,
            "columns_added": new_columns,
            "columns_deleted": delete_columns,
            "risk_score": risk,
            "timestamp": now,
        }
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def get_audit_history(table_id: str, limit: int = 100) -> list[dict[str, Any]]:
    conn = _get_connection()
    try:
        rows = conn.execute(
            """
            SELECT * FROM AUDIT_COMMITS
            WHERE TABLE_ID=? ORDER BY VERSION DESC, CREATED_AT DESC LIMIT ?
            """,
            (table_id, max(1, min(limit, 1000))),
        ).fetchall()
        history = []
        for row in rows:
            item = {key.lower(): row[key] for key in row.keys()}
            item["old_value"] = json.loads(item["old_value"]) if item["old_value"] is not None else None
            item["new_value"] = json.loads(item["new_value"]) if item["new_value"] is not None else None
            history.append(item)
        return history
    finally:
        conn.close()


def rollback_batch(
    table_id: str, batch_id: str, user_id: str, user_email: str
) -> dict[str, Any]:
    conn = _get_connection()
    try:
        batch = conn.execute(
            "SELECT MIN(VERSION) AS VERSION FROM AUDIT_COMMITS WHERE TABLE_ID=? AND BATCH_ID=?",
            (table_id, batch_id),
        ).fetchone()
        if not batch or batch["VERSION"] is None:
            raise ValueError("Change set not found")
        target_version = max(0, int(batch["VERSION"]) - 1)
        stored = conn.execute(
            "SELECT SNAPSHOT_JSON FROM DATASET_VERSIONS WHERE TABLE_ID=? AND VERSION=?",
            (table_id, target_version),
        ).fetchone()
        if not stored:
            rows = conn.execute(
                """
                SELECT ROW_ID, COLUMN_NAME, OLD_VALUE FROM AUDIT_COMMITS
                WHERE TABLE_ID=? AND BATCH_ID=? ORDER BY CREATED_AT DESC
                """,
                (table_id, batch_id),
            ).fetchall()
            changes = [
                {
                    "row_id": row["ROW_ID"],
                    "column_name": row["COLUMN_NAME"],
                    "new_value": json.loads(row["OLD_VALUE"]) if row["OLD_VALUE"] is not None else None,
                }
                for row in rows
                if row["ROW_ID"] > 0 and validate_identifier(row["COLUMN_NAME"])
            ]
            if not changes:
                raise ValueError("This legacy change set cannot be restored automatically")
            conn.close()
            conn = None
            return apply_bulk_updates(
                table_id, changes, user_id, user_email, source="rollback",
                commit_message=f"Reverted change set {batch_id}",
            )

        snapshot = json.loads(stored[0])
        registry = conn.execute(
            "SELECT CURRENT_VERSION FROM DATASET_REGISTRY WHERE TABLE_ID=?",
            (table_id,),
        ).fetchone()
        new_version = int(registry[0]) + 1
        new_batch = f"CHG_{uuid.uuid4().hex[:12].upper()}"
        now = _utcnow()
        conn.execute("BEGIN IMMEDIATE")
        conn.execute(f'DROP TABLE "{table_id}"')
        definitions = []
        column_types = snapshot.get("column_types") or ["TEXT"] * len(snapshot["columns"])
        for index, column in enumerate(snapshot["columns"]):
            if column.upper() == "ROW_ID":
                definitions.append('"ROW_ID" INTEGER PRIMARY KEY AUTOINCREMENT')
            else:
                data_type = re.sub(r"[^A-Z0-9_ ()]", "", str(column_types[index]).upper()) or "TEXT"
                definitions.append(f'"{column}" {data_type}')
        conn.execute(f'CREATE TABLE "{table_id}" ({", ".join(definitions)})')
        if snapshot["rows"]:
            columns_sql = ", ".join(f'"{column}"' for column in snapshot["columns"])
            placeholders = ", ".join("?" for _ in snapshot["columns"])
            conn.executemany(
                f'INSERT INTO "{table_id}" ({columns_sql}) VALUES ({placeholders})',
                snapshot["rows"],
            )
        conn.execute(
            """
            INSERT INTO AUDIT_COMMITS
                (AUDIT_ID, BATCH_ID, VERSION, TABLE_ID, ROW_ID, COLUMN_NAME,
                 OLD_VALUE, NEW_VALUE, USER_ID, USER_EMAIL, SOURCE, STATUS,
                 COMMIT_MESSAGE, RISK_SCORE, CREATED_AT)
            VALUES (?, ?, ?, ?, 0, '__DATASET__', ?, ?, ?, ?, 'rollback',
                    'SNAPSHOT_RESTORED', ?, 100, ?)
            """,
            (
                f"AUD_{uuid.uuid4().hex[:16].upper()}", new_batch, new_version,
                table_id, json.dumps({"version": int(registry[0])}),
                json.dumps({"version": target_version}), user_id, user_email,
                f"Reverted change set {batch_id} to version {target_version}", now,
            ),
        )
        conn.execute(
            """
            UPDATE DATASET_REGISTRY SET CURRENT_VERSION=?, UPDATED_AT=?,
                ROW_COUNT=?, COLUMN_COUNT=? WHERE TABLE_ID=?
            """,
            (new_version, now, snapshot["total"], len(snapshot["columns"]) - 1, table_id),
        )
        _store_dataset_version(
            conn, table_id, new_version, new_batch,
            f"Reverted change set {batch_id}", user_id, now,
        )
        conn.commit()
        return {
            "status": "SUCCESS", "batch_id": new_batch, "version": new_version,
            "restored_version": target_version, "timestamp": now,
        }
    except Exception:
        if conn:
            conn.rollback()
        raise
    finally:
        try:
            conn.close()
        except Exception:
            pass


def get_kpis(user_id: str, table_id: str | None = None) -> dict[str, Any]:
    conn = _get_connection()
    try:
        if table_id:
            where = "WHERE A.TABLE_ID=?"
            params: tuple[Any, ...] = (table_id,)
        else:
            where = """
                WHERE A.TABLE_ID IN (
                    SELECT D.TABLE_ID FROM DATASET_REGISTRY D
                    WHERE D.OWNER_USER_ID IN (?, 'USR_SYSTEM') OR EXISTS (
                        SELECT 1 FROM DATASET_MEMBERS M
                        WHERE M.TABLE_ID=D.TABLE_ID AND M.USER_ID=?
                    )
                )
            """
            params = (user_id, user_id)
        summary = conn.execute(
            f"""
            SELECT COUNT(*) AS CELL_EVENTS,
                   COUNT(DISTINCT BATCH_ID) AS COMMITS,
                   COUNT(DISTINCT USER_ID) AS CONTRIBUTORS,
                   SUM(CASE WHEN STATUS IN
                       ('UPDATED', 'INSERTED', 'DELETED', 'COLUMN_ADDED',
                        'COLUMN_DELETED', 'SNAPSHOT_RESTORED')
                       THEN 1 ELSE 0 END) AS SUCCESSES,
                   SUM(CASE WHEN STATUS='NO_CHANGE' THEN 1 ELSE 0 END) AS NO_CHANGES,
                   AVG(RISK_SCORE) AS AVG_RISK,
                   MAX(RISK_SCORE) AS MAX_RISK
            FROM AUDIT_COMMITS A {where}
            """,
            params,
        ).fetchone()
        datasets = conn.execute(
            """
            SELECT COUNT(*) FROM DATASET_REGISTRY D
            WHERE D.OWNER_USER_ID IN (?, 'USR_SYSTEM') OR EXISTS (
                SELECT 1 FROM DATASET_MEMBERS M
                WHERE M.TABLE_ID=D.TABLE_ID AND M.USER_ID=?
            )
            """,
            (user_id, user_id),
        ).fetchone()[0]
        top_users = conn.execute(
            f"""
            SELECT USER_ID, USER_EMAIL, COUNT(DISTINCT BATCH_ID) AS COMMITS
            FROM AUDIT_COMMITS A {where}
            GROUP BY USER_ID, USER_EMAIL ORDER BY COMMITS DESC LIMIT 5
            """,
            params,
        ).fetchall()
        return {
            "datasets": datasets,
            "cell_events": summary["CELL_EVENTS"] or 0,
            "commits": summary["COMMITS"] or 0,
            "contributors": summary["CONTRIBUTORS"] or 0,
            "successes": summary["SUCCESSES"] or 0,
            "no_changes": summary["NO_CHANGES"] or 0,
            "avg_risk": round(summary["AVG_RISK"] or 0, 1),
            "max_risk": summary["MAX_RISK"] or 0,
            "top_contributors": [
                {"user_id": row[0], "email": row[1], "commits": row[2]}
                for row in top_users
            ],
        }
    finally:
        conn.close()
