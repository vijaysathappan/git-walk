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
import hashlib
import hmac
from datetime import date, datetime, time, timezone
from pathlib import Path
from typing import Any

import pandas as pd

from .config import settings
from .domain import BranchPolicy, RepositoryPolicy, RepositoryRole
from .excel.identity import ensure_branch_identities, semantic_snapshot, stable_id

# ---------------------------------------------------------------------------
# Database file location: <backend>/queue_board.db
# ---------------------------------------------------------------------------
_DB_DIR = Path(__file__).resolve().parent.parent  # backend/
_configured_database = settings.database_url.removeprefix("sqlite:///")
DB_PATH = Path(_configured_database).expanduser() if _configured_database else _DB_DIR / "queue_board.db"


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
                ATTEMPTS INTEGER NOT NULL DEFAULT 0,
                MAX_ATTEMPTS INTEGER NOT NULL DEFAULT 5,
                CREATED_AT TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS AUTH_SESSIONS (
                SESSION_ID TEXT PRIMARY KEY,
                USER_ID TEXT NOT NULL,
                TOKEN_HASH TEXT NOT NULL,
                CREATED_AT TEXT NOT NULL,
                EXPIRES_AT TEXT NOT NULL,
                REVOKED_AT TEXT
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

            CREATE TABLE IF NOT EXISTS DATASET_INVITATIONS (
                INVITATION_ID TEXT PRIMARY KEY,
                TABLE_ID TEXT NOT NULL,
                EMAIL TEXT NOT NULL COLLATE NOCASE,
                ROLE TEXT NOT NULL CHECK (ROLE IN ('viewer', 'editor')),
                STATUS TEXT NOT NULL CHECK (STATUS IN ('pending', 'accepted', 'revoked')),
                INVITED_BY TEXT NOT NULL,
                CREATED_AT TEXT NOT NULL,
                UPDATED_AT TEXT NOT NULL,
                UNIQUE (TABLE_ID, EMAIL),
                FOREIGN KEY (TABLE_ID) REFERENCES DATASET_REGISTRY(TABLE_ID)
            );

            CREATE TABLE IF NOT EXISTS WORKSPACE_EVENTS (
                REVISION INTEGER PRIMARY KEY AUTOINCREMENT,
                TABLE_ID TEXT NOT NULL,
                EVENT_TYPE TEXT NOT NULL,
                ACTOR_USER_ID TEXT NOT NULL,
                PAYLOAD_JSON TEXT NOT NULL,
                CREATED_AT TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS CATEGORIES (
                CATEGORY_ID TEXT PRIMARY KEY, PARENT_CATEGORY_ID TEXT,
                NAME TEXT NOT NULL, DESCRIPTION TEXT, DISPLAY_ORDER INTEGER NOT NULL DEFAULT 0,
                STATUS TEXT NOT NULL DEFAULT 'ACTIVE', CREATED_AT TEXT NOT NULL, UPDATED_AT TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS WORKBOOK_REPOSITORIES (
                REPOSITORY_ID TEXT PRIMARY KEY, TABLE_ID TEXT NOT NULL UNIQUE,
                CATEGORY_ID TEXT NOT NULL, REPOSITORY_NAME TEXT NOT NULL, DESCRIPTION TEXT,
                DEFAULT_BRANCH_ID TEXT, CREATED_BY TEXT NOT NULL, CREATED_AT TEXT NOT NULL,
                UPDATED_AT TEXT NOT NULL, STATUS TEXT NOT NULL DEFAULT 'ACTIVE', MAIN_PROTECTED INTEGER NOT NULL DEFAULT 0,
                REPOSITORY_SLUG TEXT, VISIBILITY TEXT NOT NULL DEFAULT 'private', BUSINESS_OWNER TEXT,
                DATA_CLASSIFICATION TEXT NOT NULL DEFAULT 'internal', RETENTION_POLICY TEXT,
                UNIQUE(REPOSITORY_SLUG)
            );

            CREATE TABLE IF NOT EXISTS REPOSITORY_MEMBERS (
                REPOSITORY_ID TEXT NOT NULL,
                USER_ID TEXT NOT NULL,
                ROLE TEXT NOT NULL CHECK (ROLE IN ('owner', 'editor', 'viewer')),
                GRANTED_BY TEXT NOT NULL,
                CREATED_AT TEXT NOT NULL,
                UPDATED_AT TEXT NOT NULL,
                PRIMARY KEY (REPOSITORY_ID, USER_ID)
            );

            CREATE TABLE IF NOT EXISTS WORKBOOK_SHEETS (
                SHEET_ID TEXT PRIMARY KEY, REPOSITORY_ID TEXT NOT NULL, SHEET_NAME TEXT NOT NULL,
                SHEET_ORDER INTEGER NOT NULL, STATUS TEXT NOT NULL DEFAULT 'ACTIVE', CREATED_AT TEXT NOT NULL,
                UNIQUE(REPOSITORY_ID, SHEET_ID)
            );

            CREATE TABLE IF NOT EXISTS BRANCHES (
                BRANCH_ID TEXT PRIMARY KEY, REPOSITORY_ID TEXT NOT NULL, DATA_TABLE_ID TEXT NOT NULL UNIQUE,
                BRANCH_NAME TEXT NOT NULL, BRANCH_TYPE TEXT NOT NULL CHECK(BRANCH_TYPE IN ('MAIN','USER')),
                CREATED_BY TEXT NOT NULL, BASE_COMMIT_ID TEXT, HEAD_COMMIT_ID TEXT,
                STATUS TEXT NOT NULL DEFAULT 'ACTIVE', CREATED_AT TEXT NOT NULL, UPDATED_AT TEXT NOT NULL,
                MERGED_AT TEXT, ARCHIVED_AT TEXT, UNIQUE(REPOSITORY_ID, BRANCH_NAME)
            );

            CREATE TABLE IF NOT EXISTS WORKING_COPIES (
                WORKING_COPY_ID TEXT PRIMARY KEY, REPOSITORY_ID TEXT NOT NULL, BRANCH_ID TEXT NOT NULL,
                USER_ID TEXT NOT NULL, BASE_COMMIT_ID TEXT, GENERATED_AT TEXT NOT NULL, LAST_SEEN_AT TEXT NOT NULL,
                STATUS TEXT NOT NULL DEFAULT 'ACTIVE', WORKBOOK_FINGERPRINT TEXT NOT NULL,
                ISSUED_AT TEXT NOT NULL, SIGNATURE TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS SHEET_ROWS (
                BRANCH_ID TEXT NOT NULL,
                SHEET_ID TEXT NOT NULL,
                ROW_ID TEXT NOT NULL,
                PHYSICAL_ROW_ID INTEGER NOT NULL,
                ROW_POSITION INTEGER NOT NULL,
                STATUS TEXT NOT NULL DEFAULT 'ACTIVE',
                CREATED_AT TEXT NOT NULL,
                UPDATED_AT TEXT NOT NULL,
                PRIMARY KEY (BRANCH_ID, SHEET_ID, ROW_ID),
                UNIQUE (BRANCH_ID, SHEET_ID, PHYSICAL_ROW_ID)
            );

            CREATE TABLE IF NOT EXISTS BRANCH_SHEETS (
                BRANCH_ID TEXT NOT NULL,
                SHEET_ID TEXT NOT NULL,
                SHEET_NAME TEXT NOT NULL,
                SHEET_POSITION INTEGER NOT NULL,
                STATUS TEXT NOT NULL DEFAULT 'ACTIVE',
                CREATED_AT TEXT NOT NULL,
                UPDATED_AT TEXT NOT NULL,
                PRIMARY KEY (BRANCH_ID, SHEET_ID)
            );

            CREATE TABLE IF NOT EXISTS BRANCH_SHEET_TABLES (
                BRANCH_ID TEXT NOT NULL,
                SHEET_ID TEXT NOT NULL,
                DATA_TABLE_ID TEXT NOT NULL UNIQUE,
                IS_PRIMARY INTEGER NOT NULL DEFAULT 0,
                CREATED_AT TEXT NOT NULL,
                UPDATED_AT TEXT NOT NULL,
                PRIMARY KEY (BRANCH_ID, SHEET_ID)
            );

            CREATE TABLE IF NOT EXISTS SHEET_COLUMNS (
                BRANCH_ID TEXT NOT NULL,
                SHEET_ID TEXT NOT NULL,
                COLUMN_ID TEXT NOT NULL,
                COLUMN_NAME TEXT NOT NULL,
                COLUMN_POSITION INTEGER NOT NULL,
                DATA_TYPE TEXT NOT NULL DEFAULT 'TEXT',
                STATUS TEXT NOT NULL DEFAULT 'ACTIVE',
                CREATED_AT TEXT NOT NULL,
                UPDATED_AT TEXT NOT NULL,
                PRIMARY KEY (BRANCH_ID, SHEET_ID, COLUMN_ID)
            );

            CREATE TABLE IF NOT EXISTS CELL_METADATA (
                BRANCH_ID TEXT NOT NULL,
                SHEET_ID TEXT NOT NULL,
                ROW_ID TEXT NOT NULL,
                COLUMN_ID TEXT NOT NULL,
                FORMULA TEXT,
                STYLE_HASH TEXT,
                COMMENT_TEXT TEXT,
                UPDATED_AT TEXT NOT NULL,
                PRIMARY KEY (BRANCH_ID, SHEET_ID, ROW_ID, COLUMN_ID)
            );

            CREATE TABLE IF NOT EXISTS COMMITS (
                COMMIT_ID TEXT PRIMARY KEY,
                REPOSITORY_ID TEXT NOT NULL,
                BRANCH_ID TEXT NOT NULL,
                AUTHOR_USER_ID TEXT NOT NULL,
                AUTHOR_EMAIL TEXT NOT NULL,
                MESSAGE TEXT NOT NULL,
                CREATED_AT TEXT NOT NULL,
                CHANGE_COUNT INTEGER NOT NULL,
                COMMIT_HASH TEXT NOT NULL UNIQUE,
                STATUS TEXT NOT NULL DEFAULT 'COMMITTED',
                REVERTS_COMMIT_ID TEXT,
                DATASET_VERSION INTEGER
            );

            CREATE TABLE IF NOT EXISTS COMMIT_PARENTS (
                COMMIT_ID TEXT NOT NULL,
                PARENT_COMMIT_ID TEXT NOT NULL,
                PARENT_ORDER INTEGER NOT NULL,
                PRIMARY KEY (COMMIT_ID, PARENT_ORDER)
            );

            CREATE TABLE IF NOT EXISTS COMMIT_CHANGES (
                CHANGE_ID TEXT PRIMARY KEY,
                COMMIT_ID TEXT NOT NULL,
                REPOSITORY_ID TEXT NOT NULL,
                BRANCH_ID TEXT NOT NULL,
                SHEET_ID TEXT NOT NULL,
                OPERATION_TYPE TEXT NOT NULL,
                ROW_ID TEXT,
                COLUMN_ID TEXT,
                PREVIOUS_ROW_POSITION INTEGER,
                NEW_ROW_POSITION INTEGER,
                PREVIOUS_COLUMN_POSITION INTEGER,
                NEW_COLUMN_POSITION INTEGER,
                PREVIOUS_CELL_REFERENCE TEXT,
                NEW_CELL_REFERENCE TEXT,
                OLD_VALUE TEXT,
                NEW_VALUE TEXT,
                OLD_FORMULA TEXT,
                NEW_FORMULA TEXT,
                OLD_DATA_TYPE TEXT,
                NEW_DATA_TYPE TEXT,
                OLD_STYLE_HASH TEXT,
                NEW_STYLE_HASH TEXT,
                OLD_COMMENT TEXT,
                NEW_COMMENT TEXT,
                METADATA_JSON TEXT,
                CREATED_AT TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS BRANCH_CHECKPOINTS (
                CHECKPOINT_ID TEXT PRIMARY KEY,
                REPOSITORY_ID TEXT NOT NULL,
                BRANCH_ID TEXT NOT NULL,
                COMMIT_ID TEXT NOT NULL UNIQUE,
                SNAPSHOT_JSON TEXT NOT NULL,
                REASON TEXT NOT NULL,
                CREATED_AT TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS MERGE_REQUESTS (
                MERGE_REQUEST_ID TEXT PRIMARY KEY,
                REPOSITORY_ID TEXT NOT NULL,
                SOURCE_BRANCH_ID TEXT NOT NULL,
                TARGET_BRANCH_ID TEXT NOT NULL,
                SOURCE_HEAD_COMMIT_ID TEXT NOT NULL,
                TARGET_HEAD_COMMIT_ID TEXT NOT NULL,
                MERGE_BASE_COMMIT_ID TEXT NOT NULL,
                CREATED_BY TEXT NOT NULL,
                TITLE TEXT NOT NULL,
                DESCRIPTION TEXT,
                STATUS TEXT NOT NULL,
                CONFLICT_STATUS TEXT NOT NULL,
                VALIDATION_STATUS TEXT NOT NULL,
                CREATED_AT TEXT NOT NULL,
                UPDATED_AT TEXT NOT NULL,
                MERGED_AT TEXT,
                MERGED_BY TEXT,
                MERGE_COMMIT_ID TEXT
            );

            CREATE TABLE IF NOT EXISTS MERGE_CONFLICTS (
                CONFLICT_ID TEXT PRIMARY KEY,
                MERGE_REQUEST_ID TEXT NOT NULL,
                SHEET_ID TEXT,
                ROW_ID TEXT,
                COLUMN_ID TEXT,
                CONFLICT_TYPE TEXT NOT NULL,
                BASE_STATE TEXT,
                MAIN_STATE TEXT,
                BRANCH_STATE TEXT,
                RESOLUTION_TYPE TEXT,
                RESOLVED_STATE TEXT,
                RESOLVED_BY TEXT,
                RESOLVED_AT TEXT,
                STATUS TEXT NOT NULL DEFAULT 'OPEN',
                CREATED_AT TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS MERGE_REQUEST_REVIEWS (
                REVIEW_ID TEXT PRIMARY KEY,
                MERGE_REQUEST_ID TEXT NOT NULL,
                REVIEWER_USER_ID TEXT NOT NULL,
                DECISION TEXT NOT NULL,
                COMMENT_TEXT TEXT,
                CREATED_AT TEXT NOT NULL,
                UNIQUE(MERGE_REQUEST_ID, REVIEWER_USER_ID)
            );

            CREATE TABLE IF NOT EXISTS VALIDATION_RUNS (
                VALIDATION_RUN_ID TEXT PRIMARY KEY,
                MERGE_REQUEST_ID TEXT,
                REPOSITORY_ID TEXT NOT NULL,
                BRANCH_ID TEXT NOT NULL,
                COMMIT_ID TEXT,
                STATUS TEXT NOT NULL,
                ERROR_COUNT INTEGER NOT NULL DEFAULT 0,
                WARNING_COUNT INTEGER NOT NULL DEFAULT 0,
                STARTED_AT TEXT NOT NULL,
                COMPLETED_AT TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS VALIDATION_RESULTS (
                VALIDATION_RESULT_ID TEXT PRIMARY KEY,
                VALIDATION_RUN_ID TEXT NOT NULL,
                RULE_CODE TEXT NOT NULL,
                SEVERITY TEXT NOT NULL,
                STATUS TEXT NOT NULL,
                SHEET_ID TEXT,
                ROW_ID TEXT,
                COLUMN_ID TEXT,
                MESSAGE TEXT NOT NULL,
                DETAILS_JSON TEXT,
                CREATED_AT TEXT NOT NULL
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

            CREATE TABLE IF NOT EXISTS AUDIT_EVENTS (
                EVENT_ID TEXT PRIMARY KEY,
                CREATED_AT TEXT NOT NULL,
                ACTOR_USER_ID TEXT NOT NULL,
                ACTOR_TYPE TEXT NOT NULL CHECK(ACTOR_TYPE IN ('USER','SYSTEM','AI')),
                REPOSITORY_ID TEXT,
                BRANCH_ID TEXT,
                WORKING_COPY_ID TEXT,
                COMMIT_ID TEXT,
                MERGE_REQUEST_ID TEXT,
                EVENT_TYPE TEXT NOT NULL,
                EVENT_PAYLOAD TEXT NOT NULL,
                REQUEST_ID TEXT NOT NULL,
                TRACE_ID TEXT NOT NULL,
                STATUS TEXT NOT NULL,
                FAILURE_REASON TEXT,
                PREVIOUS_EVENT_HASH TEXT,
                EVENT_HASH TEXT NOT NULL UNIQUE
            );

            CREATE TABLE IF NOT EXISTS OPERATION_METRICS (
                METRIC_ID TEXT PRIMARY KEY,
                CREATED_AT TEXT NOT NULL,
                METRIC_NAME TEXT NOT NULL,
                METRIC_VALUE REAL NOT NULL,
                UNIT TEXT NOT NULL,
                STATUS TEXT NOT NULL,
                REQUEST_ID TEXT,
                TRACE_ID TEXT,
                USER_ID TEXT,
                REPOSITORY_ID TEXT,
                BRANCH_ID TEXT,
                TAGS_JSON TEXT NOT NULL DEFAULT '{}'
            );

            CREATE TABLE IF NOT EXISTS SECURITY_EVENTS (
                SECURITY_EVENT_ID TEXT PRIMARY KEY,
                CREATED_AT TEXT NOT NULL,
                EVENT_TYPE TEXT NOT NULL,
                SEVERITY TEXT NOT NULL,
                USER_ID TEXT,
                REQUEST_ID TEXT,
                TRACE_ID TEXT,
                CLIENT_IP TEXT,
                DETAILS_JSON TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS IDX_AUDIT_TABLE_VERSION
                ON AUDIT_COMMITS(TABLE_ID, VERSION DESC);
            CREATE INDEX IF NOT EXISTS IDX_AUDIT_BATCH
                ON AUDIT_COMMITS(BATCH_ID);
            CREATE INDEX IF NOT EXISTS IDX_AUDIT_USER
                ON AUDIT_COMMITS(USER_ID, CREATED_AT DESC);
            CREATE INDEX IF NOT EXISTS IDX_WORKSPACE_EVENT_TABLE
                ON WORKSPACE_EVENTS(TABLE_ID, REVISION DESC);
            CREATE INDEX IF NOT EXISTS IDX_COMMITS_BRANCH
                ON COMMITS(BRANCH_ID, CREATED_AT DESC);
            CREATE INDEX IF NOT EXISTS IDX_COMMIT_CHANGES_COMMIT
                ON COMMIT_CHANGES(COMMIT_ID, OPERATION_TYPE);
            CREATE INDEX IF NOT EXISTS IDX_COMMIT_CHANGES_CELL
                ON COMMIT_CHANGES(BRANCH_ID, SHEET_ID, ROW_ID, COLUMN_ID, CREATED_AT DESC);
            CREATE INDEX IF NOT EXISTS IDX_SHEET_ROWS_POSITION
                ON SHEET_ROWS(BRANCH_ID, SHEET_ID, ROW_POSITION);
            CREATE INDEX IF NOT EXISTS IDX_SHEET_COLUMNS_POSITION
                ON SHEET_COLUMNS(BRANCH_ID, SHEET_ID, COLUMN_POSITION);
            CREATE INDEX IF NOT EXISTS IDX_REPOSITORY_MEMBERS_USER
                ON REPOSITORY_MEMBERS(USER_ID, REPOSITORY_ID);
            CREATE INDEX IF NOT EXISTS IDX_BRANCH_SHEET_TABLES_BRANCH
                ON BRANCH_SHEET_TABLES(BRANCH_ID, IS_PRIMARY DESC);
            CREATE INDEX IF NOT EXISTS IDX_MERGE_REQUEST_REPOSITORY
                ON MERGE_REQUESTS(REPOSITORY_ID, CREATED_AT DESC);
            CREATE INDEX IF NOT EXISTS IDX_MERGE_CONFLICT_REQUEST
                ON MERGE_CONFLICTS(MERGE_REQUEST_ID, STATUS, CONFLICT_TYPE);
            CREATE INDEX IF NOT EXISTS IDX_VALIDATION_REQUEST
                ON VALIDATION_RUNS(MERGE_REQUEST_ID, STARTED_AT DESC);
            CREATE INDEX IF NOT EXISTS IDX_AUDIT_EVENTS_REPOSITORY
                ON AUDIT_EVENTS(REPOSITORY_ID, CREATED_AT DESC);
            CREATE INDEX IF NOT EXISTS IDX_AUDIT_EVENTS_ACTOR
                ON AUDIT_EVENTS(ACTOR_USER_ID, CREATED_AT DESC);
            CREATE INDEX IF NOT EXISTS IDX_AUDIT_EVENTS_TRACE
                ON AUDIT_EVENTS(TRACE_ID, CREATED_AT);
            CREATE INDEX IF NOT EXISTS IDX_OPERATION_METRICS_NAME
                ON OPERATION_METRICS(METRIC_NAME, CREATED_AT DESC);
            CREATE INDEX IF NOT EXISTS IDX_SECURITY_EVENTS_CREATED
                ON SECURITY_EVENTS(CREATED_AT DESC, SEVERITY);

            CREATE TRIGGER IF NOT EXISTS AUDIT_EVENTS_APPEND_ONLY_UPDATE
            BEFORE UPDATE ON AUDIT_EVENTS
            BEGIN
                SELECT RAISE(ABORT, 'AUDIT_EVENTS is append-only');
            END;
            CREATE TRIGGER IF NOT EXISTS AUDIT_EVENTS_APPEND_ONLY_DELETE
            BEFORE DELETE ON AUDIT_EVENTS
            BEGIN
                SELECT RAISE(ABORT, 'AUDIT_EVENTS is append-only');
            END;
            """
        )
        login_code_columns = {
            row["name"] for row in conn.execute("PRAGMA table_info('AUTH_LOGIN_CODES')")
        }
        if "ATTEMPTS" not in login_code_columns:
            conn.execute(
                "ALTER TABLE AUTH_LOGIN_CODES ADD COLUMN ATTEMPTS INTEGER NOT NULL DEFAULT 0"
            )
        if "MAX_ATTEMPTS" not in login_code_columns:
            conn.execute(
                "ALTER TABLE AUTH_LOGIN_CODES ADD COLUMN MAX_ATTEMPTS INTEGER NOT NULL DEFAULT 5"
            )
        user_columns = {
            row["name"] for row in conn.execute("PRAGMA table_info('APP_USERS')")
        }
        if "EMPLOYEE_ID" not in user_columns:
            conn.execute("ALTER TABLE APP_USERS ADD COLUMN EMPLOYEE_ID TEXT")
        repository_columns = {
            row["name"] for row in conn.execute("PRAGMA table_info('WORKBOOK_REPOSITORIES')")
        }
        repository_migrations = {
            "REPOSITORY_SLUG": "TEXT",
            "VISIBILITY": "TEXT NOT NULL DEFAULT 'private'",
            "BUSINESS_OWNER": "TEXT",
            "DATA_CLASSIFICATION": "TEXT NOT NULL DEFAULT 'internal'",
            "RETENTION_POLICY": "TEXT",
        }
        for column, definition in repository_migrations.items():
            if column not in repository_columns:
                conn.execute(
                    f"ALTER TABLE WORKBOOK_REPOSITORIES ADD COLUMN {column} {definition}"
                )
        now = _utcnow()
        conn.execute("INSERT OR IGNORE INTO CATEGORIES VALUES ('CAT_HOME', NULL, 'Home', 'All workbook repositories', 0, 'ACTIVE', ?, ?)", (now, now))
        conn.execute("INSERT OR IGNORE INTO CATEGORIES VALUES ('CAT_UNSORTED', 'CAT_HOME', 'Unsorted', 'New workbook repositories', 100, 'ACTIVE', ?, ?)", (now, now))
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
            repository_exists = conn.execute(
                "SELECT 1 FROM WORKBOOK_REPOSITORIES WHERE TABLE_ID=?", (table_id,)
            ).fetchone()
            if not repository_exists:
                registry = conn.execute(
                    "SELECT OWNER_USER_ID, ORIGINAL_FILENAME FROM DATASET_REGISTRY WHERE TABLE_ID=?",
                    (table_id,),
                ).fetchone()
                repository_id = f"REP_{uuid.uuid4().hex[:12].upper()}"
                main_branch_id = f"BR_{uuid.uuid4().hex[:12].upper()}"
                root_commit = f"CMT_{uuid.uuid4().hex[:12].upper()}"
                filename = registry["ORIGINAL_FILENAME"] or table_id
                conn.execute(
                    """
                    INSERT INTO WORKBOOK_REPOSITORIES
                        (REPOSITORY_ID, TABLE_ID, CATEGORY_ID, REPOSITORY_NAME,
                         DESCRIPTION, DEFAULT_BRANCH_ID, CREATED_BY, CREATED_AT,
                         UPDATED_AT, STATUS, MAIN_PROTECTED)
                    VALUES (?, ?, 'CAT_UNSORTED', ?, ?, ?, ?, ?, ?, 'ACTIVE', 0)
                    """,
                    (
                        repository_id, table_id, Path(filename).stem,
                        f"Migrated repository for {filename}", main_branch_id,
                        registry["OWNER_USER_ID"], now, now,
                    ),
                )
                conn.execute(
                    """
                    INSERT INTO BRANCHES
                        (BRANCH_ID, REPOSITORY_ID, DATA_TABLE_ID, BRANCH_NAME,
                         BRANCH_TYPE, CREATED_BY, BASE_COMMIT_ID, HEAD_COMMIT_ID,
                         STATUS, CREATED_AT, UPDATED_AT)
                    VALUES (?, ?, ?, 'main', 'MAIN', ?, ?, ?, 'ACTIVE', ?, ?)
                    """,
                    (
                        main_branch_id, repository_id, table_id,
                        registry["OWNER_USER_ID"], root_commit, root_commit, now, now,
                    ),
                )
                conn.execute(
                    """
                    INSERT INTO WORKBOOK_SHEETS
                        (SHEET_ID, REPOSITORY_ID, SHEET_NAME, SHEET_ORDER, STATUS, CREATED_AT)
                    VALUES (?, ?, 'Sheet1', 0, 'ACTIVE', ?)
                    """,
                    (f"SHEET_{uuid.uuid4().hex[:12].upper()}", repository_id, now),
                )
        semantic_branches = conn.execute(
            """
            SELECT B.*, R.DEFAULT_BRANCH_ID
            FROM BRANCHES B JOIN WORKBOOK_REPOSITORIES R ON R.REPOSITORY_ID=B.REPOSITORY_ID
            WHERE B.STATUS='ACTIVE'
            ORDER BY CASE B.BRANCH_TYPE WHEN 'MAIN' THEN 0 ELSE 1 END
            """
        ).fetchall()
        for branch in semantic_branches:
            conn.execute(
                """
                INSERT INTO REPOSITORY_MEMBERS
                    (REPOSITORY_ID, USER_ID, ROLE, GRANTED_BY, CREATED_AT, UPDATED_AT)
                SELECT R.REPOSITORY_ID, R.CREATED_BY, 'owner', R.CREATED_BY, R.CREATED_AT, ?
                FROM WORKBOOK_REPOSITORIES R WHERE R.REPOSITORY_ID=?
                ON CONFLICT(REPOSITORY_ID, USER_ID) DO UPDATE SET ROLE='owner', UPDATED_AT=excluded.UPDATED_AT
                """,
                (now, branch["REPOSITORY_ID"]),
            )
            source_branch_id = (
                branch["DEFAULT_BRANCH_ID"]
                if branch["BRANCH_TYPE"] == "USER" else None
            )
            ensure_branch_identities(
                conn,
                branch["BRANCH_ID"],
                branch["REPOSITORY_ID"],
                branch["DATA_TABLE_ID"],
                source_branch_id=source_branch_id,
            )
            _ensure_stage2_commit_foundation(conn, branch, now)
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


def _ensure_stage2_commit_foundation(
    conn: sqlite3.Connection, branch: sqlite3.Row, now: str
) -> None:
    """Backfill a first-class checkpoint commit for pre-Stage-2 branch state."""
    head_commit_id = branch["HEAD_COMMIT_ID"] or stable_id("CMT")
    if not branch["HEAD_COMMIT_ID"]:
        conn.execute(
            "UPDATE BRANCHES SET HEAD_COMMIT_ID=?, BASE_COMMIT_ID=COALESCE(BASE_COMMIT_ID, ?) WHERE BRANCH_ID=?",
            (head_commit_id, head_commit_id, branch["BRANCH_ID"]),
        )
    existing = conn.execute(
        "SELECT 1 FROM COMMITS WHERE COMMIT_ID=?", (head_commit_id,)
    ).fetchone()
    if existing:
        return
    author = conn.execute(
        "SELECT EMAIL FROM APP_USERS WHERE USER_ID=?", (branch["CREATED_BY"],)
    ).fetchone()
    snapshot = semantic_snapshot(conn, branch["DATA_TABLE_ID"])
    snapshot["head_commit_id"] = head_commit_id
    snapshot_json = json.dumps(snapshot, default=str, separators=(",", ":"))
    commit_hash = hashlib.sha256(
        f"{branch['REPOSITORY_ID']}:{branch['BRANCH_ID']}:{head_commit_id}:{snapshot_json}".encode()
    ).hexdigest()
    conn.execute(
        """
        INSERT INTO COMMITS
            (COMMIT_ID, REPOSITORY_ID, BRANCH_ID, AUTHOR_USER_ID, AUTHOR_EMAIL,
             MESSAGE, CREATED_AT, CHANGE_COUNT, COMMIT_HASH, STATUS, DATASET_VERSION)
        VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, 'CHECKPOINT',
                (SELECT CURRENT_VERSION FROM DATASET_REGISTRY WHERE TABLE_ID=?))
        """,
        (
            head_commit_id, branch["REPOSITORY_ID"], branch["BRANCH_ID"],
            branch["CREATED_BY"], author[0] if author else "system@local",
            "Stage 2 baseline checkpoint", now, commit_hash, branch["DATA_TABLE_ID"],
        ),
    )
    conn.execute(
        """
        INSERT INTO BRANCH_CHECKPOINTS
            (CHECKPOINT_ID, REPOSITORY_ID, BRANCH_ID, COMMIT_ID,
             SNAPSHOT_JSON, REASON, CREATED_AT)
        VALUES (?, ?, ?, ?, ?, 'STAGE2_BASELINE', ?)
        """,
        (
            stable_id("CP"), branch["REPOSITORY_ID"], branch["BRANCH_ID"],
            head_commit_id, snapshot_json, now,
        ),
    )


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


def _sqlite_scalar(value: Any) -> Any:
    """Convert pandas/Excel scalar types to values accepted by sqlite3."""
    if pd.isna(value):
        return None
    if isinstance(value, pd.Timestamp):
        return value.isoformat(sep=" ")
    if isinstance(value, pd.Timedelta):
        return str(value)

    item = getattr(value, "item", None)
    if callable(item):
        value = item()

    if isinstance(value, datetime):
        return value.isoformat(sep=" ")
    if isinstance(value, (date, time)):
        return value.isoformat()
    if isinstance(value, (str, int, float, bytes)):
        return value
    return str(value)


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
        rows.append(tuple(_sqlite_scalar(value) for value in row))

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
        normalized = email.lower()
        now = datetime.now(timezone.utc)
        recent = conn.execute(
            "SELECT CREATED_AT FROM AUTH_LOGIN_CODES WHERE EMAIL=? ORDER BY ID DESC LIMIT 1",
            (normalized,),
        ).fetchone()
        if recent:
            created = datetime.fromisoformat(recent[0])
            if (now - created).total_seconds() < settings.otp_request_cooldown_seconds:
                raise PermissionError("Please wait before requesting another sign-in code")
        window_start = (now.timestamp() - 3600)
        requests_last_hour = 0
        for row in conn.execute(
            "SELECT CREATED_AT FROM AUTH_LOGIN_CODES WHERE EMAIL=? ORDER BY ID DESC LIMIT 20",
            (normalized,),
        ).fetchall():
            if datetime.fromisoformat(row[0]).timestamp() >= window_start:
                requests_last_hour += 1
        if requests_last_hour >= settings.otp_requests_per_hour:
            raise PermissionError("Too many sign-in codes requested. Try again later")
        conn.execute(
            "UPDATE AUTH_LOGIN_CODES SET USED_AT=? WHERE EMAIL=? AND USED_AT IS NULL",
            (_utcnow(), normalized),
        )
        conn.execute(
            """
            INSERT INTO AUTH_LOGIN_CODES (EMAIL, CODE_HASH, EXPIRES_AT, CREATED_AT)
            VALUES (?, ?, ?, ?)
            """,
            (normalized, code_hash, expires_at, _utcnow()),
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
            SELECT ID, CODE_HASH, ATTEMPTS, MAX_ATTEMPTS FROM AUTH_LOGIN_CODES
            WHERE EMAIL=? AND USED_AT IS NULL AND EXPIRES_AT>?
            ORDER BY ID DESC LIMIT 1
            """,
            (email.lower(), _utcnow()),
        ).fetchone()
        if not row:
            conn.rollback()
            return False
        if not hmac.compare_digest(row["CODE_HASH"], code_hash):
            attempts = int(row["ATTEMPTS"]) + 1
            used_at = _utcnow() if attempts >= int(row["MAX_ATTEMPTS"]) else None
            conn.execute(
                "UPDATE AUTH_LOGIN_CODES SET ATTEMPTS=?, USED_AT=COALESCE(?, USED_AT) WHERE ID=?",
                (attempts, used_at, row["ID"]),
            )
            conn.commit()
            return False
        conn.execute("UPDATE AUTH_LOGIN_CODES SET USED_AT=? WHERE ID=?", (_utcnow(), row[0]))
        conn.commit()
        return True
    finally:
        conn.close()


def create_auth_session(
    session_id: str, user_id: str, token_hash: str, expires_at: str
) -> None:
    conn = _get_connection()
    try:
        conn.execute(
            """
            INSERT INTO AUTH_SESSIONS
                (SESSION_ID, USER_ID, TOKEN_HASH, CREATED_AT, EXPIRES_AT)
            VALUES (?, ?, ?, ?, ?)
            """,
            (session_id, user_id, token_hash, _utcnow(), expires_at),
        )
        conn.commit()
    finally:
        conn.close()


def auth_session_is_active(
    session_id: str, user_id: str, token_hash: str
) -> bool:
    conn = _get_connection()
    try:
        row = conn.execute(
            """
            SELECT TOKEN_HASH FROM AUTH_SESSIONS
            WHERE SESSION_ID=? AND USER_ID=? AND REVOKED_AT IS NULL AND EXPIRES_AT>?
            """,
            (session_id, user_id, _utcnow()),
        ).fetchone()
        return bool(row and hmac.compare_digest(row[0], token_hash))
    finally:
        conn.close()


def revoke_auth_session(session_id: str, user_id: str) -> None:
    conn = _get_connection()
    try:
        conn.execute(
            "UPDATE AUTH_SESSIONS SET REVOKED_AT=? WHERE SESSION_ID=? AND USER_ID=?",
            (_utcnow(), session_id, user_id),
        )
        conn.commit()
    finally:
        conn.close()


def _workspace_event(
    conn: sqlite3.Connection, table_id: str, event_type: str,
    actor_user_id: str, payload: dict[str, Any]
) -> None:
    conn.execute(
        "INSERT INTO WORKSPACE_EVENTS (TABLE_ID, EVENT_TYPE, ACTOR_USER_ID, PAYLOAD_JSON, CREATED_AT) VALUES (?, ?, ?, ?, ?)",
        (table_id, event_type, actor_user_id, json.dumps(payload), _utcnow()),
    )


def _accept_pending_invitations(
    conn: sqlite3.Connection, user_id: str, email: str, now: str
) -> None:
    invitations = conn.execute(
        "SELECT TABLE_ID, ROLE FROM DATASET_INVITATIONS WHERE EMAIL=? COLLATE NOCASE AND STATUS='pending'",
        (email,),
    ).fetchall()
    for invitation in invitations:
        conn.execute(
            "INSERT INTO DATASET_MEMBERS (TABLE_ID, USER_ID, ROLE, ADDED_AT) VALUES (?, ?, ?, ?) ON CONFLICT(TABLE_ID, USER_ID) DO UPDATE SET ROLE=excluded.ROLE",
            (invitation["TABLE_ID"], user_id, invitation["ROLE"], now),
        )
        repository = conn.execute(
            "SELECT REPOSITORY_ID, CREATED_BY FROM WORKBOOK_REPOSITORIES WHERE TABLE_ID=?",
            (invitation["TABLE_ID"],),
        ).fetchone()
        if repository:
            conn.execute(
                """
                INSERT INTO REPOSITORY_MEMBERS
                    (REPOSITORY_ID, USER_ID, ROLE, GRANTED_BY, CREATED_AT, UPDATED_AT)
                VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(REPOSITORY_ID, USER_ID) DO UPDATE SET
                    ROLE=excluded.ROLE, UPDATED_AT=excluded.UPDATED_AT
                """,
                (
                    repository["REPOSITORY_ID"], user_id, invitation["ROLE"],
                    repository["CREATED_BY"], now, now,
                ),
            )
        conn.execute(
            "UPDATE DATASET_INVITATIONS SET STATUS='accepted', UPDATED_AT=? WHERE TABLE_ID=? AND EMAIL=? COLLATE NOCASE",
            (now, invitation["TABLE_ID"], email),
        )
        _workspace_event(conn, invitation["TABLE_ID"], "INVITATION_ACCEPTED", user_id, {"email": email, "role": invitation["ROLE"]})


def get_or_create_user(email: str) -> dict[str, Any]:
    normalized = email.strip().lower()
    conn = _get_connection()
    try:
        now = _utcnow()
        row = conn.execute("SELECT * FROM APP_USERS WHERE EMAIL=?", (normalized,)).fetchone()
        if row:
            conn.execute("UPDATE APP_USERS SET LAST_LOGIN_AT=? WHERE USER_ID=?", (now, row["USER_ID"]))
            _accept_pending_invitations(conn, row["USER_ID"], normalized, now)
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
        _accept_pending_invitations(conn, user_id, normalized, now)
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


def resolve_repository_owner(email: str, employee_id: str | None = None) -> dict[str, Any]:
    """Resolve or provision a delegated repository owner identity."""
    user = get_or_create_user(email)
    normalized_employee_id = (employee_id or "").strip()[:80] or None
    if normalized_employee_id:
        conn = _get_connection()
        try:
            conn.execute(
                "UPDATE APP_USERS SET EMPLOYEE_ID=? WHERE USER_ID=?",
                (normalized_employee_id, user["user_id"]),
            )
            conn.commit()
        finally:
            conn.close()
        user["employee_id"] = normalized_employee_id
    return user


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
    sheet_names: list[str] | None = None,
    category_id: str = "CAT_UNSORTED",
    repository_name: str | None = None,
    description: str | None = None,
    visibility: str = "private",
    business_owner: str | None = None,
    data_classification: str = "internal",
    retention_policy: str | None = None,
    sheet_tables: list[dict[str, str]] | None = None,
) -> dict[str, str]:
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
        existing = conn.execute(
            "SELECT REPOSITORY_ID, DEFAULT_BRANCH_ID FROM WORKBOOK_REPOSITORIES WHERE TABLE_ID=?",
            (table_id,),
        ).fetchone()
        if existing:
            conn.execute(
                "UPDATE WORKBOOK_REPOSITORIES SET CREATED_BY=?, UPDATED_AT=? WHERE REPOSITORY_ID=?",
                (owner_user_id, now, existing["REPOSITORY_ID"]),
            )
            conn.execute(
                """
                INSERT INTO REPOSITORY_MEMBERS
                    (REPOSITORY_ID, USER_ID, ROLE, GRANTED_BY, CREATED_AT, UPDATED_AT)
                VALUES (?, ?, 'owner', ?, ?, ?)
                ON CONFLICT(REPOSITORY_ID, USER_ID) DO UPDATE SET ROLE='owner', UPDATED_AT=excluded.UPDATED_AT
                """,
                (existing["REPOSITORY_ID"], owner_user_id, owner_user_id, now, now),
            )
            conn.commit()
            return {
                "repository_id": existing["REPOSITORY_ID"],
                "main_branch_id": existing["DEFAULT_BRANCH_ID"],
            }

        repository_id = f"REP_{uuid.uuid4().hex[:12].upper()}"
        main_branch_id = f"BR_{uuid.uuid4().hex[:12].upper()}"
        root_commit = f"CMT_{uuid.uuid4().hex[:12].upper()}"
        category = conn.execute(
            "SELECT 1 FROM CATEGORIES WHERE CATEGORY_ID=? AND STATUS='ACTIVE'",
            (category_id,),
        ).fetchone()
        if not category:
            category_id = "CAT_UNSORTED"
        normalized_name = (repository_name or Path(filename).stem).strip()[:120]
        if not normalized_name:
            raise ValueError("Repository name is required")
        slug_base = re.sub(r"[^a-z0-9]+", "-", normalized_name.lower()).strip("-") or "repository"
        slug = slug_base
        suffix = 2
        while conn.execute(
            "SELECT 1 FROM WORKBOOK_REPOSITORIES WHERE REPOSITORY_SLUG=?", (slug,)
        ).fetchone():
            slug = f"{slug_base}-{suffix}"
            suffix += 1
        normalized_visibility = visibility if visibility in {"private", "internal"} else "private"
        normalized_classification = (
            data_classification if data_classification in {"public", "internal", "confidential", "restricted"}
            else "internal"
        )
        conn.execute(
            """
            INSERT OR IGNORE INTO WORKBOOK_REPOSITORIES
                (REPOSITORY_ID, TABLE_ID, CATEGORY_ID, REPOSITORY_NAME, DESCRIPTION,
                 DEFAULT_BRANCH_ID, CREATED_BY, CREATED_AT, UPDATED_AT, STATUS, MAIN_PROTECTED,
                 REPOSITORY_SLUG, VISIBILITY, BUSINESS_OWNER, DATA_CLASSIFICATION, RETENTION_POLICY)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', 0, ?, ?, ?, ?, ?)
            """,
            (
                repository_id, table_id, category_id, normalized_name,
                description or f"Repository for {filename}", main_branch_id,
                owner_user_id, now, now, slug, normalized_visibility,
                business_owner, normalized_classification, retention_policy,
            ),
        )
        conn.execute(
            """
            INSERT INTO REPOSITORY_MEMBERS
                (REPOSITORY_ID, USER_ID, ROLE, GRANTED_BY, CREATED_AT, UPDATED_AT)
            VALUES (?, ?, 'owner', ?, ?, ?)
            """,
            (repository_id, owner_user_id, owner_user_id, now, now),
        )
        conn.execute(
            """
            INSERT OR IGNORE INTO BRANCHES
                (BRANCH_ID, REPOSITORY_ID, DATA_TABLE_ID, BRANCH_NAME, BRANCH_TYPE,
                 CREATED_BY, BASE_COMMIT_ID, HEAD_COMMIT_ID, STATUS, CREATED_AT, UPDATED_AT)
            VALUES (?, ?, ?, 'main', 'MAIN', ?, ?, ?, 'ACTIVE', ?, ?)
            """,
            (main_branch_id, repository_id, table_id, owner_user_id, root_commit, root_commit, now, now),
        )
        configured_sheets = sheet_tables or [
            {"name": name, "table_id": table_id if index == 0 else ""}
            for index, name in enumerate(sheet_names or ["Sheet1"])
        ]
        for sheet_order, sheet_config in enumerate(configured_sheets):
            sheet_name = str(sheet_config.get("name") or f"Sheet{sheet_order + 1}")[:255]
            physical_table = str(sheet_config.get("table_id") or "")
            if not physical_table:
                physical_table = f"SHEET_DATA_{uuid.uuid4().hex[:12].upper()}"
                conn.execute(
                    f'CREATE TABLE "{physical_table}" (ROW_ID INTEGER PRIMARY KEY AUTOINCREMENT)'
                )
            sheet_id = f"SHEET_{uuid.uuid4().hex[:12].upper()}"
            conn.execute(
                """
                INSERT INTO WORKBOOK_SHEETS
                    (SHEET_ID, REPOSITORY_ID, SHEET_NAME, SHEET_ORDER, STATUS, CREATED_AT)
                VALUES (?, ?, ?, ?, 'ACTIVE', ?)
                """,
                (
                    sheet_id, repository_id, sheet_name, sheet_order, now,
                ),
            )
            conn.execute(
                """
                INSERT INTO BRANCH_SHEET_TABLES
                    (BRANCH_ID, SHEET_ID, DATA_TABLE_ID, IS_PRIMARY, CREATED_AT, UPDATED_AT)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (main_branch_id, sheet_id, physical_table, int(sheet_order == 0), now, now),
            )
            if physical_table != table_id:
                physical_rows = conn.execute(
                    f'SELECT COUNT(*) FROM "{physical_table}"'
                ).fetchone()[0]
                physical_columns = len(
                    conn.execute(f'PRAGMA table_info("{physical_table}")').fetchall()
                ) - 1
                conn.execute(
                    """
                    INSERT OR REPLACE INTO DATASET_REGISTRY
                        (TABLE_ID, OWNER_USER_ID, ORIGINAL_FILENAME, ROW_COUNT,
                         COLUMN_COUNT, CREATED_AT, UPDATED_AT, CURRENT_VERSION)
                    VALUES (?, ?, ?, ?, ?, ?, ?, 0)
                    """,
                    (
                        physical_table, owner_user_id, f"{filename}#{sheet_name}",
                        physical_rows, physical_columns, now, now,
                    ),
                )
        main_branch = conn.execute(
            "SELECT * FROM BRANCHES WHERE BRANCH_ID=?", (main_branch_id,)
        ).fetchone()
        ensure_branch_identities(
            conn, main_branch_id, repository_id, table_id
        )
        _ensure_stage2_commit_foundation(conn, main_branch, now)
        conn.commit()
        return {"repository_id": repository_id, "main_branch_id": main_branch_id}
    finally:
        conn.close()


def store_initial_formula_metadata(
    table_id: str, formulas_by_sheet: dict[str, list[dict[str, Any]]]
) -> None:
    """Attach uploaded formulas to stable cells after repository identities exist."""
    if not formulas_by_sheet:
        return
    conn = _get_connection()
    try:
        repository = conn.execute(
            "SELECT REPOSITORY_ID, DEFAULT_BRANCH_ID FROM WORKBOOK_REPOSITORIES WHERE TABLE_ID=?",
            (table_id,),
        ).fetchone()
        if not repository:
            raise ValueError("Repository does not exist")
        branch = conn.execute(
            "SELECT DATA_TABLE_ID FROM BRANCHES WHERE BRANCH_ID=?",
            (repository["DEFAULT_BRANCH_ID"],),
        ).fetchone()
        ensure_branch_identities(
            conn, repository["DEFAULT_BRANCH_ID"], repository["REPOSITORY_ID"], branch[0]
        )
        now = _utcnow()
        for sheet_name, formulas in formulas_by_sheet.items():
            sheet = conn.execute(
                """
                SELECT SHEET_ID FROM BRANCH_SHEETS
                WHERE BRANCH_ID=? AND SHEET_NAME=? COLLATE NOCASE AND STATUS='ACTIVE'
                """,
                (repository["DEFAULT_BRANCH_ID"], sheet_name),
            ).fetchone()
            if not sheet:
                continue
            for formula in formulas:
                row = conn.execute(
                    """
                    SELECT ROW_ID FROM SHEET_ROWS
                    WHERE BRANCH_ID=? AND SHEET_ID=? AND ROW_POSITION=? AND STATUS='ACTIVE'
                    """,
                    (repository["DEFAULT_BRANCH_ID"], sheet[0], formula["row_position"]),
                ).fetchone()
                column = conn.execute(
                    """
                    SELECT COLUMN_ID FROM SHEET_COLUMNS
                    WHERE BRANCH_ID=? AND SHEET_ID=? AND COLUMN_POSITION=? AND STATUS='ACTIVE'
                    """,
                    (repository["DEFAULT_BRANCH_ID"], sheet[0], formula["column_position"]),
                ).fetchone()
                if not row or not column:
                    continue
                conn.execute(
                    """
                    INSERT INTO CELL_METADATA
                        (BRANCH_ID, SHEET_ID, ROW_ID, COLUMN_ID, FORMULA,
                         STYLE_HASH, COMMENT_TEXT, UPDATED_AT)
                    VALUES (?, ?, ?, ?, ?, NULL, NULL, ?)
                    ON CONFLICT(BRANCH_ID,SHEET_ID,ROW_ID,COLUMN_ID) DO UPDATE SET
                        FORMULA=excluded.FORMULA, UPDATED_AT=excluded.UPDATED_AT
                    """,
                    (
                        repository["DEFAULT_BRANCH_ID"], sheet[0], row[0], column[0],
                        formula["formula"], now,
                    ),
                )
        head = conn.execute(
            "SELECT HEAD_COMMIT_ID FROM BRANCHES WHERE BRANCH_ID=?",
            (repository["DEFAULT_BRANCH_ID"],),
        ).fetchone()[0]
        snapshot = semantic_snapshot(conn, table_id)
        snapshot["head_commit_id"] = head
        conn.execute(
            """
            UPDATE BRANCH_CHECKPOINTS SET SNAPSHOT_JSON=?
            WHERE BRANCH_ID=? AND COMMIT_ID=?
            """,
            (json.dumps(snapshot, default=str, separators=(",", ":")), repository["DEFAULT_BRANCH_ID"], head),
        )
        conn.commit()
    finally:
        conn.close()


def _clone_table(conn: sqlite3.Connection, source_table: str, destination_table: str) -> None:
    ddl_row = conn.execute(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name=?", (source_table,)
    ).fetchone()
    if not ddl_row or not ddl_row[0]:
        raise ValueError(f"Source sheet data table {source_table} does not exist")
    ddl = re.sub(
        r"^(CREATE\s+TABLE\s+)(?:IF\s+NOT\s+EXISTS\s+)?(?:\"[^\"]+\"|\[[^\]]+\]|`[^`]+`|\S+)",
        rf'\1"{destination_table}"', ddl_row[0], count=1, flags=re.IGNORECASE,
    )
    conn.execute(ddl)
    conn.execute(f'INSERT INTO "{destination_table}" SELECT * FROM "{source_table}"')


def create_working_copy(
    table_id: str, user_id: str, user_email: str, branch_mode: str = "continue",
    branch_id: str | None = None,
) -> dict[str, Any]:
    """Create or reuse an isolated personal branch and issue signed workbook identity."""
    if branch_mode not in {"continue", "new"}:
        raise ValueError("Working copy mode must be continue or new")
    conn = _get_connection()
    try:
        repo = conn.execute(
            "SELECT * FROM WORKBOOK_REPOSITORIES WHERE TABLE_ID=? AND STATUS='ACTIVE'", (table_id,)
        ).fetchone()
        if not repo:
            raise ValueError("Workbook repository does not exist")
        slug = re.sub(r"[^a-z0-9]+", "-", user_email.split("@", 1)[0].lower()).strip("-") or "user"
        branch_name_base = f"users/{slug}/{repo['REPOSITORY_NAME'].lower().replace(' ', '-')}"
        branch_name = branch_name_base
        branch = None
        if branch_mode == "continue":
            if branch_id:
                branch = conn.execute(
                    """
                    SELECT * FROM BRANCHES WHERE BRANCH_ID=? AND REPOSITORY_ID=?
                      AND CREATED_BY=? AND BRANCH_TYPE='USER' AND STATUS='ACTIVE'
                    """,
                    (branch_id, repo["REPOSITORY_ID"], user_id),
                ).fetchone()
                if not branch:
                    raise ValueError("The selected personal branch is not active")
            else:
                branch = conn.execute(
                    "SELECT * FROM BRANCHES WHERE REPOSITORY_ID=? AND BRANCH_NAME=? AND STATUS='ACTIVE'",
                    (repo["REPOSITORY_ID"], branch_name),
                ).fetchone()
        now = _utcnow()
        if not branch:
            suffix = 2
            while conn.execute(
                "SELECT 1 FROM BRANCHES WHERE REPOSITORY_ID=? AND BRANCH_NAME=?",
                (repo["REPOSITORY_ID"], branch_name),
            ).fetchone():
                branch_name = f"{branch_name_base}-{suffix}"
                suffix += 1
            branch_id = f"BR_{uuid.uuid4().hex[:12].upper()}"
            main = conn.execute(
                "SELECT * FROM BRANCHES WHERE BRANCH_ID=?", (repo["DEFAULT_BRANCH_ID"],)
            ).fetchone()
            ensure_branch_identities(
                conn, main["BRANCH_ID"], repo["REPOSITORY_ID"], main["DATA_TABLE_ID"]
            )
            source_mappings = conn.execute(
                """
                SELECT T.SHEET_ID, T.DATA_TABLE_ID, T.IS_PRIMARY
                FROM BRANCH_SHEET_TABLES T JOIN BRANCH_SHEETS S
                  ON S.BRANCH_ID=T.BRANCH_ID AND S.SHEET_ID=T.SHEET_ID
                WHERE T.BRANCH_ID=? AND S.STATUS='ACTIVE'
                ORDER BY S.SHEET_POSITION
                """,
                (main["BRANCH_ID"],),
            ).fetchall()
            cloned_mappings = []
            for source in source_mappings:
                destination = (
                    f"BRANCH_DATA_{uuid.uuid4().hex[:12].upper()}"
                    if source["IS_PRIMARY"] else f"BRANCH_SHEET_{uuid.uuid4().hex[:12].upper()}"
                )
                _clone_table(conn, source["DATA_TABLE_ID"], destination)
                row_count = conn.execute(f'SELECT COUNT(*) FROM "{destination}"').fetchone()[0]
                column_count = len(conn.execute(f'PRAGMA table_info("{destination}")').fetchall()) - 1
                conn.execute(
                    "INSERT INTO DATASET_REGISTRY VALUES (?, ?, ?, ?, ?, ?, ?, 0)",
                    (destination, user_id, f"branch:{branch_name}", row_count, column_count, now, now),
                )
                _store_dataset_version(
                    conn, destination, 0, None, "Personal branch checkout", user_id, now
                )
                cloned_mappings.append((source["SHEET_ID"], destination, source["IS_PRIMARY"]))
            branch_table = next(
                mapping[1] for mapping in cloned_mappings if mapping[2]
            )
            conn.execute(
                """
                INSERT INTO BRANCHES (BRANCH_ID, REPOSITORY_ID, DATA_TABLE_ID, BRANCH_NAME,
                    BRANCH_TYPE, CREATED_BY, BASE_COMMIT_ID, HEAD_COMMIT_ID, STATUS, CREATED_AT, UPDATED_AT)
                VALUES (?, ?, ?, ?, 'USER', ?, ?, ?, 'ACTIVE', ?, ?)
                """,
                (branch_id, repo["REPOSITORY_ID"], branch_table, branch_name, user_id, main["HEAD_COMMIT_ID"], main["HEAD_COMMIT_ID"], now, now),
            )
            for sheet_id, mapped_table, is_primary in cloned_mappings:
                conn.execute(
                    """
                    INSERT INTO BRANCH_SHEET_TABLES
                        (BRANCH_ID, SHEET_ID, DATA_TABLE_ID, IS_PRIMARY, CREATED_AT, UPDATED_AT)
                    VALUES (?, ?, ?, ?, ?, ?)
                    """,
                    (branch_id, sheet_id, mapped_table, is_primary, now, now),
                )
            conn.execute("UPDATE WORKBOOK_REPOSITORIES SET MAIN_PROTECTED=1, UPDATED_AT=? WHERE REPOSITORY_ID=?", (now, repo["REPOSITORY_ID"]))
            branch = conn.execute("SELECT * FROM BRANCHES WHERE BRANCH_ID=?", (branch_id,)).fetchone()
            ensure_branch_identities(
                conn,
                branch_id,
                repo["REPOSITORY_ID"],
                branch_table,
                source_branch_id=main["BRANCH_ID"],
            )
        else:
            ensure_branch_identities(
                conn,
                branch["BRANCH_ID"],
                repo["REPOSITORY_ID"],
                branch["DATA_TABLE_ID"],
                source_branch_id=repo["DEFAULT_BRANCH_ID"],
            )
        working_copy_id = f"WC_{uuid.uuid4().hex[:12].upper()}"
        issued_at = now
        fingerprint = hashlib.sha256(f"{repo['REPOSITORY_ID']}:{branch['BRANCH_ID']}:{working_copy_id}".encode()).hexdigest()
        payload = ":".join([repo["REPOSITORY_ID"], branch["BRANCH_ID"], working_copy_id, branch["HEAD_COMMIT_ID"], issued_at])
        signature = hmac.new(settings.auth_secret.encode(), payload.encode(), hashlib.sha256).hexdigest()
        conn.execute(
            """
            INSERT INTO WORKING_COPIES (WORKING_COPY_ID, REPOSITORY_ID, BRANCH_ID, USER_ID,
                BASE_COMMIT_ID, GENERATED_AT, LAST_SEEN_AT, STATUS, WORKBOOK_FINGERPRINT, ISSUED_AT, SIGNATURE)
            VALUES (?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?, ?)
            """,
            (working_copy_id, repo["REPOSITORY_ID"], branch["BRANCH_ID"], user_id, branch["HEAD_COMMIT_ID"], now, now, fingerprint, issued_at, signature),
        )
        conn.commit()
        return {
            "repository_id": repo["REPOSITORY_ID"], "branch_id": branch["BRANCH_ID"],
            "branch_name": branch["BRANCH_NAME"], "table_id": branch["DATA_TABLE_ID"],
            "working_copy_id": working_copy_id, "base_commit_id": branch["HEAD_COMMIT_ID"],
            "issued_at": issued_at, "signature": signature,
        }
    finally:
        conn.close()


def working_copy_checkout_options(table_id: str, user_id: str) -> dict[str, Any]:
    """Describe reusable branches before issuing another local workbook."""
    conn = _get_connection()
    try:
        repository = conn.execute(
            """
            SELECT R.REPOSITORY_ID,R.REPOSITORY_NAME,M.ROLE
            FROM WORKBOOK_REPOSITORIES R
            LEFT JOIN REPOSITORY_MEMBERS M
              ON M.REPOSITORY_ID=R.REPOSITORY_ID AND M.USER_ID=?
            WHERE R.TABLE_ID=? AND R.STATUS='ACTIVE'
            """,
            (user_id, table_id),
        ).fetchone()
        if not repository:
            raise ValueError("Workbook repository does not exist")
        branches = conn.execute(
            """
            SELECT B.BRANCH_ID,B.BRANCH_NAME,B.HEAD_COMMIT_ID,B.UPDATED_AT,
                   COUNT(CASE WHEN W.STATUS='ACTIVE' THEN 1 END) AS ACTIVE_COPIES,
                   MAX(W.LAST_SEEN_AT) AS LAST_OPENED_AT
            FROM BRANCHES B
            LEFT JOIN WORKING_COPIES W ON W.BRANCH_ID=B.BRANCH_ID AND W.USER_ID=?
            WHERE B.REPOSITORY_ID=? AND B.CREATED_BY=?
              AND B.BRANCH_TYPE='USER' AND B.STATUS='ACTIVE'
            GROUP BY B.BRANCH_ID
            ORDER BY B.UPDATED_AT DESC
            """,
            (user_id, repository["REPOSITORY_ID"], user_id),
        ).fetchall()
        return {
            "repository_id": repository["REPOSITORY_ID"],
            "repository_name": repository["REPOSITORY_NAME"],
            "role": repository["ROLE"],
            "can_edit": repository["ROLE"] in {"owner", "editor"},
            "branches": [
                {key.lower(): row[key] for key in row.keys()} for row in branches
            ],
        }
    finally:
        conn.close()


def authenticate_working_copy_identity(
    table_id: str,
    repository_id: str,
    branch_id: str,
    working_copy_id: str,
    base_commit_id: str,
    issued_at: str,
    signature: str,
) -> dict[str, Any]:
    """Authenticate the owner of an active, signed workbook checkout."""
    conn = _get_connection()
    try:
        row = conn.execute(
            """
            SELECT W.USER_ID,U.EMAIL
            FROM WORKING_COPIES W JOIN APP_USERS U ON U.USER_ID=W.USER_ID
            WHERE W.WORKING_COPY_ID=?
            """,
            (working_copy_id,),
        ).fetchone()
    finally:
        conn.close()
    if not row:
        raise PermissionError("Working copy is not registered")
    validate_working_copy(
        table_id, row["USER_ID"], repository_id, branch_id, working_copy_id,
        base_commit_id, issued_at, signature,
    )
    return {"user_id": row["USER_ID"], "email": row["EMAIL"]}


def validate_working_copy(
    table_id: str,
    user_id: str,
    repository_id: str | None,
    branch_id: str | None,
    working_copy_id: str | None,
    base_commit_id: str | None,
    issued_at: str | None,
    signature: str | None,
) -> dict[str, Any]:
    """Validate signed workbook identity against authoritative server records."""
    values = (
        repository_id, branch_id, working_copy_id, base_commit_id, issued_at, signature,
    )
    if any(not value for value in values):
        raise PermissionError(
            "This workbook is missing Git Walk branch identity. Download a fresh working copy."
        )
    conn = _get_connection()
    try:
        row = conn.execute(
            """
            SELECT W.*, B.DATA_TABLE_ID, B.STATUS AS BRANCH_STATUS, B.BRANCH_NAME,
                   R.STATUS AS REPOSITORY_STATUS
            FROM WORKING_COPIES W
            JOIN BRANCHES B ON B.BRANCH_ID=W.BRANCH_ID
            JOIN WORKBOOK_REPOSITORIES R ON R.REPOSITORY_ID=W.REPOSITORY_ID
            WHERE W.WORKING_COPY_ID=?
            """,
            (working_copy_id,),
        ).fetchone()
        if not row:
            raise PermissionError("Working copy is not registered")
        expected_values = {
            "REPOSITORY_ID": repository_id,
            "BRANCH_ID": branch_id,
            "USER_ID": user_id,
            "DATA_TABLE_ID": table_id,
            "BASE_COMMIT_ID": base_commit_id,
            "ISSUED_AT": issued_at,
        }
        if any(str(row[key]) != str(value) for key, value in expected_values.items()):
            raise PermissionError("Workbook identity does not match the signed working copy")
        if row["STATUS"] != "ACTIVE" or row["BRANCH_STATUS"] != "ACTIVE":
            raise PermissionError("Working copy or branch is no longer active")
        if row["REPOSITORY_STATUS"] != "ACTIVE":
            raise PermissionError("Workbook repository is no longer active")
        payload = ":".join(
            [repository_id, branch_id, working_copy_id, base_commit_id, issued_at]
        )
        expected_signature = hmac.new(
            settings.auth_secret.encode(), payload.encode(), hashlib.sha256
        ).hexdigest()
        if not hmac.compare_digest(signature, row["SIGNATURE"]):
            raise PermissionError("Workbook signature is not valid")
        if not hmac.compare_digest(signature, expected_signature):
            raise PermissionError("Workbook signature could not be verified")
        conn.execute(
            "UPDATE WORKING_COPIES SET LAST_SEEN_AT=? WHERE WORKING_COPY_ID=?",
            (_utcnow(), working_copy_id),
        )
        conn.commit()
        return {key.lower(): row[key] for key in row.keys()}
    finally:
        conn.close()


def advance_branch_head(table_id: str, commit_id: str) -> None:
    conn = _get_connection()
    try:
        conn.execute(
            "UPDATE BRANCHES SET HEAD_COMMIT_ID=?, UPDATED_AT=? WHERE DATA_TABLE_ID=? AND BRANCH_TYPE='USER'",
            (commit_id, _utcnow(), table_id),
        )
        conn.commit()
    finally:
        conn.close()


def working_copy_required(table_id: str) -> bool:
    conn = _get_connection()
    try:
        row = conn.execute(
            "SELECT BRANCH_TYPE FROM BRANCHES WHERE DATA_TABLE_ID=? AND STATUS='ACTIVE'",
            (table_id,),
        ).fetchone()
        return bool(row and row[0] == "USER")
    finally:
        conn.close()


def user_can_work_on_repository(table_id: str, user_id: str) -> bool:
    """Check repository edit access without bypassing protected-main rules."""
    conn = _get_connection()
    try:
        row = conn.execute(
            """
            SELECT 1
            FROM WORKBOOK_REPOSITORIES R
            JOIN REPOSITORY_MEMBERS M ON M.REPOSITORY_ID=R.REPOSITORY_ID
            WHERE R.TABLE_ID=? AND R.STATUS='ACTIVE'
              AND (M.USER_ID=? AND M.ROLE IN ('owner','editor') OR ?='USR_SYSTEM')
            """,
            (table_id, user_id, user_id),
        ).fetchone()
        return row is not None
    finally:
        conn.close()


def repository_name_available(name: str) -> dict[str, Any]:
    normalized = name.strip()
    slug = re.sub(r"[^a-z0-9]+", "-", normalized.lower()).strip("-")
    if len(normalized) < 2 or not slug:
        return {"available": False, "slug": slug, "reason": "Use at least two letters or numbers"}
    conn = _get_connection()
    try:
        exists = conn.execute(
            "SELECT 1 FROM WORKBOOK_REPOSITORIES WHERE REPOSITORY_SLUG=? AND STATUS='ACTIVE'",
            (slug,),
        ).fetchone()
        return {
            "available": exists is None,
            "slug": slug,
            "reason": None if exists is None else "That repository name is already in use",
        }
    finally:
        conn.close()


def delete_repository(table_id: str, user_id: str) -> dict[str, Any]:
    """Soft-delete a repository while preserving immutable audit history."""
    conn = _get_connection()
    try:
        row = conn.execute(
            """
            SELECT R.REPOSITORY_ID, M.ROLE FROM WORKBOOK_REPOSITORIES R
            JOIN REPOSITORY_MEMBERS M ON M.REPOSITORY_ID=R.REPOSITORY_ID
            WHERE R.TABLE_ID=? AND R.STATUS='ACTIVE' AND M.USER_ID=?
            """,
            (table_id, user_id),
        ).fetchone()
        policy = RepositoryPolicy.from_value(row["ROLE"] if row else None)
        if not row or not policy or not policy.can_delete_repository:
            raise PermissionError("Only the repository owner can delete this repository")
        now = _utcnow()
        conn.execute(
            "UPDATE WORKBOOK_REPOSITORIES SET STATUS='DELETED', UPDATED_AT=? WHERE REPOSITORY_ID=?",
            (now, row["REPOSITORY_ID"]),
        )
        conn.execute(
            "UPDATE BRANCHES SET STATUS='DELETED', ARCHIVED_AT=?, UPDATED_AT=? WHERE REPOSITORY_ID=?",
            (now, now, row["REPOSITORY_ID"]),
        )
        conn.execute(
            "UPDATE WORKING_COPIES SET STATUS='REVOKED', LAST_SEEN_AT=? WHERE REPOSITORY_ID=? AND STATUS='ACTIVE'",
            (now, row["REPOSITORY_ID"]),
        )
        conn.commit()
        return {"repository_id": row["REPOSITORY_ID"], "table_id": table_id, "status": "DELETED"}
    finally:
        conn.close()


def delete_branch(branch_id: str, user_id: str) -> dict[str, Any]:
    conn = _get_connection()
    try:
        row = conn.execute(
            """
            SELECT B.*, M.ROLE FROM BRANCHES B
            JOIN REPOSITORY_MEMBERS M ON M.REPOSITORY_ID=B.REPOSITORY_ID
            WHERE B.BRANCH_ID=? AND B.STATUS='ACTIVE' AND M.USER_ID=?
            """,
            (branch_id, user_id),
        ).fetchone()
        if not row:
            raise PermissionError("Branch does not exist or is not accessible")
        policy = BranchPolicy(
            actor_user_id=user_id,
            created_by=row["CREATED_BY"],
            branch_type=row["BRANCH_TYPE"],
            repository_role=RepositoryRole(row["ROLE"]),
        )
        if not policy.can_delete:
            raise PermissionError("Only the branch author or repository owner can delete this branch")
        now = _utcnow()
        conn.execute(
            "UPDATE BRANCHES SET STATUS='DELETED', ARCHIVED_AT=?, UPDATED_AT=? WHERE BRANCH_ID=?",
            (now, now, branch_id),
        )
        conn.execute(
            "UPDATE WORKING_COPIES SET STATUS='REVOKED', LAST_SEEN_AT=? WHERE BRANCH_ID=? AND STATUS='ACTIVE'",
            (now, branch_id),
        )
        conn.commit()
        return {"branch_id": branch_id, "status": "DELETED", "working_copy_status": "REVOKED"}
    finally:
        conn.close()


def get_branch_sheet_page(
    table_id: str,
    branch_id: str,
    sheet_id: str,
    user_id: str,
    limit: int = 100,
    offset: int = 0,
) -> dict[str, Any]:
    repository = get_repository(table_id, user_id)
    if not repository:
        raise PermissionError("Repository access is required")
    conn = _get_connection()
    try:
        mapping = conn.execute(
            """
            SELECT T.DATA_TABLE_ID, S.SHEET_NAME, S.SHEET_POSITION
            FROM BRANCH_SHEET_TABLES T JOIN BRANCH_SHEETS S
              ON S.BRANCH_ID=T.BRANCH_ID AND S.SHEET_ID=T.SHEET_ID
            WHERE T.BRANCH_ID=? AND T.SHEET_ID=? AND S.STATUS='ACTIVE'
              AND S.BRANCH_ID IN (SELECT BRANCH_ID FROM BRANCHES WHERE REPOSITORY_ID=? AND STATUS IN ('ACTIVE','MERGED'))
            """,
            (branch_id, sheet_id, repository["repository_id"]),
        ).fetchone()
        if not mapping:
            raise ValueError("Worksheet does not exist on this branch")
        page = get_table_page(mapping["DATA_TABLE_ID"], limit, offset)
        page.update({
            "repository_table_id": table_id,
            "branch_id": branch_id,
            "sheet_id": sheet_id,
            "sheet_name": mapping["SHEET_NAME"],
            "sheet_position": mapping["SHEET_POSITION"],
        })
        return page
    finally:
        conn.close()


def list_categories() -> list[dict[str, Any]]:
    conn = _get_connection()
    try:
        rows = conn.execute(
            """
            SELECT C.*,
                   (SELECT COUNT(*) FROM CATEGORIES X WHERE X.PARENT_CATEGORY_ID=C.CATEGORY_ID AND X.STATUS='ACTIVE') AS CHILD_COUNT,
                   (SELECT COUNT(*) FROM WORKBOOK_REPOSITORIES R WHERE R.CATEGORY_ID=C.CATEGORY_ID AND R.STATUS='ACTIVE') AS REPOSITORY_COUNT
            FROM CATEGORIES C WHERE C.STATUS='ACTIVE'
            ORDER BY C.DISPLAY_ORDER, C.NAME
            """
        ).fetchall()
        return [{key.lower(): row[key] for key in row.keys()} for row in rows]
    finally:
        conn.close()


def create_category(
    name: str, description: str | None, parent_category_id: str | None
) -> dict[str, Any]:
    conn = _get_connection()
    try:
        parent_id = parent_category_id or "CAT_HOME"
        if not conn.execute(
            "SELECT 1 FROM CATEGORIES WHERE CATEGORY_ID=? AND STATUS='ACTIVE'", (parent_id,)
        ).fetchone():
            raise ValueError("Parent category does not exist")
        now = _utcnow()
        category_id = f"CAT_{uuid.uuid4().hex[:12].upper()}"
        conn.execute(
            """
            INSERT INTO CATEGORIES
                (CATEGORY_ID, PARENT_CATEGORY_ID, NAME, DESCRIPTION, DISPLAY_ORDER, STATUS, CREATED_AT, UPDATED_AT)
            VALUES (?, ?, ?, ?, 0, 'ACTIVE', ?, ?)
            """,
            (category_id, parent_id, name.strip(), description, now, now),
        )
        conn.commit()
        return {
            "category_id": category_id, "parent_category_id": parent_id,
            "name": name.strip(), "description": description, "status": "ACTIVE",
        }
    finally:
        conn.close()


def move_repository(table_id: str, category_id: str, user_id: str) -> dict[str, str]:
    conn = _get_connection()
    try:
        owner = conn.execute(
            "SELECT OWNER_USER_ID FROM DATASET_REGISTRY WHERE TABLE_ID=?", (table_id,)
        ).fetchone()
        if not owner or owner[0] != user_id:
            raise PermissionError("Only the repository owner can change its business area")
        if not conn.execute(
            "SELECT 1 FROM CATEGORIES WHERE CATEGORY_ID=? AND STATUS='ACTIVE'", (category_id,)
        ).fetchone():
            raise ValueError("Category does not exist")
        conn.execute(
            "UPDATE WORKBOOK_REPOSITORIES SET CATEGORY_ID=?, UPDATED_AT=? WHERE TABLE_ID=?",
            (category_id, _utcnow(), table_id),
        )
        conn.commit()
        return {"table_id": table_id, "category_id": category_id}
    finally:
        conn.close()


def get_repository(table_id: str, user_id: str) -> dict[str, Any] | None:
    conn = _get_connection()
    try:
        row = conn.execute(
            """
            SELECT R.*, D.ORIGINAL_FILENAME, D.ROW_COUNT, D.COLUMN_COUNT,
                   D.CURRENT_VERSION, D.OWNER_USER_ID, C.NAME AS CATEGORY_NAME,
                   B.HEAD_COMMIT_ID AS MAIN_HEAD_COMMIT_ID,
                   COALESCE(M.ROLE, CASE WHEN ?='USR_SYSTEM' THEN 'owner' END) AS REPOSITORY_ROLE
            FROM WORKBOOK_REPOSITORIES R
            JOIN DATASET_REGISTRY D ON D.TABLE_ID=R.TABLE_ID
            JOIN CATEGORIES C ON C.CATEGORY_ID=R.CATEGORY_ID
            JOIN BRANCHES B ON B.BRANCH_ID=R.DEFAULT_BRANCH_ID
            LEFT JOIN REPOSITORY_MEMBERS M ON M.REPOSITORY_ID=R.REPOSITORY_ID AND M.USER_ID=?
            WHERE R.TABLE_ID=? AND R.STATUS='ACTIVE' AND (M.USER_ID IS NOT NULL OR ?='USR_SYSTEM')
            """,
            (user_id, user_id, table_id, user_id),
        ).fetchone()
        if not row:
            return None
        result = {key.lower(): row[key] for key in row.keys()}
        policy = RepositoryPolicy.from_value(result.get("repository_role"))
        result["capabilities"] = policy.capabilities() if policy else {}
        sheets = conn.execute(
            """
            SELECT S.*, T.DATA_TABLE_ID
            FROM WORKBOOK_SHEETS S
            LEFT JOIN BRANCH_SHEET_TABLES T
              ON T.SHEET_ID=S.SHEET_ID AND T.BRANCH_ID=?
            WHERE S.REPOSITORY_ID=? AND S.STATUS='ACTIVE' ORDER BY S.SHEET_ORDER
            """,
            (row["DEFAULT_BRANCH_ID"], row["REPOSITORY_ID"]),
        ).fetchall()
        result["sheets"] = [
            {key.lower(): item[key] for key in item.keys()} for item in sheets
        ]
        return result
    finally:
        conn.close()


def list_repository_branches(table_id: str, user_id: str) -> list[dict[str, Any]]:
    repository = get_repository(table_id, user_id)
    if not repository:
        return []
    conn = _get_connection()
    try:
        rows = conn.execute(
            """
            SELECT B.*, U.EMAIL AS CREATED_BY_EMAIL,
                   (SELECT COUNT(*) FROM WORKING_COPIES W WHERE W.BRANCH_ID=B.BRANCH_ID AND W.STATUS='ACTIVE') AS ACTIVE_COPIES
            FROM BRANCHES B
            LEFT JOIN APP_USERS U ON U.USER_ID=B.CREATED_BY
            WHERE B.REPOSITORY_ID=? AND B.STATUS IN ('ACTIVE','MERGED')
              AND (
                B.BRANCH_TYPE='MAIN' OR B.CREATED_BY=?
                OR ?=(SELECT CREATED_BY FROM WORKBOOK_REPOSITORIES WHERE REPOSITORY_ID=B.REPOSITORY_ID)
                OR EXISTS (
                    SELECT 1 FROM MERGE_REQUESTS MR
                    WHERE MR.SOURCE_BRANCH_ID=B.BRANCH_ID
                      AND MR.STATUS NOT IN ('CLOSED')
                )
              )
            ORDER BY CASE B.BRANCH_TYPE WHEN 'MAIN' THEN 0 ELSE 1 END, B.UPDATED_AT DESC
            """,
            (repository["repository_id"], user_id, user_id),
        ).fetchall()
        return [{key.lower(): row[key] for key in row.keys()} for row in rows]
    finally:
        conn.close()


def list_user_working_copies(user_id: str) -> list[dict[str, Any]]:
    conn = _get_connection()
    try:
        rows = conn.execute(
            """
            SELECT W.WORKING_COPY_ID, W.REPOSITORY_ID, W.BRANCH_ID, W.BASE_COMMIT_ID,
                   W.GENERATED_AT, W.LAST_SEEN_AT, W.STATUS, B.BRANCH_NAME,
                   B.DATA_TABLE_ID, B.HEAD_COMMIT_ID, R.TABLE_ID AS MAIN_TABLE_ID,
                   R.REPOSITORY_NAME, D.ORIGINAL_FILENAME
            FROM WORKING_COPIES W
            JOIN BRANCHES B ON B.BRANCH_ID=W.BRANCH_ID
            JOIN WORKBOOK_REPOSITORIES R ON R.REPOSITORY_ID=W.REPOSITORY_ID
            JOIN DATASET_REGISTRY D ON D.TABLE_ID=R.TABLE_ID
            WHERE W.USER_ID=? AND W.STATUS='ACTIVE' AND B.STATUS='ACTIVE'
            ORDER BY W.LAST_SEEN_AT DESC
            """,
            (user_id,),
        ).fetchall()
        return [{key.lower(): row[key] for key in row.keys()} for row in rows]
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
                ) OR EXISTS (
                    SELECT 1 FROM BRANCH_SHEET_TABLES T
                    JOIN BRANCHES B ON B.BRANCH_ID=T.BRANCH_ID
                    JOIN REPOSITORY_MEMBERS RM ON RM.REPOSITORY_ID=B.REPOSITORY_ID
                    JOIN WORKBOOK_REPOSITORIES R ON R.REPOSITORY_ID=B.REPOSITORY_ID
                    WHERE T.DATA_TABLE_ID=D.TABLE_ID AND RM.USER_ID=?
                      AND B.STATUS IN ('ACTIVE','MERGED') AND R.STATUS='ACTIVE'
                )
            )
            """,
            (table_id, user_id, user_id, user_id),
        ).fetchone()
        return row is not None
    finally:
        conn.close()


def user_can_access_branch(branch_id: str, user_id: str) -> bool:
    conn = _get_connection()
    try:
        row = conn.execute(
            """
            SELECT 1
            FROM BRANCHES B
            JOIN WORKBOOK_REPOSITORIES R ON R.REPOSITORY_ID=B.REPOSITORY_ID
            JOIN DATASET_REGISTRY D ON D.TABLE_ID=R.TABLE_ID
            WHERE B.BRANCH_ID=? AND B.STATUS IN ('ACTIVE','MERGED')
              AND (
                D.OWNER_USER_ID IN (?, 'USR_SYSTEM') OR EXISTS (
                    SELECT 1 FROM DATASET_MEMBERS M
                    WHERE M.TABLE_ID=D.TABLE_ID AND M.USER_ID=?
                )
              )
              AND (
                B.BRANCH_TYPE='MAIN' OR B.CREATED_BY=? OR D.OWNER_USER_ID IN (?, 'USR_SYSTEM')
                OR EXISTS (
                    SELECT 1 FROM MERGE_REQUESTS MR
                    WHERE MR.SOURCE_BRANCH_ID=B.BRANCH_ID
                      AND MR.STATUS NOT IN ('CLOSED')
                )
              )
            """,
            (branch_id, user_id, user_id, user_id, user_id),
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
            AND NOT EXISTS (
                SELECT 1 FROM WORKBOOK_REPOSITORIES R
                WHERE R.TABLE_ID=D.TABLE_ID AND R.MAIN_PROTECTED=1
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
        normalized_email = email.strip().lower()
        if user and user[0] == owner_user_id:
            raise ValueError("The dataset owner already has full access")
        now = _utcnow()
        if not user:
            invitation_id = f"INV_{uuid.uuid4().hex[:12].upper()}"
            conn.execute(
                """
                INSERT INTO DATASET_INVITATIONS
                    (INVITATION_ID, TABLE_ID, EMAIL, ROLE, STATUS, INVITED_BY, CREATED_AT, UPDATED_AT)
                VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)
                ON CONFLICT(TABLE_ID, EMAIL) DO UPDATE SET
                    ROLE=excluded.ROLE, STATUS='pending', INVITED_BY=excluded.INVITED_BY,
                    UPDATED_AT=excluded.UPDATED_AT
                """,
                (invitation_id, table_id, normalized_email, normalized_role, owner_user_id, now, now),
            )
            _workspace_event(conn, table_id, "INVITATION_CREATED", owner_user_id, {"email": normalized_email, "role": normalized_role})
            conn.commit()
            return {"email": normalized_email, "role": normalized_role, "status": "pending"}
        conn.execute(
            "INSERT INTO DATASET_MEMBERS (TABLE_ID, USER_ID, ROLE, ADDED_AT) VALUES (?, ?, ?, ?) ON CONFLICT(TABLE_ID, USER_ID) DO UPDATE SET ROLE=excluded.ROLE",
            (table_id, user[0], normalized_role, now),
        )
        repository = conn.execute(
            "SELECT REPOSITORY_ID FROM WORKBOOK_REPOSITORIES WHERE TABLE_ID=?",
            (table_id,),
        ).fetchone()
        if repository:
            conn.execute(
                """
                INSERT INTO REPOSITORY_MEMBERS
                    (REPOSITORY_ID, USER_ID, ROLE, GRANTED_BY, CREATED_AT, UPDATED_AT)
                VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(REPOSITORY_ID, USER_ID) DO UPDATE SET
                    ROLE=excluded.ROLE, GRANTED_BY=excluded.GRANTED_BY,
                    UPDATED_AT=excluded.UPDATED_AT
                """,
                (repository[0], user[0], normalized_role, owner_user_id, now, now),
            )
        conn.execute(
            "UPDATE DATASET_INVITATIONS SET STATUS='accepted', UPDATED_AT=? WHERE TABLE_ID=? AND EMAIL=? COLLATE NOCASE",
            (now, table_id, normalized_email),
        )
        _workspace_event(conn, table_id, "MEMBER_UPDATED", owner_user_id, {"user_id": user[0], "email": normalized_email, "role": normalized_role})
        conn.commit()
        return {
            "user_id": user[0], "email": user[1], "display_name": user[2],
            "role": normalized_role, "added_at": now, "status": "active",
        }
    finally:
        conn.close()


def remove_dataset_member(
    table_id: str, owner_user_id: str, email: str
) -> dict[str, Any]:
    normalized_email = email.strip().lower()
    conn = _get_connection()
    try:
        owner = conn.execute(
            "SELECT OWNER_USER_ID FROM DATASET_REGISTRY WHERE TABLE_ID=?", (table_id,)
        ).fetchone()
        if not owner or owner[0] != owner_user_id:
            raise PermissionError("Only the dataset owner can manage access")
        user = conn.execute(
            "SELECT USER_ID FROM APP_USERS WHERE EMAIL=? COLLATE NOCASE", (normalized_email,)
        ).fetchone()
        if user and user[0] == owner_user_id:
            raise ValueError("The repository owner cannot be removed")
        if user:
            conn.execute(
                "DELETE FROM DATASET_MEMBERS WHERE TABLE_ID=? AND USER_ID=?",
                (table_id, user[0]),
            )
            repository = conn.execute(
                "SELECT REPOSITORY_ID FROM WORKBOOK_REPOSITORIES WHERE TABLE_ID=?",
                (table_id,),
            ).fetchone()
            if repository:
                conn.execute(
                    "DELETE FROM REPOSITORY_MEMBERS WHERE REPOSITORY_ID=? AND USER_ID=? AND ROLE!='owner'",
                    (repository[0], user[0]),
                )
        conn.execute(
            "UPDATE DATASET_INVITATIONS SET STATUS='revoked', UPDATED_AT=? WHERE TABLE_ID=? AND EMAIL=? COLLATE NOCASE",
            (_utcnow(), table_id, normalized_email),
        )
        _workspace_event(conn, table_id, "ACCESS_REVOKED", owner_user_id, {"email": normalized_email})
        conn.commit()
        return {"email": normalized_email, "status": "revoked"}
    finally:
        conn.close()


def get_workspace_snapshot(table_id: str) -> dict[str, Any]:
    conn = _get_connection()
    try:
        invitations = conn.execute(
            """
            SELECT INVITATION_ID, EMAIL, ROLE, STATUS, CREATED_AT, UPDATED_AT
            FROM DATASET_INVITATIONS WHERE TABLE_ID=? AND STATUS='pending'
            ORDER BY CREATED_AT
            """,
            (table_id,),
        ).fetchall()
        revision = conn.execute(
            "SELECT COALESCE(MAX(REVISION), 0) FROM WORKSPACE_EVENTS WHERE TABLE_ID=?",
            (table_id,),
        ).fetchone()[0]
    finally:
        conn.close()
    return {
        "revision": revision,
        "members": get_dataset_members(table_id),
        "invitations": [{key.lower(): row[key] for key in row.keys()} for row in invitations],
        "active_users": list_active_presence(table_id),
    }


def list_datasets(user_id: str) -> list[dict[str, Any]]:
    conn = _get_connection()
    try:
        rows = conn.execute(
            """
            SELECT D.*, U.EMAIL AS OWNER_EMAIL, R.REPOSITORY_ID, R.REPOSITORY_NAME,
                   R.CATEGORY_ID, R.DEFAULT_BRANCH_ID, R.MAIN_PROTECTED,
                   R.REPOSITORY_SLUG, R.VISIBILITY,
                   COALESCE(M.ROLE, 'locked') AS REPOSITORY_ROLE,
                   CASE WHEN M.ROLE IS NULL THEN 'denied' ELSE M.ROLE END AS ACCESS_LEVEL,
                   CASE WHEN M.ROLE IS NULL THEN 0 ELSE 1 END AS CAN_VIEW,
                   CASE WHEN M.ROLE IN ('owner','editor') THEN 1 ELSE 0 END AS CAN_EDIT,
                   C.NAME AS CATEGORY_NAME,
                   (SELECT COUNT(DISTINCT BATCH_ID) FROM AUDIT_COMMITS A
                    WHERE A.TABLE_ID=D.TABLE_ID) AS COMMIT_COUNT,
                   (SELECT COUNT(*) FROM BRANCHES B
                    WHERE B.REPOSITORY_ID=R.REPOSITORY_ID AND B.STATUS='ACTIVE') AS BRANCH_COUNT,
                   (SELECT B2.BRANCH_NAME FROM BRANCHES B2
                    WHERE B2.REPOSITORY_ID=R.REPOSITORY_ID AND B2.CREATED_BY=?
                      AND B2.BRANCH_TYPE='USER' AND B2.STATUS='ACTIVE' LIMIT 1) AS MY_BRANCH
            FROM DATASET_REGISTRY D
            JOIN APP_USERS U ON U.USER_ID=D.OWNER_USER_ID
            JOIN WORKBOOK_REPOSITORIES R ON R.TABLE_ID=D.TABLE_ID AND R.STATUS='ACTIVE'
            LEFT JOIN REPOSITORY_MEMBERS M ON M.REPOSITORY_ID=R.REPOSITORY_ID AND M.USER_ID=?
            JOIN CATEGORIES C ON C.CATEGORY_ID=R.CATEGORY_ID
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
        if requested_version == current_version:
            try:
                semantic = semantic_snapshot(conn, table_id)
                snapshot["semantic"] = semantic
                snapshot["head_commit_id"] = semantic["head_commit_id"]
                if semantic.get("sheets"):
                    primary = semantic["sheets"][0]
                    snapshot["sheet_id"] = primary["sheet_id"]
                    snapshot["semantic_columns"] = primary["columns"]
                    snapshot["row_identities"] = [
                        {
                            "row_id": row["row_id"],
                            "physical_row_id": row.get("physical_row_id"),
                            "position": row["position"],
                        }
                        for row in primary["rows"]
                    ]
            except ValueError:
                pass
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
