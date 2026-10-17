import asyncio
import json

import httpx
import pytest
from conftest import completion
from openai import AsyncOpenAI, AuthenticationError
from pydantic import BaseModel, SecretStr

from app.config import Settings
from app.main import create_app
from app.providers.nebius import RESPONSE_LANGUAGE_PROMPT

CHAT = {"model": "test-model", "messages": [{"role": "user", "content": "你好"}]}


async def test_sdk_connects_to_local_backend_and_preserves_openai_envelope(api):
    calls = []

    def upstream(request):
        calls.append(request)
        assert request.url == "https://api.tokenfactory.nebius.com/v1/chat/completions"
        assert request.headers["Authorization"] == "Bearer test-nebius-secret"
        body = json.loads(request.content)
        assert body["messages"][0] == {"role": "system", "content": RESPONSE_LANGUAGE_PROMPT}
        assert body["messages"][1:] == CHAT["messages"]
        assert body["model"] == "test-model"
        assert body["store"] is False
        return httpx.Response(200, json=completion())

    async with api(upstream, firewall_api_token=SecretStr("local-token")) as (client, _):
        sdk = AsyncOpenAI(
            api_key="local-token",
            base_url="http://test/v1",
            http_client=client,
            max_retries=0,
        )
        result = await sdk.chat.completions.create(**CHAT)
        assert result.id == "chatcmpl-test"
        assert result.object == "chat.completion"
        assert result.created == 1792234800
        assert result.choices[0].message.content == "Hello"
        assert result.usage.total_tokens == 30
        listed = await sdk.models.list()
        assert listed.data[0].id == "test-model"
        assert len(calls) == 1


async def test_internal_interface_uses_sdk_call_shape_and_return_type(api):
    async with api(lambda _: httpx.Response(200, json=completion())) as (_, service):
        result = await service.chat.completions.create(**CHAT)
        assert result.choices[0].message.content == "Hello"


async def test_sdk_parse_uses_standard_json_schema(api):
    class Answer(BaseModel):
        summary: str

    def upstream(request):
        body = json.loads(request.content)
        assert body["response_format"]["json_schema"]["name"] == "Answer"
        return httpx.Response(200, json=completion('{"summary":"Reviewed"}'))

    async with api(upstream) as (client, _):
        sdk = AsyncOpenAI(api_key="local", base_url="http://test/v1", http_client=client)
        result = await sdk.chat.completions.parse(**CHAT, response_format=Answer)
        assert result.choices[0].message.parsed.summary == "Reviewed"


async def test_text_parts_and_tool_result_round_trip_preserves_content(api):
    messages = [
        {"role": "user", "content": [{"type": "text", "text": "  核对预算  "}]},
        {
            "role": "assistant",
            "tool_calls": [
                {
                    "id": "call_1",
                    "type": "function",
                    "function": {"name": "budget", "arguments": "{}"},
                }
            ],
        },
        {"role": "tool", "tool_call_id": "call_1", "content": "8000"},
    ]

    def upstream(request):
        assert json.loads(request.content)["messages"][1:] == messages
        return httpx.Response(200, json=completion())

    async with api(upstream) as (client, _):
        result = await client.post("/v1/chat/completions", json=CHAT | {"messages": messages})
        assert result.status_code == 200


async def test_response_format_and_tool_calls_are_forwarded(api):
    def upstream(request):
        body = json.loads(request.content)
        assert body["response_format"] == {"type": "json_object"}
        assert body["max_completion_tokens"] == 512
        assert "max_tokens" not in body
        assert body["tools"][0]["function"]["name"] == "check_budget"
        result = completion(None, finish_reason="tool_calls")
        result["choices"][0]["message"]["tool_calls"] = [
            {
                "id": "call_1",
                "type": "function",
                "function": {"name": "check_budget", "arguments": "{}"},
            }
        ]
        return httpx.Response(200, json=result)

    async with api(upstream) as (client, _):
        result = await client.post(
            "/v1/chat/completions",
            json=CHAT
            | {
                "response_format": {"type": "json_object"},
                "max_completion_tokens": 512,
                "tools": [
                    {
                        "type": "function",
                        "function": {
                            "name": "check_budget",
                            "parameters": {"type": "object", "properties": {}},
                        },
                    }
                ],
            },
        )
        assert result.status_code == 200
        assert result.json()["choices"][0]["finish_reason"] == "tool_calls"


@pytest.mark.parametrize(
    "fields",
    [
        {"stream": True},
        {"n": 2},
        {"store": True},
        {"temperature": 3},
        {"max_tokens": 5, "max_completion_tokens": 5},
        {"messages": [{"role": "user", "content": "x" * 64001}]},
        {
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "image_url",
                            "image_url": {"url": "https://example.com/image.png"},
                        }
                    ],
                }
            ]
        },
    ],
)
async def test_unsupported_or_invalid_input_returns_safe_validation_error(api, fields):
    def upstream(_):
        pytest.fail("Invalid input must not reach Nebius")

    async with api(upstream) as (client, _):
        result = await client.post("/v1/chat/completions", json=CHAT | fields)
        assert result.status_code == 400
        assert result.json()["error"]["type"] == "invalid_request_error"
        assert "messages" not in result.text


@pytest.mark.parametrize(
    "status,expected,code",
    [
        (401, 503, "model_auth_failed"),
        (403, 503, "model_auth_failed"),
        (429, 429, "model_rate_limited"),
        (500, 502, "model_upstream_error"),
        (400, 502, "model_upstream_error"),
    ],
)
async def test_upstream_errors_are_sanitized(api, status, expected, code):
    async with api(lambda _: httpx.Response(status, text="test-nebius-secret private draft")) as (
        client,
        _,
    ):
        result = await client.post("/v1/chat/completions", json=CHAT)
        assert result.status_code == expected
        assert result.json()["error"]["code"] == code
        assert result.json()["error"]["message"].isascii()
        assert "test-nebius-secret" not in result.text
        assert "private draft" not in result.text
        assert result.headers["X-Request-ID"]


async def test_sdk_raises_standard_authentication_error_for_backend_token(api):
    def upstream(_):
        pytest.fail("Unauthorized request must not reach Nebius")

    async with api(upstream, firewall_api_token=SecretStr("correct")) as (client, _):
        sdk = AsyncOpenAI(api_key="wrong", base_url="http://test/v1", http_client=client)
        with pytest.raises(AuthenticationError) as error:
            await sdk.chat.completions.create(**CHAT)
        assert error.value.code == "unauthorized"


async def test_missing_key_returns_503_without_network_call(api):
    def upstream(_):
        pytest.fail("Missing key must not reach Nebius")

    async with api(upstream, nebius_api_key=SecretStr("")) as (client, _):
        result = await client.post("/v1/chat/completions", json=CHAT)
        assert result.status_code == 503
        assert result.json()["error"]["code"] == "model_not_configured"


async def test_total_deadline_cancels_inference(api):
    async def upstream(_):
        await asyncio.sleep(1)
        return httpx.Response(200, json=completion())

    async with api(upstream, nebius_timeout_seconds=0.01) as (client, _):
        result = await client.post("/v1/chat/completions", json=CHAT)
        assert result.status_code == 504
        assert result.json()["error"]["code"] == "model_timeout"


async def test_transport_error(api):
    def upstream(request):
        raise httpx.ConnectError("secret connection details", request=request)

    async with api(upstream) as (client, _):
        result = await client.post("/v1/chat/completions", json=CHAT)
        assert result.status_code == 502
        assert result.json()["error"]["code"] == "model_unavailable"


async def test_sdk_retries_transient_error(api):
    calls = []

    def upstream(_):
        calls.append(1)
        if len(calls) == 1:
            return httpx.Response(503, headers={"retry-after-ms": "1"}, json={"error": {}})
        return httpx.Response(200, json=completion())

    async with api(upstream, nebius_max_retries=1) as (client, _):
        result = await client.post("/v1/chat/completions", json=CHAT)
        assert result.status_code == 200
        assert len(calls) == 2


@pytest.mark.parametrize("payload", [{}, {"choices": []}, {"id": "bad"}])
async def test_malformed_upstream_envelope(api, payload):
    async with api(lambda _: httpx.Response(200, json=payload)) as (client, _):
        result = await client.post("/v1/chat/completions", json=CHAT)
        # An empty choices array is valid OpenAI protocol; risk service rejects it separately.
        assert result.status_code == 502
        assert result.json()["error"]["code"] == "model_invalid_response"


async def test_truncated_completion_is_preserved_for_sdk_consumers(api):
    async with api(lambda _: httpx.Response(200, json=completion(finish_reason="length"))) as (
        client,
        _,
    ):
        result = await client.post("/v1/chat/completions", json=CHAT)
        assert result.status_code == 200
        assert result.json()["choices"][0]["finish_reason"] == "length"


async def test_startup_health_and_openapi_without_key():
    app = create_app(Settings(_env_file=None, nebius_api_key=SecretStr("")))
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app),
            base_url="http://test",
        ) as client:
            result = await client.get("/health")
            assert result.json() == {"status": "ok", "model_configured": False}
            schema = (await client.get("/openapi.json")).json()
            assert "/v1/chat/completions" in schema["paths"]
