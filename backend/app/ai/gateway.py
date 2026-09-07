"""Capability routing, structured validation, cache, quota, and request ledger."""

from __future__ import annotations

import hashlib
import json
import re
import time
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any

from pydantic import BaseModel, Field, ValidationError

from .. import database
from ..config import settings
from ..secret_store import decrypt_secret
from ..services.semantic_ledger_service import ledger_for_connection
from .catalog import is_free_nvidia_model_id, supports_structured_output
from .provider import AIProviderError, LLMProvider, ProviderResult, providers


def _id(prefix: str) -> str: return f"{prefix}_{uuid.uuid4().hex[:18].upper()}"
def _hash(value: Any) -> str: return hashlib.sha256(json.dumps(value, sort_keys=True, default=str, separators=(",", ":")).encode()).hexdigest()


class EvidenceReference(BaseModel):
    type: str = Field(min_length=1, max_length=60)
    id: str = Field(min_length=1, max_length=180)


class RecommendedAction(BaseModel):
    title: str = Field(min_length=1, max_length=240)
    rationale: str = Field(min_length=1, max_length=1000)
    action_type: str = Field(default="REVIEW", max_length=80)
    risk_level: str = Field(default="LOW", pattern="^(LOW|MEDIUM|HIGH|CRITICAL)$")


class GroundedAnswer(BaseModel):
    answer: str = Field(min_length=1, max_length=12000)
    evidence: list[EvidenceReference] = Field(default_factory=list, max_length=100)
    confidence: float = Field(default=0.0, ge=0, le=1)
    insufficient_evidence: bool = False
    recommended_actions: list[RecommendedAction] = Field(default_factory=list, max_length=20)
    warnings: list[str] = Field(default_factory=list, max_length=20)


GROUNDED_ANSWER_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "answer": {"type": "string"},
        "evidence": {
            "type": "array",
            "items": {
                "type": "object", "additionalProperties": False,
                "properties": {"type": {"type": "string"}, "id": {"type": "string"}},
                "required": ["type", "id"],
            },
        },
        "confidence": {"type": "number", "minimum": 0, "maximum": 1},
        "insufficient_evidence": {"type": "boolean"},
        "recommended_actions": {
            "type": "array",
            "items": {
                "type": "object", "additionalProperties": False,
                "properties": {
                    "title": {"type": "string"}, "rationale": {"type": "string"},
                    "action_type": {"type": "string"},
                    "risk_level": {"type": "string", "enum": ["LOW", "MEDIUM", "HIGH", "CRITICAL"]},
                },
                "required": ["title", "rationale", "action_type", "risk_level"],
            },
        },
        "warnings": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["answer", "evidence", "confidence", "insufficient_evidence", "recommended_actions", "warnings"],
}


class StructuredOutputService:
    @staticmethod
    def parse(raw: str) -> GroundedAnswer:
        candidate = raw.strip()
        if candidate.startswith("```"):
            candidate = re.sub(r"^```(?:json)?\s*|\s*```$", "", candidate, flags=re.IGNORECASE)
        try:
            return GroundedAnswer.model_validate_json(candidate)
        except ValidationError:
            start = candidate.find("{"); end = candidate.rfind("}")
            if start >= 0 and end > start:
                return GroundedAnswer.model_validate_json(candidate[start:end + 1])
            raise

    @staticmethod
    def safe_fallback(raw: str) -> GroundedAnswer | None:
        candidate = re.sub(r"<think>.*?</think>", "", raw or "", flags=re.DOTALL | re.IGNORECASE).strip()
        candidate = re.sub(r"^```(?:json|markdown)?\s*|\s*```$", "", candidate, flags=re.IGNORECASE).strip()
        if not candidate:
            return None
        return GroundedAnswer(
            answer=candidate[:12000], evidence=[], confidence=0,
            insufficient_evidence=True, recommended_actions=[],
            warnings=["The free model returned an unstructured answer. Treat it as advisory until evidence citations are available."],
        )


@dataclass(frozen=True)
class ModelRoute:
    model_id: str
    provider: str
    model_slug: str
    prompt_version_id: str
    system_prompt: str
    user_template: str
    temperature: float
    max_input_tokens: int
    max_output_tokens: int


class AIGateway:
    def __init__(self, provider_overrides: dict[str, LLMProvider] | None = None):
        self.providers = provider_overrides or providers

    @staticmethod
    def credentials(user_id: str) -> tuple[str, str | None]:
        stored = database.get_user_ai_settings(user_id)
        if stored:
            try: return decrypt_secret(stored["api_key_encrypted"]), stored["model"]
            except ValueError as exc: raise AIProviderError("AI_CREDENTIAL_DECRYPTION_FAILED", "Saved AI credentials cannot be decrypted") from exc
        return settings.openrouter_api_key, None

    def route(self, conn, organization_id: str, user_id: str, feature: str, classification: str = "INTERNAL",
              requested_model: str | None = None) -> ModelRoute:
        org = conn.execute("SELECT * FROM AI_ORGANIZATION_SETTINGS WHERE ORGANIZATION_ID=?", (organization_id,)).fetchone()
        if org and not org["AI_ENABLED"]: raise PermissionError("AI is disabled for this organization")
        if org and not org["EXTERNAL_AI_ENABLED"]: raise PermissionError("External AI providers are disabled for this organization")
        allowed = json.loads(org["ALLOWED_CLASSIFICATIONS_JSON"]) if org else ["PUBLIC", "INTERNAL", "CONFIDENTIAL"]
        if classification.upper() not in allowed: raise PermissionError(f"AI access is not allowed for {classification} data")
        policy = conn.execute("SELECT * FROM AI_MODEL_POLICIES WHERE ORGANIZATION_ID=? AND FEATURE=? AND STATUS='ACTIVE'", (organization_id, feature)).fetchone()
        if policy:
            policy_classifications = json.loads(policy["ALLOWED_CLASSIFICATIONS_JSON"])
            if classification.upper() not in policy_classifications:
                raise PermissionError(f"The {feature} model policy excludes {classification} data")
        user_key, user_model = self.credentials(user_id); model_slug = requested_model or user_model
        if model_slug and not is_free_nvidia_model_id(model_slug):
            raise AIProviderError(
                "AI_MODEL_NOT_ALLOWED",
                "Git Walk only permits free NVIDIA OpenRouter models.",
            )
        if policy and policy["MODEL_ID"]:
            model = conn.execute("SELECT * FROM AI_MODELS WHERE MODEL_ID=? AND ENABLED=1", (policy["MODEL_ID"],)).fetchone()
            if requested_model and model and requested_model != model["MODEL_SLUG"]:
                raise PermissionError("The requested model is not allowed by the active feature policy")
        elif model_slug:
            model = conn.execute("SELECT * FROM AI_MODELS WHERE MODEL_SLUG=? AND ENABLED=1", (model_slug,)).fetchone()
            if not model and user_key:
                now = database._utcnow(); model_id = _id("AIM")
                conn.execute("INSERT INTO AI_MODELS VALUES (?, 'OPENROUTER',?,?, 'REASONING','[\"CHAT\"]',NULL,0,0,1,0,1,50,?,?)",
                             (model_id, model_slug, model_slug, now, now))
                model = conn.execute("SELECT * FROM AI_MODELS WHERE MODEL_ID=?", (model_id,)).fetchone()
        else:
            role = policy["MODEL_ROLE"] if policy else ("FAST" if feature in {"SUMMARY", "CLASSIFICATION"} else "REASONING")
            model = conn.execute("SELECT * FROM AI_MODELS WHERE MODEL_ROLE=? AND ENABLED=1 ORDER BY PRIORITY LIMIT 1", (role,)).fetchone()
            if not model: model = conn.execute("SELECT * FROM AI_MODELS WHERE ENABLED=1 ORDER BY PRIORITY LIMIT 1").fetchone()
        if not model: raise AIProviderError("AI_MODEL_UNAVAILABLE", "No enabled AI model satisfies this request")
        if not is_free_nvidia_model_id(model["MODEL_SLUG"]):
            raise AIProviderError(
                "AI_MODEL_NOT_ALLOWED",
                "The active route is not a free NVIDIA OpenRouter model.",
            )
        if policy and model["MODEL_ROLE"] != policy["MODEL_ROLE"]:
            raise PermissionError("The selected model does not satisfy the active feature capability policy")
        if policy and not policy["ALLOW_EXTERNAL"] and model["PROVIDER"] != "LOCAL":
            raise PermissionError("The active feature policy does not permit an external model")
        prompt = conn.execute("""SELECT V.* FROM AI_PROMPT_VERSIONS V JOIN AI_PROMPT_TEMPLATES T ON T.TEMPLATE_ID=V.TEMPLATE_ID
                                 WHERE T.PROMPT_KEY='GROUNDED_ENTERPRISE_COPILOT' AND V.STATUS='ACTIVE' ORDER BY V.CREATED_AT DESC LIMIT 1""").fetchone()
        if not prompt: raise AIProviderError("AI_PROMPT_UNAVAILABLE", "The governed prompt is not configured")
        return ModelRoute(model["MODEL_ID"], model["PROVIDER"], model["MODEL_SLUG"], prompt["PROMPT_VERSION_ID"],
                          prompt["SYSTEM_PROMPT"], prompt["USER_TEMPLATE"], float(policy["TEMPERATURE"] if policy else prompt["TEMPERATURE"]),
                          int(policy["MAX_INPUT_TOKENS"] if policy else 24000), int(policy["MAX_OUTPUT_TOKENS"] if policy else prompt["MAX_OUTPUT_TOKENS"]))

    @staticmethod
    def enforce_quota(conn, organization_id: str, user_id: str) -> None:
        now = datetime.now(timezone.utc); day = now.replace(hour=0, minute=0, second=0, microsecond=0).isoformat()
        settings_row = conn.execute("SELECT * FROM AI_ORGANIZATION_SETTINGS WHERE ORGANIZATION_ID=?", (organization_id,)).fetchone()
        org_quota = int(settings_row["DAILY_TOKEN_QUOTA"] if settings_row else 1_000_000)
        user_quota = int(settings_row["USER_DAILY_TOKEN_QUOTA"] if settings_row else 150_000)
        org_used = conn.execute("SELECT COALESCE(SUM(INPUT_TOKENS+OUTPUT_TOKENS+REASONING_TOKENS),0) FROM AI_TOKEN_LEDGER WHERE ORGANIZATION_ID=? AND CREATED_AT>=?", (organization_id, day)).fetchone()[0]
        user_used = conn.execute("SELECT COALESCE(SUM(INPUT_TOKENS+OUTPUT_TOKENS+REASONING_TOKENS),0) FROM AI_TOKEN_LEDGER WHERE ORGANIZATION_ID=? AND USER_ID=? AND CREATED_AT>=?", (organization_id, user_id, day)).fetchone()[0]
        if org_used >= org_quota: raise AIProviderError("AI_ORGANIZATION_QUOTA_EXCEEDED", "Organization daily AI token quota is exhausted")
        if user_used >= user_quota: raise AIProviderError("AI_USER_QUOTA_EXCEEDED", "User daily AI token quota is exhausted")

    async def generate(self, *, organization_id: str, user_id: str, feature: str, question: str,
                       evidence: list[dict[str, Any]], context_hash: str, conversation_id: str | None = None,
                       requested_model: str | None = None, classification: str = "INTERNAL") -> dict[str, Any]:
        request_started = time.perf_counter()
        conn = database._get_connection(); now = database._utcnow(); request_id = _id("AIRQ")
        try:
            self.enforce_quota(conn, organization_id, user_id)
            route = self.route(conn, organization_id, user_id, feature, classification, requested_model)
            input_hash = _hash({"question": question}); query_hash = _hash(question.strip().lower())
            cache_key = _hash({"model": route.model_id, "prompt": route.prompt_version_id, "context": context_hash, "query": query_hash})
            cached = conn.execute("SELECT * FROM AI_RESPONSE_CACHE WHERE CACHE_KEY=? AND EXPIRES_AT>?", (cache_key, now)).fetchone()
            conn.execute("""INSERT INTO AI_REQUESTS
                (AI_REQUEST_ID,ORGANIZATION_ID,USER_ID,CONVERSATION_ID,FEATURE,MODEL_ID,PROMPT_VERSION_ID,INPUT_HASH,CONTEXT_HASH,STATUS,CREATED_AT)
                VALUES (?,?,?,?,?,?,?,?,?,'RUNNING',?)""", (request_id, organization_id, user_id, conversation_id, feature, route.model_id, route.prompt_version_id, input_hash, context_hash, now))
            for ordinal, item in enumerate(evidence):
                conn.execute("INSERT OR IGNORE INTO AI_REQUEST_CONTEXT_REFS VALUES (?,?,?,?,?,?,?)",
                             (request_id, item["type"], item["id"], item.get("source_hash"), item.get("freshness_at"), item.get("classification", "INTERNAL"), ordinal))
            if cached:
                answer = ledger_for_connection(conn).objects.get(conn, cached["RESPONSE_OBJECT_HASH"])
                cache_latency = (time.perf_counter() - request_started) * 1000
                conn.execute("UPDATE AI_RESPONSE_CACHE SET LAST_HIT_AT=?,HIT_COUNT=HIT_COUNT+1 WHERE CACHE_KEY=?", (now, cache_key))
                conn.execute("UPDATE AI_REQUESTS SET STATUS='COMPLETED',CACHE_HIT=1,LATENCY_MS=?,RETRIEVAL_HITS=?,OUTPUT_VALID=1,GROUNDING_CONFIDENCE=?,COMPLETED_AT=? WHERE AI_REQUEST_ID=?",
                             (cache_latency, len(evidence), answer.get("confidence", 0), now, request_id)); conn.commit()
                return {
                    **answer, "ai_request_id": request_id, "model": route.model_slug,
                    "cache_hit": True, "latency_ms": round(cache_latency, 2),
                    "usage": {"input_tokens": 0, "output_tokens": 0, "reasoning_tokens": 0},
                }
            conn.commit()
        finally: conn.close()
        api_key, _ = self.credentials(user_id); provider = self.providers.get(route.provider)
        if not provider: raise AIProviderError("AI_PROVIDER_UNAVAILABLE", f"Provider {route.provider} is not installed")
        evidence_payload = json.dumps(evidence, sort_keys=True, default=str, separators=(",", ":"))
        messages = [{"role": "system", "content": route.system_prompt},
                    {"role": "user", "content": route.user_template.format(question=question, evidence=evidence_payload)}]
        started = time.perf_counter(); provider_result: ProviderResult | None = None; parsed: GroundedAnswer | None = None; error: Exception | None = None
        for attempt in range(3):
            try:
                provider_result = await provider.complete(api_key=api_key, model=route.model_slug, messages=messages,
                                                          temperature=route.temperature, max_tokens=route.max_output_tokens,
                                                          response_schema=(
                                                              GROUNDED_ANSWER_SCHEMA
                                                              if supports_structured_output(route.model_slug) else None
                                                          ))
                parsed = StructuredOutputService.parse(provider_result.content); error = None; break
            except (ValidationError, json.JSONDecodeError) as exc:
                error = exc
                messages.append({"role": "assistant", "content": provider_result.content if provider_result else ""})
                messages.append({"role": "user", "content": "Repair the previous output. Return one valid JSON object matching the required contract and nothing else."})
            except AIProviderError as exc:
                error = exc
                if not exc.transient or attempt == 2: break
        if not parsed and provider_result:
            parsed = StructuredOutputService.safe_fallback(provider_result.content)
            if parsed:
                error = None
        latency = (time.perf_counter() - started) * 1000; conn = database._get_connection(); completed = database._utcnow()
        try:
            if not parsed or not provider_result:
                code = error.code if isinstance(error, AIProviderError) else "AI_OUTPUT_INVALID"
                conn.execute("UPDATE AI_REQUESTS SET STATUS='FAILED',LATENCY_MS=?,ERROR_CODE=?,OUTPUT_VALID=0,COMPLETED_AT=? WHERE AI_REQUEST_ID=?", (latency, code, completed, request_id)); conn.commit()
                if isinstance(error, AIProviderError): raise error
                raise AIProviderError("AI_OUTPUT_INVALID", "The model did not return a valid grounded response")
            allowed_refs = {(item["type"], item["id"]) for item in evidence}; valid_refs = [ref for ref in parsed.evidence if (ref.type, ref.id) in allowed_refs]
            invalid_count = len(parsed.evidence) - len(valid_refs); retrieval_quality = min(1.0, len(evidence) / 4) if evidence else 0.0
            citation_coverage = min(1.0, len(valid_refs) / max(1, min(len(evidence), 4)))
            grounding = round((retrieval_quality * .45) + (citation_coverage * .55), 3)
            insufficient = parsed.insufficient_evidence or not evidence or grounding < .35
            warnings = list(parsed.warnings)
            if invalid_count: warnings.append(f"Removed {invalid_count} unverified evidence reference(s).")
            answer = {**parsed.model_dump(), "evidence": [ref.model_dump() for ref in valid_refs], "confidence": grounding,
                      "insufficient_evidence": insufficient, "warnings": warnings}
            stored = ledger_for_connection(conn).objects.put(conn, "AI_GROUNDED_RESPONSE", answer)
            expires = (datetime.now(timezone.utc) + timedelta(hours=6)).isoformat()
            conn.execute("INSERT OR REPLACE INTO AI_RESPONSE_CACHE VALUES (?,?,?,?,?,?,?,?,?,NULL,0)",
                         (cache_key, route.model_id, route.prompt_version_id, context_hash, query_hash, stored["object_hash"], json.dumps(answer["evidence"]), completed, expires))
            conn.execute("""UPDATE AI_REQUESTS SET STATUS='COMPLETED',LATENCY_MS=?,INPUT_TOKENS=?,OUTPUT_TOKENS=?,REASONING_TOKENS=?,
                            RETRIEVAL_HITS=?,TOOL_CALL_COUNT=?,OUTPUT_VALID=1,GROUNDING_CONFIDENCE=?,COMPLETED_AT=? WHERE AI_REQUEST_ID=?""",
                         (latency, provider_result.input_tokens, provider_result.output_tokens, provider_result.reasoning_tokens,
                          len(evidence), len(provider_result.tool_calls), grounding, completed, request_id))
            conn.execute("INSERT INTO AI_TOKEN_LEDGER VALUES (?,?,?,?,?,?,?,?,?,0,?)",
                         (_id("AITL"), request_id, organization_id, user_id, feature, route.model_id, provider_result.input_tokens,
                          provider_result.output_tokens, provider_result.reasoning_tokens, completed))
            conn.commit()
            return {**answer, "ai_request_id": request_id, "model": route.model_slug, "cache_hit": False,
                    "latency_ms": round(latency, 2),
                    "usage": {"input_tokens": provider_result.input_tokens, "output_tokens": provider_result.output_tokens, "reasoning_tokens": provider_result.reasoning_tokens}}
        finally: conn.close()


ai_gateway = AIGateway()
