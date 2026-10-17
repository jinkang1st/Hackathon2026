import json

import httpx
import pytest
from conftest import completion
from pydantic import SecretStr

from app.services.messages import TERMS, matched_terms

ENDPOINT = "/api/v1/messages/assess"


@pytest.mark.parametrize(
    "text,expected",
    [
        ("You are an IDIOT!", ["idiot"]),
        ("This is stupid, shut up.", ["stupid", "shut up"]),
        ("A shiitake mushroom", []),
        ("We studied idiotic expressions", []),
        ("You are ｓｔｕｐｉｄ", ["stupid"]),
        ("你这个蠢货", ["蠢货"]),
        ("A polite message", []),
    ],
)
def test_keyword_normalization_and_boundaries(text, expected):
    assert matched_terms(text) == expected


@pytest.mark.parametrize(
    "payload,status",
    [
        ({"enabled": False, "content": "You are an idiot"}, "disabled"),
        ({"content": "You are an idiot"}, "disabled"),
        ({"enabled": True, "content": "Thanks for your help"}, "no_match"),
    ],
)
async def test_untriggered_messages_do_not_call_model(api, payload, status):
    def upstream(_):
        pytest.fail("Disabled or unmatched messages must not reach the model")

    async with api(upstream, nebius_api_key=SecretStr("")) as (client, _):
        response = await client.post(ENDPOINT, json=payload)
        assert response.status_code == 200
        body = response.json()
        assert body["status"] == status
        assert body["should_remind"] is False
        assert body["model"] is None
        assert body["reason"].isascii()


async def test_sensitive_terms_endpoint_uses_shared_dictionary(api):
    async with api(lambda _: pytest.fail("Term configuration does not use the model")) as (
        client,
        _,
    ):
        response = await client.get("/api/v1/messages/terms")
        assert response.status_code == 200
        assert response.json()["terms"] == [term.model_dump() for term in TERMS]


async def test_message_context_is_assessed_and_revision_is_returned(api):
    def upstream(request):
        body = json.loads(request.content)
        assert body["response_format"]["json_schema"]["name"] == "ModelMessageAssessment"
        context = json.loads(body["messages"][-1]["content"])
        assert context["draft"]["content"] == "You are an idiot. Fix the report."
        assert context["draft"]["application"] == "com.apple.TextEdit"
        assert context["matched_terms"] == ["idiot"]
        return httpx.Response(
            200,
            json=completion(
                json.dumps(
                    {
                        "should_remind": True,
                        "reason": "The personal insult may escalate the conversation.",
                        "suggested_revision": "Please fix the report.",
                    }
                )
            ),
        )

    async with api(upstream) as (client, _):
        response = await client.post(
            ENDPOINT,
            json={
                "enabled": True,
                "content": "You are an idiot. Fix the report.",
                "application": "com.apple.TextEdit",
            },
        )
        assert response.status_code == 200
        body = response.json()
        assert body["status"] == "assessed"
        assert body["should_remind"] is True
        assert body["suggested_revision"] == "Please fix the report."
        assert body["usage"]["total_tokens"] == 30


async def test_keyword_match_does_not_force_a_warning(api):
    result = {
        "should_remind": False,
        "reason": "This is an educational quotation.",
        "suggested_revision": "An unnecessary revision",
    }
    async with api(lambda _: httpx.Response(200, json=completion(json.dumps(result)))) as (
        client,
        _,
    ):
        body = (
            await client.post(
                ENDPOINT,
                json={
                    "enabled": True,
                    "content": 'The word "idiot" is an insult.',
                },
            )
        ).json()
        assert body["should_remind"] is False
        assert body["matched_terms"] == ["idiot"]
        assert body["suggested_revision"] is None


@pytest.mark.parametrize(
    "body",
    [
        {"enabled": True, "content": "x" * 4001},
        {"enabled": True, "content": ""},
        {"enabled": True, "content": "idiot", "unknown": "field"},
    ],
)
async def test_message_input_limits(api, body):
    async with api(lambda _: pytest.fail("Invalid input must not call the model")) as (client, _):
        assert (await client.post(ENDPOINT, json=body)).status_code == 400


@pytest.mark.parametrize(
    "result",
    [
        "not-json",
        json.dumps({"should_remind": True, "reason": " ", "suggested_revision": None}),
        json.dumps(
            {
                "should_remind": True,
                "reason": "Risk",
                "suggested_revision": None,
                "unexpected": "field",
            }
        ),
    ],
)
async def test_invalid_message_model_result_is_not_treated_as_safe(api, result):
    async with api(lambda _: httpx.Response(200, json=completion(result))) as (client, _):
        response = await client.post(ENDPOINT, json={"enabled": True, "content": "idiot"})
        assert response.status_code == 502
        assert response.json()["error"]["code"] == "model_invalid_response"


async def test_message_model_error_does_not_become_a_safe_assessment(api):
    async with api(lambda _: httpx.Response(429, text="private upstream error")) as (client, _):
        response = await client.post(ENDPOINT, json={"enabled": True, "content": "idiot"})
        assert response.status_code == 429
        assert "should_remind" not in response.json()
        assert "private upstream error" not in response.text


async def test_message_routes_require_backend_token(api):
    async with api(
        lambda _: pytest.fail("Unauthorized"), firewall_api_token=SecretStr("local-token")
    ) as (client, _):
        assert (await client.get("/api/v1/messages/terms")).status_code == 401
        assert (await client.post(ENDPOINT, json={"content": "idiot"})).status_code == 401
