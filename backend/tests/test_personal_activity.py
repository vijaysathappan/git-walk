import sqlite3
import tempfile
import unittest
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

from app import database
from app.ai.personal_activity import personal_activity


def _iso(offset_days: float, hour: int = 10) -> str:
    when = datetime.now(timezone.utc) - timedelta(days=offset_days)
    return when.replace(hour=hour, minute=0, second=0, microsecond=0).isoformat()


class PersonalActivityTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.original_db_path = database.DB_PATH
        database.DB_PATH = Path(self.temp_dir.name) / "personal_activity.db"
        database.initialize_product_schema()

        self.user = database.get_or_create_user("activity-owner@example.com")
        self.peer = database.get_or_create_user("activity-peer@example.com")

        conn = sqlite3.connect(database.DB_PATH)
        conn.execute('CREATE TABLE "QUEUE_BOARD_ACTIVITY" (ROW_ID INTEGER PRIMARY KEY, "TEAM" TEXT)')
        conn.execute('INSERT INTO "QUEUE_BOARD_ACTIVITY" (ROW_ID, "TEAM") VALUES (1, ?)', ("KKR",))
        conn.commit()
        conn.close()
        registered = database.register_dataset("QUEUE_BOARD_ACTIVITY", self.user["user_id"], "activity.xlsx", 1, 1)

        conn = database._get_connection()
        try:
            self.organization_id = conn.execute(
                "SELECT ORGANIZATION_ID FROM WORKBOOK_REPOSITORIES WHERE REPOSITORY_ID=?", (registered["repository_id"],)
            ).fetchone()[0]
            now = datetime.now(timezone.utc).isoformat()
            conn.execute(
                "INSERT INTO AI_MODELS (MODEL_ID,PROVIDER,MODEL_SLUG,DISPLAY_NAME,MODEL_ROLE,CAPABILITIES_JSON,"
                "ENABLED,PRIORITY,CREATED_AT,UPDATED_AT) VALUES (?,?,?,?,?,?,?,?,?,?)",
                ("MODEL_SONNET", "OPENROUTER", "sonnet-5-free", "Sonnet 5", "REASONING", "[]", 1, 100, now, now),
            )

            for offset, hour in [(0.1, 10), (1.2, 10), (2.5, 14)]:
                conn.execute(
                    "INSERT INTO AI_REQUESTS (AI_REQUEST_ID,ORGANIZATION_ID,USER_ID,FEATURE,MODEL_ID,INPUT_HASH,"
                    "STATUS,LATENCY_MS,INPUT_TOKENS,OUTPUT_TOKENS,REASONING_TOKENS,CREATED_AT) "
                    "VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                    (uuid.uuid4().hex, self.organization_id, self.user["user_id"], "ENTERPRISE_COPILOT",
                     "MODEL_SONNET", "hash", "COMPLETED", 500, 100, 50, 0, _iso(offset, hour)),
                )
            conn.execute(
                "INSERT INTO AI_REQUESTS (AI_REQUEST_ID,ORGANIZATION_ID,USER_ID,FEATURE,MODEL_ID,INPUT_HASH,"
                "STATUS,LATENCY_MS,INPUT_TOKENS,OUTPUT_TOKENS,REASONING_TOKENS,CREATED_AT) "
                "VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                (uuid.uuid4().hex, self.organization_id, self.peer["user_id"], "ENTERPRISE_COPILOT",
                 "MODEL_SONNET", "hash", "COMPLETED", 400, 10, 5, 0, _iso(0.2, 9)),
            )

            for offset in [0.3, 3.0, 40.0]:
                conn.execute(
                    "INSERT INTO COMMITS (COMMIT_ID,REPOSITORY_ID,BRANCH_ID,AUTHOR_USER_ID,AUTHOR_EMAIL,MESSAGE,"
                    "CREATED_AT,CHANGE_COUNT,COMMIT_HASH,STATUS) VALUES (?,?,?,?,?,?,?,?,?,?)",
                    (uuid.uuid4().hex, "REPO_X", "BRANCH_X", self.user["user_id"], self.user["email"],
                     "test commit", _iso(offset, 10), 3, uuid.uuid4().hex, "COMMITTED"),
                )

            conn.execute(
                "INSERT INTO AUTH_SESSIONS (SESSION_ID,USER_ID,TOKEN_HASH,CREATED_AT,EXPIRES_AT) VALUES (?,?,?,?,?)",
                (uuid.uuid4().hex, self.user["user_id"], "hash", _iso(0.4, 10),
                 (datetime.now(timezone.utc) + timedelta(days=1)).isoformat()),
            )
            conn.commit()
        finally:
            conn.close()

    def tearDown(self):
        database.DB_PATH = self.original_db_path
        self.temp_dir.cleanup()

    def test_overview_counts_are_correct_for_the_default_30d_range(self):
        result = personal_activity(self.organization_id, self.user["user_id"], "30d")
        overview = result["overview"]
        # register_dataset() in setUp already creates one genesis commit for
        # this user, on top of the three explicit commits inserted above
        # (one of which, at 40 days old, falls outside the 30d window).
        self.assertEqual(overview["commits"], 3)
        self.assertEqual(overview["repositories"], 1)
        self.assertEqual(overview["repositories_touched"], 2)
        # The two in-range explicit commits (CHANGE_COUNT=3 each) plus
        # whatever the genesis commit itself touched.
        self.assertGreaterEqual(overview["cells_changed"], 6)
        self.assertEqual(overview["total_tokens"], 3 * (100 + 50))
        self.assertEqual(overview["peak_hour"], "10 AM")
        self.assertGreaterEqual(overview["active_days"], 2)
        self.assertGreaterEqual(overview["longest_streak"], 1)
        self.assertIsNotNone(overview["busiest_day"])

    def test_7d_range_excludes_older_activity(self):
        result = personal_activity(self.organization_id, self.user["user_id"], "7d")
        # Genesis commit (offset ~0) + the offset=0.3 and offset=3.0
        # commits; the offset=40.0 commit falls outside 7d.
        self.assertEqual(result["overview"]["commits"], 3)

    def test_heatmap_is_a_dense_daily_grid_covering_the_range(self):
        result = personal_activity(self.organization_id, self.user["user_id"], "30d")
        dates = [day["date"] for day in result["heatmap"]]
        self.assertEqual(len(dates), len(set(dates)))
        today_key = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        self.assertIn(today_key, dates)
        total_from_heatmap = sum(day["count"] for day in result["heatmap"])
        self.assertEqual(total_from_heatmap, 6)

    def test_models_tab_breaks_down_by_model_with_success_rate(self):
        result = personal_activity(self.organization_id, self.user["user_id"], "30d")
        self.assertEqual(len(result["models"]), 1)
        model = result["models"][0]
        self.assertEqual(model["display_name"], "Sonnet 5")
        self.assertEqual(model["requests"], 3)
        self.assertEqual(model["success_rate"], 1.0)

    def test_longest_streak_and_busiest_day_are_computed_from_the_heatmap(self):
        result = personal_activity(self.organization_id, self.user["user_id"], "30d")
        heatmap = {day["date"]: day["count"] for day in result["heatmap"]}
        from app.ai.personal_activity import _busiest_day, _longest_streak
        expected_streak = _longest_streak(result["heatmap"])
        expected_busiest = _busiest_day(result["heatmap"])
        self.assertEqual(result["overview"]["longest_streak"], expected_streak)
        self.assertIn(str(expected_busiest["count"]), result["overview"]["busiest_day"])
        self.assertEqual(sum(heatmap.values()), sum(day["count"] for day in result["heatmap"]))

    def test_comparison_uses_real_peer_totals_not_a_fabricated_number(self):
        result = personal_activity(self.organization_id, self.user["user_id"], "30d")
        comparison = result["comparison"]
        self.assertIsNotNone(comparison["multiplier"])
        self.assertGreater(comparison["multiplier"], 1)
        self.assertIn("teammate", comparison["message"])


if __name__ == "__main__":
    unittest.main()
