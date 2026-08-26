import json
import sqlite3
import tempfile
import unittest
from pathlib import Path

from app import database
from app.ai.gateway import AIGateway
from app.ai.provider import AIProviderError, LLMProvider, ProviderResult
from app.ai.service import AIService
from app.config import settings
from app.secret_store import encrypt_secret


class FakeProvider(LLMProvider):
    provider_name = "OPENROUTER"

    def __init__(self, evidence_id: str, invalid_first: bool = False):
        self.evidence_id = evidence_id
        self.invalid_first = invalid_first
        self.calls = 0

    async def complete(self, **kwargs) -> ProviderResult:
        self.calls += 1
        if self.invalid_first and self.calls == 1:
            return ProviderResult("not-json", 12, 3)
        content = json.dumps({
            "answer": "The repository evidence supports a controlled review.",
            "evidence": [
                {"type": "REPOSITORY", "id": self.evidence_id},
                {"type": "REPOSITORY", "id": "INVENTED_REFERENCE"},
            ],
            "confidence": 0.99,
            "insufficient_evidence": False,
            "recommended_actions": [{
                "title": "Review evidence", "rationale": "Keep policy and deterministic evidence authoritative.",
                "action_type": "REVIEW", "risk_level": "LOW",
            }],
            "warnings": [],
        })
        return ProviderResult(content, input_tokens=120, output_tokens=40, reasoning_tokens=10)


class Stage5AIPlatformTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.original_db_path = database.DB_PATH
        database.DB_PATH = Path(self.temp_dir.name) / "stage5.db"
        database.initialize_product_schema()
        self.owner = database.get_or_create_user("ai.owner@example.com")
        conn = sqlite3.connect(database.DB_PATH)
        conn.execute('CREATE TABLE "QUEUE_BOARD_AI" (ROW_ID INTEGER PRIMARY KEY, VALUE TEXT)')
        conn.execute('INSERT INTO "QUEUE_BOARD_AI" VALUES (1, "seed")')
        conn.commit(); conn.close()
        self.repository = database.register_dataset("QUEUE_BOARD_AI", self.owner["user_id"], "ai-governance.xlsx", 1, 1)
        conn = database._get_connection()
        self.organization_id = conn.execute(
            "SELECT ORGANIZATION_ID FROM WORKBOOK_REPOSITORIES WHERE REPOSITORY_ID=?", (self.repository["repository_id"],)
        ).fetchone()[0]
        conn.close()
        database.save_user_ai_settings(self.owner["user_id"], encrypt_secret("sk-or-test-stage5"), settings.openrouter_model)

    def tearDown(self):
        database.DB_PATH = self.original_db_path
        self.temp_dir.cleanup()

    def service(self, invalid_first: bool = False):
        provider = FakeProvider(self.repository["repository_id"], invalid_first)
        return AIService(AIGateway({"OPENROUTER": provider})), provider

    async def test_grounded_chat_repairs_output_filters_citations_and_records_usage(self):
        service, provider = self.service(invalid_first=True)
        result = await service.chat(self.organization_id, self.owner["user_id"], {
            "question": "Explain the repository control posture with evidence",
            "repository_id": self.repository["repository_id"],
            "resource_type": "REPOSITORY", "resource_id": self.repository["repository_id"],
        })
        self.assertEqual(2, provider.calls)
        self.assertEqual([self.repository["repository_id"]], [item["id"] for item in result["evidence"]])
        self.assertTrue(any("unverified" in warning for warning in result["warnings"]))
        self.assertGreater(result["confidence"], 0)
        conversation = service.conversations(self.organization_id, self.owner["user_id"], result["conversation_id"])
        self.assertEqual(["USER", "ASSISTANT"], [message["role"] for message in conversation["messages"]])
        usage = service.usage(self.organization_id, self.owner["user_id"])
        self.assertEqual(170, usage["tokens"]["total"])
        self.assertEqual(1, usage["requests"])

    async def test_cross_tenant_repository_is_denied_before_provider(self):
        outsider = database.get_or_create_user("ai.outsider@example.com")
        database.save_user_ai_settings(outsider["user_id"], encrypt_secret("sk-or-test-outsider"), settings.openrouter_model)
        service, provider = self.service()
        with self.assertRaises(PermissionError):
            await service.chat(self.organization_id, outsider["user_id"], {
                "question": "Read a repository I cannot access", "repository_id": self.repository["repository_id"],
            })
        self.assertEqual(0, provider.calls)

    async def test_quota_blocks_provider_and_agent_tools_are_audited(self):
        service, provider = self.service()
        conn = database._get_connection()
        now = database._utcnow()
        conn.execute("INSERT OR REPLACE INTO AI_ORGANIZATION_SETTINGS VALUES (?,1,1,'[\"PUBLIC\",\"INTERNAL\"]',1000,1000,1,90,?,?)",
                     (self.organization_id, self.owner["user_id"], now))
        conn.execute("INSERT INTO AI_TOKEN_LEDGER VALUES ('TOK_QUOTA','REQ_QUOTA',?,?, 'TEST',NULL,1000,0,0,0,?)",
                     (self.organization_id, self.owner["user_id"], now))
        conn.commit(); conn.close()
        with self.assertRaises(AIProviderError) as raised:
            await service.chat(self.organization_id, self.owner["user_id"], {"question": "This must be blocked by quota"})
        self.assertEqual("AI_ORGANIZATION_QUOTA_EXCEEDED", raised.exception.code)
        self.assertEqual(0, provider.calls)

        conn = database._get_connection()
        conn.execute("DELETE FROM AI_TOKEN_LEDGER WHERE LEDGER_ID='TOK_QUOTA'")
        conn.commit(); conn.close()
        run = await service.run_agent(self.organization_id, self.owner["user_id"], {
            "agent_key": "INVESTIGATION_AGENT", "goal": "Investigate the governed repository state",
            "repository_id": self.repository["repository_id"], "resource_type": "REPOSITORY",
            "resource_id": self.repository["repository_id"],
            "requested_action": {"action_type": "RUN_INTEGRATION", "connection_id": "CONNECTION_REQUIRES_REVIEW"},
        })
        self.assertEqual("WAITING_CONFIRMATION", run["status"])
        self.assertEqual("PENDING_CONFIRMATION", run["actions"][0]["status"])
        conn = database._get_connection()
        try:
            tool_call = conn.execute("SELECT STATUS,AUTHORIZATION_DECISION FROM AI_TOOL_CALLS WHERE AGENT_RUN_ID=?", (run["agent_run_id"],)).fetchone()
            self.assertEqual(("COMPLETED", "ALLOWED"), tuple(tool_call))
            action = conn.execute("SELECT STATUS,REQUIRED_PERMISSION FROM AI_ACTIONS WHERE AGENT_RUN_ID=?", (run["agent_run_id"],)).fetchone()
            self.assertEqual(("PENDING_CONFIRMATION", "integration.execute"), tuple(action))
        finally: conn.close()

    def test_controls_and_safety_evaluation_are_deterministic(self):
        service, _ = self.service()
        administration = service.administration(self.organization_id, self.owner["user_id"])
        model_id = administration["models"][0]["model_id"]
        policy = service.update_model_policy(self.organization_id, self.owner["user_id"], "ENTERPRISE_COPILOT", {
            "model_role": administration["models"][0]["model_role"], "model_id": model_id,
            "allow_external": True, "allowed_classifications": ["PUBLIC", "INTERNAL"],
            "max_input_tokens": 24000, "max_output_tokens": 3000, "temperature": 0.1,
        })
        self.assertEqual(model_id, policy["model_id"])
        controls = service.generate_controls(self.organization_id, self.owner["user_id"], self.repository["repository_id"])
        self.assertEqual(0, controls["generated"])
        evaluation = service.run_evaluation(self.organization_id, self.owner["user_id"])
        self.assertEqual("PASSED", evaluation["status"])
        self.assertEqual(evaluation["total_cases"], evaluation["passed_cases"])
        self.assertEqual(1, len(service.evaluations(self.organization_id, self.owner["user_id"])))


if __name__ == "__main__":
    unittest.main()
