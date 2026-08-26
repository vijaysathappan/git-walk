"""Provider-neutral LLM contract and OpenRouter implementation."""

from __future__ import annotations

import asyncio
import json
import urllib.error
import urllib.request
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any

from ..config import settings


class AIProviderError(RuntimeError):
    def __init__(self, code: str, message: str, *, transient: bool = False):
        self.code = code; self.transient = transient
        super().__init__(message)


@dataclass(frozen=True)
class ProviderResult:
    content: str
    input_tokens: int = 0
    output_tokens: int = 0
    reasoning_tokens: int = 0
    tool_calls: tuple[dict[str, Any], ...] = field(default_factory=tuple)
    provider_request_id: str | None = None


class LLMProvider(ABC):
    provider_name = "BASE"

    @abstractmethod
    async def complete(self, *, api_key: str, model: str, messages: list[dict[str, Any]],
                       temperature: float, max_tokens: int, tools: list[dict[str, Any]] | None = None) -> ProviderResult: ...


class OpenRouterProvider(LLMProvider):
    provider_name = "OPENROUTER"

    async def complete(self, *, api_key: str, model: str, messages: list[dict[str, Any]],
                       temperature: float, max_tokens: int, tools: list[dict[str, Any]] | None = None) -> ProviderResult:
        if not api_key:
            raise AIProviderError("AI_PROVIDER_NOT_CONFIGURED", "Connect an OpenRouter API key in AI Administration")
        body: dict[str, Any] = {"model": model, "messages": messages, "temperature": temperature, "max_tokens": max_tokens}
        if tools: body["tools"] = tools

        def send() -> ProviderResult:
            request = urllib.request.Request(
                "https://openrouter.ai/api/v1/chat/completions",
                data=json.dumps(body, default=str).encode("utf-8"), method="POST",
                headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json",
                         "HTTP-Referer": settings.app_url, "X-Title": "Git Walk"},
            )
            try:
                with urllib.request.urlopen(request, timeout=60) as response:
                    result = json.loads(response.read().decode("utf-8"))
            except urllib.error.HTTPError as exc:
                code = "AI_RATE_LIMITED" if exc.code == 429 else "AI_PROVIDER_AUTHENTICATION_FAILED" if exc.code in {401, 403} else "AI_PROVIDER_FAILURE"
                raise AIProviderError(code, f"OpenRouter returned HTTP {exc.code}", transient=exc.code == 429 or exc.code >= 500) from exc
            except (urllib.error.URLError, TimeoutError) as exc:
                raise AIProviderError("AI_PROVIDER_UNREACHABLE", "OpenRouter could not be reached", transient=True) from exc
            try:
                message = result["choices"][0]["message"]; usage = result.get("usage") or {}
                details = usage.get("completion_tokens_details") or {}
                return ProviderResult(
                    content=message.get("content") or "", input_tokens=int(usage.get("prompt_tokens") or 0),
                    output_tokens=int(usage.get("completion_tokens") or 0), reasoning_tokens=int(details.get("reasoning_tokens") or 0),
                    tool_calls=tuple(message.get("tool_calls") or ()), provider_request_id=result.get("id"),
                )
            except (KeyError, IndexError, TypeError, ValueError) as exc:
                raise AIProviderError("AI_PROVIDER_RESPONSE_INVALID", "OpenRouter returned an invalid response") from exc
        return await asyncio.to_thread(send)


providers: dict[str, LLMProvider] = {"OPENROUTER": OpenRouterProvider()}
