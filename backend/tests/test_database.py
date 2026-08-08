import sqlite3
import tempfile
import unittest
from pathlib import Path

from app import database


class DatabaseSyncTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.original_db_path = database.DB_PATH
        database.DB_PATH = Path(self.temp_dir.name) / "queue_board.db"

        conn = sqlite3.connect(database.DB_PATH)
        conn.execute(
            'CREATE TABLE "QUEUE_BOARD_TEST" ('
            'ROW_ID INTEGER PRIMARY KEY, "BATTING_TEAM" TEXT)'
        )
        conn.execute(
            'INSERT INTO "QUEUE_BOARD_TEST" (ROW_ID, "BATTING_TEAM") '
            "VALUES (1, 'KKR')"
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


if __name__ == "__main__":
    unittest.main()
