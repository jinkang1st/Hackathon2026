from typing import TypeVar

from openai.types.chat import ChatCompletion
from pydantic import BaseModel, ValidationError

from app.errors import ModelServiceError
from app.models import ChatMessage
from app.providers.nebius import NebiusProvider

T = TypeVar("T", bound=BaseModel)


class ChatResource:
    def __init__(self, completions: NebiusProvider):
        self.completions = completions


class ModelService:
    def __init__(self, provider: NebiusProvider):
        self.chat = ChatResource(provider)
        self.default_model = provider.settings.nebius_model

    async def generate_structured(
        self, messages: list[ChatMessage], schema: type[T]
    ) -> tuple[T, ChatCompletion]:
        completion = await self.chat.completions.create(
            model=self.default_model,
            messages=[message.model_dump() for message in messages],
            temperature=0,
            max_tokens=2048,
            store=False,
            stream=False,
            response_format={
                "type": "json_schema",
                "json_schema": {
                    "name": schema.__name__,
                    "strict": True,
                    "schema": schema.model_json_schema(),
                },
            },
        )
        if not completion.choices:
            raise ModelServiceError(
                "model_invalid_response", "The model returned no assessment results."
            )
        choice = completion.choices[0]
        if choice.message.refusal or choice.finish_reason == "content_filter":
            raise ModelServiceError(
                "model_refused",
                "The model could not assess this content. Review the operation manually.",
            )
        if choice.finish_reason != "stop":
            raise ModelServiceError(
                "model_incomplete",
                "The model output is incomplete. Retry or review the operation manually.",
            )
        if not choice.message.content:
            raise ModelServiceError(
                "model_invalid_response", "The model returned no assessment content."
            )
        try:
            result = schema.model_validate_json(choice.message.content)
        except ValidationError:
            raise ModelServiceError(
                "model_invalid_response",
                "The model output does not match the required schema. "
                "Review the operation manually.",
            ) from None
        return result, completion
