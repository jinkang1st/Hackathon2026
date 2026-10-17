import asyncio
from collections.abc import Iterable
from typing import Any

import httpx
from openai import (
    APIConnectionError,
    APIResponseValidationError,
    APIStatusError,
    APITimeoutError,
    AsyncOpenAI,
    AuthenticationError,
    PermissionDeniedError,
    RateLimitError,
)
from openai.types.chat import ChatCompletion, ChatCompletionMessageParam
from pydantic import ValidationError

from app.config import Settings
from app.errors import ModelServiceError
from app.models import ChatRequest

RESPONSE_LANGUAGE_PROMPT = (
    "Write all generated explanations and user-facing text in English, regardless of the "
    "input language. Preserve required JSON keys, enum values, tool names, arguments derived "
    "from source data, and exact quoted source names or identifiers."
)


class NebiusProvider:
    """OpenAI-compatible completions resource; client lifecycle belongs to the app."""

    def __init__(self, settings: Settings, http_client: httpx.AsyncClient):
        self.settings = settings
        self.client = AsyncOpenAI(
            api_key=settings.nebius_api_key.get_secret_value().strip() or "not-configured",
            base_url=str(settings.nebius_base_url).rstrip("/") + "/",
            timeout=settings.nebius_timeout_seconds,
            max_retries=settings.nebius_max_retries,
            http_client=http_client,
            _strict_response_validation=True,
        )

    async def create(
        self,
        *,
        model: str,
        messages: Iterable[ChatCompletionMessageParam],
        **kwargs: Any,
    ) -> ChatCompletion:
        if not self.settings.nebius_api_key.get_secret_value().strip():
            raise ModelServiceError(
                "model_not_configured", "Configure NEBIUS_API_KEY on the server.", 503
            )
        try:
            request = ChatRequest(model=model, messages=list(messages), **kwargs)
        except ValidationError:
            raise ModelServiceError(
                "invalid_request", "The request uses unsupported parameters or capabilities.", 400
            ) from None
        params = request.model_dump(exclude_none=True)
        params["messages"] = [
            {"role": "system", "content": RESPONSE_LANGUAGE_PROMPT},
            *params["messages"],
        ]
        if request.max_tokens is None and request.max_completion_tokens is None:
            params["max_tokens"] = 2048
        # SDK handles transient retries; one deadline bounds all attempts and backoff.
        try:
            async with asyncio.timeout(self.settings.nebius_timeout_seconds):
                completion = await self.client.chat.completions.create(**params)
            return ChatCompletion.model_validate(completion.model_dump())
        except (TimeoutError, APITimeoutError):
            raise ModelServiceError(
                "model_timeout",
                "The model service timed out. Retry or review the operation manually.",
                504,
            ) from None
        except (AuthenticationError, PermissionDeniedError):
            raise ModelServiceError(
                "model_auth_failed",
                "Model service authentication failed. Check the server configuration.",
                503,
            ) from None
        except RateLimitError:
            raise ModelServiceError(
                "model_rate_limited",
                "The model service rate limit was reached. Try again later.",
                429,
            ) from None
        except APIConnectionError:
            raise ModelServiceError(
                "model_unavailable", "Unable to connect to the model service."
            ) from None
        except (APIResponseValidationError, ValidationError, ValueError, TypeError):
            raise ModelServiceError(
                "model_invalid_response", "The model service returned an invalid response."
            ) from None
        except APIStatusError:
            raise ModelServiceError(
                "model_upstream_error", "The model service could not complete the request."
            ) from None
