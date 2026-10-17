import json

import httpx
import pytest
from conftest import assessment, completion

from app.services.firewall import SYSTEM_PROMPT

ASSESS = "/api/v1/firewall/assess"


async def test_english_display_text_preserves_original_evidence(api, purchase):
    def upstream(request):
        messages = json.loads(request.content)["messages"]
        assert messages[0]["content"].isascii()
        assert "English" in messages[0]["content"]
        assert messages[1]["content"] == SYSTEM_PROMPT
        assert SYSTEM_PROMPT.isascii()
        assert "English" in SYSTEM_PROMPT
        return httpx.Response(200, json=assessment("remind", ["action.item"]))

    async with api(upstream) as (client, _):
        result = await client.post(ASSESS, json=purchase)
        assert result.status_code == 200
        body = result.json()
        assert body["reason"].isascii()
        assert all(option["label"].isascii() for option in body["alternatives"])
        evidence = {fact["id"]: fact["value"] for fact in body["evidence"]}
        assert json.loads(evidence["action.item"]) == purchase["action"]["item"]


async def test_spending_rule_cannot_be_weakened_by_model(api, purchase):
    async with api(lambda _: httpx.Response(200, json=assessment("allow", []))) as (client, _):
        result = await client.post(ASSESS, json=purchase)
        assert result.status_code == 200
        body = result.json()
        assert body["level"] == "remind"
        assert "5000.00 CNY" in body["reason"]
        assert body["cooldown_minutes"] is None
        assert "proceed" in {option["id"] for option in body["alternatives"]}
        assert body["usage"]["total_tokens"] == 30


async def test_permanent_delete_requires_confirmation_and_exact_evidence(api, deletion):
    def upstream(request):
        data = json.loads(request.content)
        assert data["response_format"]["type"] == "json_schema"
        assert data["response_format"]["json_schema"]["strict"] is True
        return httpx.Response(200, json=assessment("allow", []))

    async with api(upstream) as (client, _):
        result = await client.post(ASSESS, json=deletion)
        body = result.json()
        assert body["level"] == "confirm"
        assert body["reason"].isascii()
        assert all(option["label"].isascii() for option in body["alternatives"])
        facts = {fact["id"]: fact["value"] for fact in body["evidence"]}
        assert facts["action.file_count"] == "3842"
        assert facts["action.permanent"] == "true"
        assert "move_to_trash" in {option["id"] for option in body["alternatives"]}


async def test_cooldown_requires_matching_enabled_user_rule(api, purchase):
    purchase["preferences"]["purchase_cooldown"] = {
        "enabled": True,
        "threshold": "5000.00",
        "currency": "CNY",
        "minutes": 30,
    }
    async with api(lambda _: httpx.Response(200, json=assessment("allow", []))) as (client, _):
        body = (await client.post(ASSESS, json=purchase)).json()
        assert body["level"] == "cooldown"
        assert body["reason"].isascii()
        assert all(option["label"].isascii() for option in body["alternatives"])
        assert body["cooldown_minutes"] == 30
        assert "proceed" not in {option["id"] for option in body["alternatives"]}
        assert any(
            fact["id"] == "preferences.purchase_cooldown.enabled" for fact in body["evidence"]
        )


@pytest.mark.parametrize(
    "enabled,currency,amount,expected",
    [
        (False, "CNY", "28000.00", "remind"),
        (True, "USD", "28000.00", "allow"),
        (True, "CNY", "5000.00", "allow"),
        (True, "CNY", "4999.99", "allow"),
        (True, "CNY", "5000.01", "cooldown"),
    ],
)
async def test_cooldown_boundaries_and_currency(api, purchase, enabled, currency, amount, expected):
    purchase["action"].update(currency=currency, amount=amount)
    purchase["preferences"]["purchase_cooldown"] = {
        "enabled": enabled,
        "threshold": "5000.00",
        "currency": "CNY",
        "minutes": 30,
    }
    async with api(lambda _: httpx.Response(200, json=assessment("allow", []))) as (client, _):
        body = (await client.post(ASSESS, json=purchase)).json()
        assert body["level"] == expected


async def test_scope_opt_out_skips_external_model_even_with_rules(api, purchase):
    purchase["preferences"]["protected_actions"] = []

    def upstream(_):
        pytest.fail("Unprotected data must not leave the service")

    async with api(upstream) as (client, _):
        body = (await client.post(ASSESS, json=purchase)).json()
        assert body["level"] == "allow"
        assert body["source"] == "scope_check"
        assert body["reason"].isascii()
        assert body["alternatives"][0]["label"] == "Continue"
        assert body["model"] is None


@pytest.mark.parametrize(
    "content,code",
    [
        ("not-json", "model_invalid_response"),
        (
            json.dumps({"level": "cooldown", "reason": "Wait", "evidence_ids": ["action.amount"]}),
            "model_invalid_response",
        ),
        (
            json.dumps({"level": "confirm", "reason": "Risk", "evidence_ids": ["invented.fact"]}),
            "model_invalid_evidence",
        ),
        (
            json.dumps({"level": "confirm", "reason": "Risk", "evidence_ids": []}),
            "model_invalid_evidence",
        ),
    ],
)
async def test_invalid_analysis_never_becomes_allow(api, purchase, content, code):
    async with api(lambda _: httpx.Response(200, json=completion(content))) as (client, _):
        result = await client.post(ASSESS, json=purchase)
        assert result.status_code == 502
        assert result.json()["error"]["code"] == code
        assert "level" not in result.json()


@pytest.mark.parametrize(
    "finish,refusal,code",
    [
        ("length", None, "model_incomplete"),
        ("stop", "Unable to assess", "model_refused"),
        ("content_filter", None, "model_refused"),
    ],
)
async def test_truncation_and_refusal_require_manual_review(api, purchase, finish, refusal, code):
    async with api(
        lambda _: httpx.Response(
            200,
            json=completion(
                finish_reason=finish,
                refusal=refusal,
            ),
        )
    ) as (client, _):
        result = await client.post(ASSESS, json=purchase)
        assert result.status_code == 502
        assert result.json()["error"]["code"] == code


@pytest.mark.parametrize("amount", ["-1", "NaN", "Infinity", "0.001"])
async def test_invalid_money_is_rejected(api, purchase, amount):
    purchase["action"]["amount"] = amount
    async with api(lambda _: pytest.fail("Invalid money must not reach Nebius")) as (client, _):
        assert (await client.post(ASSESS, json=purchase)).status_code == 400


async def test_message_assessment(api):
    payload = {
        "action": {
            "type": "send_message",
            "recipient": "项目群",
            "content": "原始草稿",
            "public": True,
        },
        "preferences": {"protected_actions": ["send_message"]},
    }
    async with api(
        lambda _: httpx.Response(
            200,
            json=assessment(
                "remind",
                ["action.public", "action.recipient"],
            ),
        )
    ) as (client, _):
        body = (await client.post(ASSESS, json=payload)).json()
        assert body["level"] == "remind"
        assert "edit_message" in {option["id"] for option in body["alternatives"]}
