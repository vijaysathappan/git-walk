"""
Unit & Integration Tests for Conditional Excel Data Loading via File Path,
User Credential, and Role Verification.
"""

import os
import shutil
import tempfile
import unittest
from pathlib import Path
from openpyxl import load_workbook
from fastapi.testclient import TestClient

from app.database import (
    _get_connection,
    get_or_create_user,
    set_user_password,
    verify_user_credentials,
    verify_workbook_access,
    register_dataset,
    initialize_product_schema,
    update_branch_local_path,
)
from app.main import app
from app.services.workbook_service import (
    _write_branch_xlsx,
    issue_branch_workbook,
    export_branch_workbook,
)


class ConditionalDataLoadingTests(unittest.TestCase):
    def setUp(self):
        initialize_product_schema()
        self.client = TestClient(app)
        self.temp_dir = Path(tempfile.mkdtemp(prefix="gitwalk_cond_test_"))
        self.owner = get_or_create_user("cond_owner@example.com")
        set_user_password(self.owner["user_id"], "Secret123!")

        # Create a test table with sample rows
        self.table_id = "QUEUE_BOARD_CONDTEST"
        conn = _get_connection()
        try:
            conn.execute(f'DROP TABLE IF EXISTS "{self.table_id}"')
            conn.execute(
                f'CREATE TABLE "{self.table_id}" ('
                f'ROW_ID INTEGER PRIMARY KEY AUTOINCREMENT, '
                f'NAME TEXT, SALARY INTEGER, DEPT TEXT)'
            )
            conn.execute(
                f'INSERT INTO "{self.table_id}" (NAME, SALARY, DEPT) VALUES (?, ?, ?)',
                ("Alice Smith", 95000, "Engineering"),
            )
            conn.execute(
                f'INSERT INTO "{self.table_id}" (NAME, SALARY, DEPT) VALUES (?, ?, ?)',
                ("Bob Jones", 80000, "Marketing"),
            )
            conn.commit()
            register_dataset(self.table_id, self.owner["user_id"], "test.xlsx", 2, 3)
        finally:
            conn.close()

    def tearDown(self):
        if self.temp_dir.exists():
            shutil.rmtree(self.temp_dir, ignore_errors=True)

    def test_write_branch_xlsx_omits_rows_when_include_data_false(self):
        """Branch workbooks must NOT contain sensitive data rows before authentication."""
        dest_locked = self.temp_dir / "branch_locked.xlsx"
        _write_branch_xlsx(self.table_id, dest_locked, include_data=False)

        wb = load_workbook(str(dest_locked))
        sheet = wb.active
        # Header row exists
        self.assertEqual("NAME", sheet.cell(row=1, column=1).value)
        # Row 2 contains locked notice, NOT actual data
        row2_val = str(sheet.cell(row=2, column=1).value)
        self.assertIn("[LOCKED]", row2_val)
        # Ensure actual sensitive data is NOT anywhere in the rows
        all_cell_values = [cell.value for row in sheet.iter_rows() for cell in row if cell.value]
        self.assertNotIn("Alice Smith", all_cell_values)
        self.assertNotIn("Bob Jones", all_cell_values)

    def test_export_branch_workbook_includes_data(self):
        """Export branch workbooks should contain data."""
        export_res = export_branch_workbook(self.table_id, "BR_MAIN", "main_export")
        wb = load_workbook(export_res["path"])
        sheet = wb.active
        all_cell_values = [cell.value for row in sheet.iter_rows() for cell in row if cell.value]
        self.assertIn("Alice Smith", all_cell_values)
        self.assertIn("Bob Jones", all_cell_values)

    def test_issue_branch_workbook_embeds_local_file_path(self):
        """issue_branch_workbook must embed local_file_path and required_role in metadata."""
        dest_folder = self.temp_dir / "authorized_folder"
        dest_folder.mkdir(parents=True, exist_ok=True)
        result = issue_branch_workbook(
            main_table_id=self.table_id,
            user_id=self.owner["user_id"],
            user_email=self.owner["email"],
            local_target_dir=str(dest_folder),
        )
        self.assertIn("local_file_path", result)
        self.assertTrue(result["local_file_path"].startswith(str(dest_folder)))

        # Verify OpenXML defined names
        wb = load_workbook(result["path"])
        self.assertIn("_GITWALK_LOCAL_FILE_PATH", wb.defined_names)
        self.assertIn("_GITWALK_REQUIRED_ROLE", wb.defined_names)

    def test_credential_verification(self):
        """Password verification must succeed for valid credentials and fail for invalid ones."""
        # Correct password
        verified = verify_user_credentials(self.owner["email"], "Secret123!")
        self.assertIsNotNone(verified)
        self.assertEqual(self.owner["user_id"], verified["user_id"])

        # Correct by user_id
        verified_by_id = verify_user_credentials(self.owner["user_id"], "Secret123!")
        self.assertIsNotNone(verified_by_id)

        # Wrong password
        wrong = verify_user_credentials(self.owner["email"], "WrongPassword")
        self.assertIsNone(wrong)

        # Non-existent user
        non_existent = verify_user_credentials("nobody@example.com", "Secret123!")
        self.assertIsNone(non_existent)

    def _get_otp(self, email: str) -> str:
        conn = _get_connection()
        try:
            conn.execute("DELETE FROM AUTH_LOGIN_CODES WHERE EMAIL=?", (email.lower(),))
            conn.commit()
        finally:
            conn.close()
        from app.security import send_login_code
        return send_login_code(email)

    def _api_get_otp(self, email: str) -> str:
        conn = _get_connection()
        try:
            conn.execute("DELETE FROM AUTH_LOGIN_CODES WHERE EMAIL=?", (email.lower(),))
            conn.commit()
        finally:
            conn.close()
        req_res = self.client.post("/api/v1/auth/request-code", json={"email": email})
        self.assertEqual(200, req_res.status_code)
        return req_res.json()["dev_otp"]

    def test_verify_workbook_access_path_matching_and_rejection(self):
        """Path matching must enforce exact location and reject moved/copied workbooks."""
        dest_folder = self.temp_dir / "authorized_path"
        dest_folder.mkdir(parents=True, exist_ok=True)
        result = issue_branch_workbook(
            main_table_id=self.table_id,
            user_id=self.owner["user_id"],
            user_email=self.owner["email"],
            local_target_dir=str(dest_folder),
        )
        auth_path = result["local_file_path"]
        update_branch_local_path(result["branch_id"], auth_path)

        # 1. Matching path with Windows slash style and OTP code
        code = self._get_otp(self.owner["email"])

        access = verify_workbook_access(
            repository_id=result["repository_id"],
            branch_id=result["branch_id"],
            working_copy_id=result["working_copy_id"],
            email=self.owner["email"],
            code=code,
            current_file_path=auth_path,
        )
        self.assertEqual(self.owner["user_id"], access["user"]["user_id"])
        self.assertIn(access["role"], ("owner", "editor"))

        # 2. Matching path with file:/// URL style
        code_url = self._get_otp(self.owner["email"])
        file_url = f"file:///{auth_path.replace(os.sep, '/')}"
        access_url = verify_workbook_access(
            repository_id=result["repository_id"],
            branch_id=result["branch_id"],
            working_copy_id=result["working_copy_id"],
            email=self.owner["email"],
            code=code_url,
            current_file_path=file_url,
        )
        self.assertEqual(self.owner["user_id"], access_url["user"]["user_id"])

        # 3. Mismatched path (copied workbook to another folder)
        tampered_path = str(self.temp_dir / "copied_workbooks" / "stolen.xlsx")
        code_tampered = self._get_otp(self.owner["email"])
        with self.assertRaises(PermissionError) as ctx:
            verify_workbook_access(
                repository_id=result["repository_id"],
                branch_id=result["branch_id"],
                working_copy_id=result["working_copy_id"],
                email=self.owner["email"],
                code=code_tampered,
                current_file_path=tampered_path,
            )
        self.assertIn("FILE_PATH_MISMATCH", str(ctx.exception))

    def test_verify_workbook_access_role_enforcement(self):
        """Users with role 'viewer' must be denied workbook access to edit branch data."""
        dest_folder = self.temp_dir / "role_test"
        dest_folder.mkdir(parents=True, exist_ok=True)
        result = issue_branch_workbook(
            main_table_id=self.table_id,
            user_id=self.owner["user_id"],
            user_email=self.owner["email"],
            local_target_dir=str(dest_folder),
        )
        auth_path = result["local_file_path"]
        update_branch_local_path(result["branch_id"], auth_path)

        # Create a viewer-only user
        viewer = get_or_create_user("viewer_user@example.com")
        viewer_code = self._get_otp(viewer["email"])

        # Add viewer to repository with 'viewer' role
        conn = _get_connection()
        try:
            conn.execute(
                "INSERT INTO REPOSITORY_MEMBERS (REPOSITORY_ID, USER_ID, ROLE, GRANTED_BY, CREATED_AT, UPDATED_AT) "
                "VALUES (?, ?, 'viewer', ?, datetime('now'), datetime('now')) "
                "ON CONFLICT(REPOSITORY_ID, USER_ID) DO UPDATE SET ROLE='viewer'",
                (result["repository_id"], viewer["user_id"], self.owner["user_id"]),
            )
            conn.commit()
        finally:
            conn.close()

        # Attempt verification with viewer credentials
        with self.assertRaises(PermissionError) as ctx:
            verify_workbook_access(
                repository_id=result["repository_id"],
                branch_id=result["branch_id"],
                working_copy_id=result["working_copy_id"],
                email=viewer["email"],
                code=viewer_code,
                current_file_path=auth_path,
            )
        self.assertIn("INSUFFICIENT_ROLE", str(ctx.exception))

    def test_api_workbook_verify_endpoint(self):
        """API endpoint /api/v1/auth/workbook-verify must return 200 with snapshot on success, 403 on path mismatch."""
        dest_folder = self.temp_dir / "api_test"
        dest_folder.mkdir(parents=True, exist_ok=True)
        result = issue_branch_workbook(
            main_table_id=self.table_id,
            user_id=self.owner["user_id"],
            user_email=self.owner["email"],
            local_target_dir=str(dest_folder),
        )
        auth_path = result["local_file_path"]
        update_branch_local_path(result["branch_id"], auth_path)

        # Request OTP
        otp = self._api_get_otp(self.owner["email"])

        # Success case
        res = self.client.post(
            "/api/v1/auth/workbook-verify",
            json={
                "repository_id": result["repository_id"],
                "branch_id": result["branch_id"],
                "working_copy_id": result["working_copy_id"],
                "email": self.owner["email"],
                "code": otp,
                "current_file_path": auth_path,
            },
        )
        self.assertEqual(200, res.status_code)
        data = res.json()
        self.assertTrue(data["success"])
        self.assertIn("token", data)
        self.assertIn("snapshot", data)
        self.assertTrue(len(data["snapshot"]["semantic"]["sheets"]) > 0)

        # Path mismatch case -> 403
        otp2 = self._api_get_otp(self.owner["email"])
        bad_path_res = self.client.post(
            "/api/v1/auth/workbook-verify",
            json={
                "repository_id": result["repository_id"],
                "branch_id": result["branch_id"],
                "working_copy_id": result["working_copy_id"],
                "email": self.owner["email"],
                "code": otp2,
                "current_file_path": "C:\\Unauthorized\\Copied.xlsx",
            },
        )
        self.assertEqual(403, bad_path_res.status_code)
        self.assertIn("FILE_PATH_MISMATCH", bad_path_res.json()["detail"])

        # Wrong code case -> 401
        bad_pwd_res = self.client.post(
            "/api/v1/auth/workbook-verify",
            json={
                "repository_id": result["repository_id"],
                "branch_id": result["branch_id"],
                "working_copy_id": result["working_copy_id"],
                "email": self.owner["email"],
                "code": "000000",
                "current_file_path": auth_path,
            },
        )
        self.assertEqual(401, bad_pwd_res.status_code)


if __name__ == "__main__":
    unittest.main()
