"""
SQLite Database Manager — Dynamic Table Provisioning & CRUD Operations.

Uses Python's built-in sqlite3 module for zero-setup database access.
The database file (queue_board.db) is auto-created alongside the backend package.
"""

import sqlite3
import re
import os
from pathlib import Path
from typing import Any

import pandas as pd

# ---------------------------------------------------------------------------
# Database file location: <backend>/queue_board.db
# ---------------------------------------------------------------------------
_DB_DIR = Path(__file__).resolve().parent.parent  # backend/
DB_PATH = _DB_DIR / "queue_board.db"


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
