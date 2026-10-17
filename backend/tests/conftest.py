import json
from contextlib import asynccontextmanager

import httpx
import pytest
from pydantic import SecretStr

from app.config import Settings
from app.main import create_app, get_model_service
from app.providers.nebius import NebiusProvider
from app.services.model import ModelService


def completion(content="Hello", *, finish_reason="stop", refusal=None):
    return {
        "id": "chatcmpl-test",
        "object": "chat.completion",
        "created": 1792234800,
        "model": "test-model",
        "choices": [
            {
                "index": 0,
                "message": {"role": "assistant", "content": content, "refusal": refusal},
                "finish_reason": finish_reason,
            }
        ],
        "usage": {"prompt_tokens": 20, "completion_tokens": 10, "total_tokens": 30},
    }


def assessment(level="remind", evidence_ids=None):
    return completion(
        json.dumps(
            {
                "level": level,
                "reason": "Review the specific consequences of this operation.",
                "evidence_ids": ["action.amount"] if evidence_ids is None else evidence_ids,
            },
            ensure_ascii=False,
        )
    )


@pytest.fixture
def api():
    @asynccontextmanager
    async def build(handler, **overrides):
        defaults = {
            "nebius_api_key": SecretStr("test-nebius-secret"),
            "nebius_model": "test-model",
            "nebius_max_retries": 0,
        }
        settings = Settings(_env_file=None, **(defaults | overrides))
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as upstream:
            service = ModelService(NebiusProvider(settings, upstream))
            app = create_app(settings)
            app.dependency_overrides[get_model_service] = lambda: service
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=app),
                base_url="http://test",
            ) as client:
                yield client, service

    return build


@pytest.fixture
def purchase():
    return {
        "action": {"type": "purchase", "item": "包", "amount": "28000.00", "currency": "CNY"},
        "preferences": {
            "protected_actions": ["purchase"],
            "spending_reminder": {"threshold": "5000.00", "currency": "CNY"},
        },
    }


@pytest.fixture
def deletion():
    return {
        "action": {
            "type": "delete",
            "target": "待清理资料",
            "file_count": 3842,
            "important_items": ["毕业论文", "工作资料"],
            "permanent": True,
            "supports_trash": True,
        },
        "preferences": {"protected_actions": ["delete"]},
    }
