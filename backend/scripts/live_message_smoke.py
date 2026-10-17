"""Explicit opt-in integration check using only synthetic messages, never real drafts."""

import argparse
import asyncio
import json
import sys
from pathlib import Path
from time import monotonic

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.config import Settings  # noqa: E402


async def run(base_url: str, report: Path | None) -> int:
    settings = Settings()
    token = settings.firewall_api_token.get_secret_value()
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    results = []
    cases = [
        ("ordinary_message", "Thank you for checking the report.", True, "no_match", False),
        ("disabled", "You are an idiot.", False, "disabled", False),
        ("direct_insult", "You are an idiot. Fix the report.", True, "assessed", True),
        (
            "educational_quote",
            'The word "idiot" is an insult. Avoid using it.',
            True,
            "assessed",
            False,
        ),
        ("chinese_insult", "你这个蠢货，连这么简单的报告都写不好。", True, "assessed", True),
    ]
    async with httpx.AsyncClient(base_url=base_url, headers=headers, timeout=40) as client:
        health = await client.get("/health")
        print(
            json.dumps(
                {
                    "health_http": health.status_code,
                    "model_configured": health.json().get("model_configured"),
                }
            ),
            flush=True,
        )

        async def check(name, path, payload, expected):
            started = monotonic()
            try:
                response = await client.post(path, json=payload)
                body = response.json()
                passed = response.status_code == 200 and expected(body)
                result = {
                    "case": name,
                    "http_status": response.status_code,
                    "passed": passed,
                    "elapsed_seconds": round(monotonic() - started, 2),
                }
                if response.is_success:
                    for field in (
                        "status",
                        "should_remind",
                        "reason",
                        "suggested_revision",
                        "model",
                        "usage",
                    ):
                        if field in body:
                            result[field] = body[field]
                    if "choices" in body:
                        result["content"] = body["choices"][0]["message"].get("content")
                        result["finish_reason"] = body["choices"][0]["finish_reason"]
                else:
                    result["error_code"] = body.get("error", {}).get("code", "unknown")
            except (httpx.HTTPError, ValueError, KeyError, IndexError) as exc:
                result = {"case": name, "passed": False, "error_type": type(exc).__name__}
            results.append(result)
            print(json.dumps(result, ensure_ascii=False), flush=True)

        await check(
            "openai_chat",
            "/v1/chat/completions",
            {
                "model": settings.nebius_model,
                "messages": [
                    {"role": "user", "content": "Reply with exactly: API connection verified."}
                ],
                "max_tokens": 512,
            },
            lambda body: (
                bool(body.get("choices"))
                and body["choices"][0]["finish_reason"] == "stop"
                and body["choices"][0]["message"].get("content", "").strip()
                == "API connection verified."
            ),
        )

        async def check_message(case):
            name, content, enabled, status, remind = case
            await check(
                name,
                "/api/v1/messages/assess",
                {
                    "enabled": enabled,
                    "content": content,
                    "application": "com.apple.TextEdit",
                },
                lambda body: body.get("status") == status and body.get("should_remind") is remind,
            )

        # Two local bypass cases, then model checks sequentially to avoid rate-limit bursts.
        for case in cases:
            await check_message(case)
    summary = {
        "model": settings.nebius_model,
        "passed": sum(result["passed"] for result in results),
        "total": len(results),
        "results": results,
    }
    if report:
        report.parent.mkdir(parents=True, exist_ok=True)
        report.write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n")
    print(f"Live checks passed: {summary['passed']}/{summary['total']}", flush=True)
    return 0 if summary["passed"] == summary["total"] else 1


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default="http://127.0.0.1:18765")
    parser.add_argument("--report", type=Path)
    arguments = parser.parse_args()
    raise SystemExit(asyncio.run(run(arguments.base_url, arguments.report)))
