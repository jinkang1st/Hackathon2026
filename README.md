# Hackathon2026

Another Proejct：[luma-follow-light-ice.creamllama16.chatgpt.site](https://luma-follow-light-ice.creamllama16.chatgpt.site)

# AI Firewall

**Shopping Guard prototype:** [Install and test the Chrome extension](extension/README.md). All extension screens are in English. API configuration starts blank; local GBP price detection works immediately.

A moment to pause before impulse turns into action.

An experimental AI extension that combines the action you are about to take with your personal rules to offer a reminder, pause the action, and suggest alternatives before you do something you might regret.

## Planned features

### 1. Shopping guard

Trigger reminders before payment based on user-defined spending limits, budgets, and other rules.

- Highlight large purchases and their impact on your budget
- Offer options to save for later, start a cooling-off period, or confirm the purchase

> “This purchase exceeds your alert amount. Would you like to save it and decide tomorrow?”

### 2. Message guard

Identify language that could escalate a conflict and prompt you to reconsider before sending a message.

- Flag aggressive wording and potential misunderstandings
- Suggest clearer wording that preserves your intended meaning
- Offer options to save a draft, edit the message, or confirm sending

> “This message could escalate the argument. Would you like to try a version that is firm without attacking the other person?”

### 3. More scenarios (to be explored)

Explore safeguards before actions such as accidentally deleting important files or publicly sharing sensitive information.

## Core principles

- **You set the boundaries:** Choose which scenarios to protect and which rules to apply.
- **Explain every intervention:** Show what triggered it and what the consequences could be.
- **Keep you in control:** Provide reminders, confirmations, and optional cooling-off periods.
- **Use only the permissions needed:** Access only the information required by the features you choose.

## Hackathon goals

Start with shopping and messaging demos that demonstrate the complete workflow:

**Identify the risk → Pause the action → Explain the reason → Let the user choose → Execute the action**

## Backend model service

The backend model service is implemented. It uses the OpenAI Python SDK to call Nebius Token Factory
and provides an OpenAI Chat Completions-compatible endpoint and a structured risk assessment endpoint.

## Run locally

Requires Python 3.11+ and [uv](https://docs.astral.sh/uv/).

```bash
cd backend
uv sync --frozen
cp .env.example .env
# Edit .env to set NEBIUS_API_KEY and a NEBIUS_MODEL available to your account
uv run uvicorn app.main:app --host 127.0.0.1 --port 8000 --reload
```

Interactive documentation: [http://127.0.0.1:8000/docs](http://127.0.0.1:8000/docs); health check: [http://127.0.0.1:8000/health](http://127.0.0.1:8000/health).
`.env` is excluded from version control. `NEBIUS_API_KEY` stays on the backend.
If you expose the service to other devices, set a separate `FIREWALL_API_TOKEN` and send
`Authorization: Bearer <FIREWALL_API_TOKEN>` with requests. Explicitly configure allowed browser origins with `FIREWALL_CORS_ORIGINS`.

## OpenAI SDK-compatible usage

```python
import asyncio
import os
from openai import AsyncOpenAI

async def main():
    async with AsyncOpenAI(
        base_url="http://127.0.0.1:8000/v1/",
        api_key=os.getenv("FIREWALL_API_TOKEN") or "local-dev",
        max_retries=0,
    ) as client:
        response = await client.chat.completions.create(
            model=os.getenv("NEBIUS_MODEL", "openai/gpt-oss-120b"),
            messages=[{"role": "user", "content": "Explain AI Firewall in one sentence."}],
            max_tokens=2048,
        )
        print(response.choices[0].message.content)

asyncio.run(main())
```

Compatibility covers non-streaming text Chat Completions, including text-based tool calls and `response_format`.
Unsupported features such as `stream=true`, multimodal input, `n>1`, and `store=true` explicitly return HTTP 400.
Internal modules use the same `service.chat.completions.create(...) -> ChatCompletion` interface.

## Risk assessment

Run from `backend/` (add the Authorization header shown above if a backend token is configured):

```bash
curl http://127.0.0.1:8000/api/v1/firewall/assess \
  -H 'Content-Type: application/json' \
  --data-binary @examples/delete.json

curl http://127.0.0.1:8000/api/v1/firewall/assess \
  -H 'Content-Type: application/json' \
  --data-binary @examples/purchase.json
```

The endpoint returns the intervention level, reasons, supporting facts from the input, and available actions.
All generated user-facing text is in English; original evidence retains the input language.
This layer only performs assessment. Pausing, execution, timing, and reconfirmation are handled by the extension and execution layers built on top of it.
See [development_log.md](development_log.md) for API contracts and integration conventions.

## Validation

```bash
cd backend
uv run pytest -q
uv run ruff check .
uv run ruff format --check .
```

Tests use mocked Nebius responses and do not consume real inference credits.

## macOS message reminders

A native Swift menu bar app starts paused and only checks input fields in explicitly allowed applications.
The workflow is: keyboard activity → local keyword screening → limited context sent for AI assessment → an English reminder when needed.

Start the backend first, then run the following in another terminal:

```bash
cd desktop
swift run MessageGuard --app com.apple.TextEdit
```

Choose **Start protection…** from the shield menu and follow the prompts to grant macOS Accessibility
and Input Monitoring permissions. Protection can be paused at any time. This version provides reminders while you type; it does not intercept sending.

See [desktop/README.md](desktop/README.md) for installation, preview, permissions, and supported scenarios.
The new endpoints are `GET /api/v1/messages/terms` and `POST /api/v1/messages/assess`.

After configuring the key and starting the backend, use synthetic text for a live API integration check (this consumes inference credits):

```bash
backend/.venv/bin/python backend/scripts/live_message_smoke.py --base-url http://127.0.0.1:8000
```
