import json
from collections.abc import Iterable
from typing import Literal

from openai.types.chat import (
    ChatCompletionMessageParam,
    ChatCompletionToolChoiceOptionParam,
    ChatCompletionToolUnionParam,
)
from openai.types.chat.completion_create_params import ResponseFormat
from pydantic import BaseModel, ConfigDict, Field, field_serializer, model_validator


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)


def materialize(value):
    """SDK TypedDicts contain Iterable fields; eagerly validate them before forwarding."""
    if isinstance(value, dict):
        return {key: materialize(item) for key, item in value.items()}
    if isinstance(value, Iterable) and not isinstance(value, (str, bytes)):
        return [materialize(item) for item in value]
    return value


class ChatMessage(StrictModel):
    role: Literal["system", "developer", "user", "assistant"]
    content: str = Field(min_length=1, max_length=64_000)


class ChatRequest(StrictModel):
    model: str = Field(min_length=1, max_length=200)
    messages: list[ChatCompletionMessageParam] = Field(min_length=1, max_length=64)
    temperature: float | None = Field(default=None, ge=0, le=2)
    max_tokens: int | None = Field(default=None, ge=1, le=8192)
    max_completion_tokens: int | None = Field(default=None, ge=1, le=8192)
    response_format: ResponseFormat | None = None
    tools: list[ChatCompletionToolUnionParam] | None = Field(default=None, max_length=32)
    tool_choice: ChatCompletionToolChoiceOptionParam | None = None
    top_p: float | None = Field(default=None, ge=0, le=1)
    stop: str | list[str] | None = None
    stream: Literal[False] = False
    n: Literal[1] = 1
    store: Literal[False] = False

    @field_serializer("messages", "tools", "tool_choice", mode="plain")
    def serialize_sdk_iterables(self, value):
        # These fields were eagerly validated and materialized below. The SDK's
        # Iterable serializers otherwise expect one-shot generator wrappers.
        return value

    @model_validator(mode="after")
    def limit_total_content(self):
        self.messages = materialize(self.messages)
        self.tools = materialize(self.tools)
        self.tool_choice = materialize(self.tool_choice)
        if len(json.dumps(self.messages, ensure_ascii=False)) > 64_000:
            raise ValueError("Total message size exceeds 64000 characters")
        if self.max_tokens is not None and self.max_completion_tokens is not None:
            raise ValueError("Use max_tokens or max_completion_tokens, not both")
        for message in self.messages:
            content = message.get("content")
            if isinstance(content, list) and any(part.get("type") != "text" for part in content):
                raise ValueError("Only text messages are supported")
        return self


class TokenUsage(StrictModel):
    prompt_tokens: int = Field(ge=0)
    completion_tokens: int = Field(ge=0)
    total_tokens: int = Field(ge=0)
