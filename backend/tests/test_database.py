import sqlite3
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

from app import database
from app.secret_store import decrypt_secret, encrypt_secret


class DatabaseSyncTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.original_db_path = database.DB_PATH
        database.DB_PATH = Path(self.temp_dir.name) / "queue_board.db"

        conn = sqlite3.connect(database.DB_PATH)
        conn.execute(
            'CREATE TABLE "QUEUE_BOARD_TEST" ('
            'ROW_ID INTEGER PRIMARY KEY, "BATTING_TEAM" TEXT, '
            '"BOWLING_TEAM" TEXT)'
        )
        conn.execute(
            'INSERT INTO "QUEUE_BOARD_TEST" '
            '(ROW_ID, "BATTING_TEAM", "BOWLING_TEAM") '
            "VALUES (1, 'KKR', 'RCB')"
        )
        conn.execute(
            'INSERT INTO "QUEUE_BOARD_TEST" '
            '(ROW_ID, "BATTING_TEAM", "BOWLING_TEAM") '
            "VALUES (2, 'CSK', 'MI')"
        )
        conn.commit()
        conn.close()

    def tearDown(self):
        database.DB_PATH = self.original_db_path
        self.temp_dir.cleanup()

    def test_update_returns_committed_readback(self):
        result = database.update_cell(
            "QUEUE_BOARD_TEST", "BATTING_TEAM", 1, "SRH"
        )

        self.assertTrue(result["changed"])
        self.assertEqual("SRH", result["persisted_value"])
        self.assertEqual(
            "SRH", database.read_cell("QUEUE_BOARD_TEST", "BATTING_TEAM", 1)
        )

    def test_repeated_update_is_reported_as_no_change(self):
        database.update_cell("QUEUE_BOARD_TEST", "BATTING_TEAM", 1, "SRH")
        result = database.update_cell(
            "QUEUE_BOARD_TEST", "BATTING_TEAM", 1, "SRH"
        )

        self.assertFalse(result["changed"])
        self.assertEqual("SRH", result["persisted_value"])

    def _registered_user(self):
        database.initialize_product_schema()
        user = database.get_or_create_user("editor@example.com")
        database.register_dataset(
            "QUEUE_BOARD_TEST", user["user_id"], "teams.xlsx", 2, 2
        )
        return user

    def test_bulk_update_is_versioned_and_audited(self):
        user = self._registered_user()
        result = database.apply_bulk_updates(
            "QUEUE_BOARD_TEST",
            [
                {"row_id": 1, "column_name": "BOWLING_TEAM", "new_value": "CSK"},
                {"row_id": 2, "column_name": "BATTING_TEAM", "new_value": "SRH"},
            ],
            user["user_id"],
            user["email"],
            source="test",
            commit_message="Updated two Excel cells",
        )

        self.assertEqual(1, result["version"])
        self.assertEqual(2, result["changed_count"])
        self.assertEqual("CSK", database.read_cell("QUEUE_BOARD_TEST", "BOWLING_TEAM", 1))
        self.assertEqual("SRH", database.read_cell("QUEUE_BOARD_TEST", "BATTING_TEAM", 2))
        history = database.get_audit_history("QUEUE_BOARD_TEST")
        self.assertEqual(2, len(history))
        self.assertEqual({result["batch_id"]}, {item["batch_id"] for item in history})
        self.assertEqual({user["user_id"]}, {item["user_id"] for item in history})

    def test_bulk_update_rolls_back_every_cell_when_one_change_is_invalid(self):
        user = self._registered_user()

        with self.assertRaises(ValueError):
            database.apply_bulk_updates(
                "QUEUE_BOARD_TEST",
                [
                    {"row_id": 1, "column_name": "BATTING_TEAM", "new_value": "SRH"},
                    {"row_id": 99, "column_name": "BATTING_TEAM", "new_value": "GT"},
                ],
                user["user_id"],
                user["email"],
            )

        self.assertEqual("KKR", database.read_cell("QUEUE_BOARD_TEST", "BATTING_TEAM", 1))
        self.assertEqual([], database.get_audit_history("QUEUE_BOARD_TEST"))

    def test_change_set_can_be_reverted_as_a_new_version(self):
        user = self._registered_user()
        committed = database.apply_bulk_updates(
            "QUEUE_BOARD_TEST",
            [{"row_id": 1, "column_name": "BATTING_TEAM", "new_value": "SRH"}],
            user["user_id"],
            user["email"],
        )
        reverted = database.rollback_batch(
            "QUEUE_BOARD_TEST", committed["batch_id"], user["user_id"], user["email"]
        )

        self.assertEqual(2, reverted["version"])
        self.assertEqual("KKR", database.read_cell("QUEUE_BOARD_TEST", "BATTING_TEAM", 1))
        self.assertEqual("rollback", database.get_audit_history("QUEUE_BOARD_TEST")[0]["source"])

    def test_login_code_is_single_use(self):
        database.initialize_product_schema()
        expires = (datetime.now(timezone.utc) + timedelta(minutes=5)).isoformat()
        database.create_login_code("editor@example.com", "hashed-code", expires)

        self.assertTrue(database.consume_login_code("editor@example.com", "hashed-code"))
        self.assertFalse(database.consume_login_code("editor@example.com", "hashed-code"))

    def test_dataset_roles_separate_read_and_write_access(self):
        owner = self._registered_user()
        viewer = database.get_or_create_user("viewer@example.com")
        editor = database.get_or_create_user("collaborator@example.com")

        database.add_dataset_member(
            "QUEUE_BOARD_TEST", owner["user_id"], viewer["email"], "viewer"
        )
        database.add_dataset_member(
            "QUEUE_BOARD_TEST", owner["user_id"], editor["email"], "editor"
        )

        self.assertTrue(database.user_can_access_table("QUEUE_BOARD_TEST", viewer["user_id"]))
        self.assertFalse(database.user_can_edit_table("QUEUE_BOARD_TEST", viewer["user_id"]))
        self.assertTrue(database.user_can_edit_table("QUEUE_BOARD_TEST", editor["user_id"]))
        self.assertIn(
            "QUEUE_BOARD_TEST",
            {item["table_id"] for item in database.list_datasets(viewer["user_id"])},
        )

    def test_workbook_commit_applies_full_diff_as_one_version(self):
        user = self._registered_user()
        result = database.apply_workbook_commit(
            table_id="QUEUE_BOARD_TEST",
            base_version=0,
            updates=[
                {"row_id": 1, "column_name": "BATTING_TEAM", "new_value": "SRH"}
            ],
            insert_rows=[
                {"BATTING_TEAM": "GT", "BOWLING_TEAM": "LSG", "NOTES": "new row"}
            ],
            delete_row_ids=[2],
            new_columns=["NOTES"],
            delete_columns=[],
            user_id=user["user_id"],
            user_email=user["email"],
            source="test_commit",
            commit_message="Reworked team sheet",
        )

        self.assertEqual(1, result["version"])
        self.assertEqual(1, result["changed_updates"])
        self.assertEqual(1, result["inserted_count"])
        self.assertEqual(1, result["deleted_count"])
        self.assertEqual(["NOTES"], result["columns_added"])
        snapshot = database.get_table_snapshot("QUEUE_BOARD_TEST")
        self.assertEqual(2, snapshot["total"])
        self.assertIn("NOTES", snapshot["columns"])
        rows = {row[0]: row for row in snapshot["rows"]}
        self.assertNotIn(2, rows)
        self.assertEqual("SRH", rows[1][1])
        inserted = rows[result["inserted_row_ids"][0]]
        self.assertEqual("GT", inserted[1])
        self.assertEqual("new row", inserted[3])
        original = database.get_table_snapshot("QUEUE_BOARD_TEST", version=0)
        self.assertEqual(2, original["total"])
        self.assertNotIn("NOTES", original["columns"])
        self.assertEqual("KKR", original["rows"][0][1])
        statuses = {item["status"] for item in database.get_audit_history("QUEUE_BOARD_TEST")}
        self.assertTrue({"UPDATED", "INSERTED", "DELETED", "COLUMN_ADDED"}.issubset(statuses))

    def test_workbook_commit_rejects_stale_base_version(self):
        user = self._registered_user()
        common = {
            "table_id": "QUEUE_BOARD_TEST",
            "insert_rows": [],
            "delete_row_ids": [],
            "new_columns": [],
            "delete_columns": [],
            "user_id": user["user_id"],
            "user_email": user["email"],
            "source": "test_commit",
            "commit_message": "Versioned edit",
        }
        database.apply_workbook_commit(
            base_version=0,
            updates=[{"row_id": 1, "column_name": "BATTING_TEAM", "new_value": "SRH"}],
            **common,
        )

        with self.assertRaises(database.VersionConflictError) as raised:
            database.apply_workbook_commit(
                base_version=0,
                updates=[{"row_id": 1, "column_name": "BATTING_TEAM", "new_value": "GT"}],
                **common,
            )

        self.assertEqual(1, raised.exception.current_version)
        self.assertEqual("SRH", database.read_cell("QUEUE_BOARD_TEST", "BATTING_TEAM", 1))

    def test_workbook_change_set_rollback_restores_rows_and_schema(self):
        user = self._registered_user()
        committed = database.apply_workbook_commit(
            table_id="QUEUE_BOARD_TEST",
            base_version=0,
            updates=[{"row_id": 1, "column_name": "BATTING_TEAM", "new_value": "SRH"}],
            insert_rows=[{"BATTING_TEAM": "GT", "NOTES": "temporary"}],
            delete_row_ids=[2],
            new_columns=["NOTES"],
            delete_columns=[],
            user_id=user["user_id"],
            user_email=user["email"],
            source="test_commit",
            commit_message="Temporary restructuring",
        )
        reverted = database.rollback_batch(
            "QUEUE_BOARD_TEST", committed["batch_id"], user["user_id"], user["email"]
        )

        restored = database.get_table_snapshot("QUEUE_BOARD_TEST")
        self.assertEqual(2, reverted["version"])
        self.assertEqual(0, reverted["restored_version"])
        self.assertEqual(["ROW_ID", "BATTING_TEAM", "BOWLING_TEAM"], restored["columns"])
        self.assertEqual([[1, "KKR", "RCB"], [2, "CSK", "MI"]], restored["rows"])

    def test_presence_tracks_and_removes_active_dataset_user(self):
        user = self._registered_user()
        database.touch_dataset_presence(
            "QUEUE_BOARD_TEST", user["user_id"], "browser_client_123", "browser", "viewing"
        )
        active = database.list_active_presence("QUEUE_BOARD_TEST")
        self.assertEqual(1, len(active))
        self.assertEqual(user["user_id"], active[0]["user_id"])
        self.assertEqual(["browser"], active[0]["surfaces"])

        database.remove_dataset_presence(
            "QUEUE_BOARD_TEST", user["user_id"], "browser_client_123"
        )
        self.assertEqual([], database.list_active_presence("QUEUE_BOARD_TEST"))

    def test_user_ai_key_is_encrypted_at_rest_and_round_trips(self):
        user = self._registered_user()
        raw_key = "sk-or-v1-test-secret-value"
        encrypted = encrypt_secret(raw_key)
        database.save_user_ai_settings(user["user_id"], encrypted, "vendor/model")

        stored = database.get_user_ai_settings(user["user_id"])
        self.assertNotIn(raw_key, stored["api_key_encrypted"])
        self.assertEqual(raw_key, decrypt_secret(stored["api_key_encrypted"]))
        self.assertEqual("vendor/model", stored["model"])


if __name__ == "__main__":
    unittest.main()
