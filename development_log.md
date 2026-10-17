# 开发日志

## 2026-10-17 · 后端模型服务层 v0.1

### 交付范围

- 新增 `backend/`，采用 Python 3.11+、FastAPI、OpenAI Python SDK 与 httpx。
- `backend/uv.lock` 固定依赖版本；`.env.example` 提供配置模板；密钥文件不入库。
- 模型层按 OpenAI SDK 的调用、参数和返回类型组织；风险评估作为独立业务服务。
- 暂不包含浏览器拦截、文件扫描、付款/消息执行、偏好持久化或冷静期调度器。

参考协议：[Nebius API](https://docs.tokenfactory.nebius.com/api-reference/introduction)、
[Nebius 结构化输出](https://docs.tokenfactory.nebius.com/ai-models-inference/json)、
[OpenAI Chat Completions](https://developers.openai.com/api/reference/python/resources/chat/subresources/completions/methods/create)。

### 分层与内部接口

| 文件 | 职责 |
| --- | --- |
| `backend/app/config.py` | 从进程环境或 `backend/.env` 加载服务端配置 |
| `backend/app/providers/nebius.py` | `AsyncOpenAI`、Nebius 鉴权、总超时、SDK 重试、上游错误归一化 |
| `backend/app/services/model.py` | OpenAI 风格模型入口、结构化输出校验 |
| `backend/app/services/firewall.py` | 保护范围检查、证据引用校验、规则最低介入等级、可选操作 |
| `backend/app/models.py` | 复用 OpenAI SDK 参数类型、通用请求校验 |
| `backend/app/firewall_models.py` | 业务请求和响应契约 |
| `backend/app/main.py` | HTTP 路由、可选鉴权、CORS、生命周期、错误响应与请求 ID |

通用内部模型入口：

```python
from openai.types.chat import ChatCompletion
from app.services.model import ModelService

async def explain(service: ModelService) -> ChatCompletion:
    completion = await service.chat.completions.create(
        model=service.default_model,
        messages=[{"role": "user", "content": "Explain the consequences of this operation."}],
        temperature=0.2,
        max_tokens=2048,
    )
    # 完整 OpenAI ChatCompletion，不改造成自定义 content 包装。
    return completion
```

参数按 OpenAI SDK 的关键字形式传入；`messages` 复用 `ChatCompletionMessageParam`，
返回 `openai.types.chat.ChatCompletion`，保留 `id/object/created/model/choices/usage`。
内部调用和 HTTP 请求共享输入校验。请求级 `model` 可指定 Nebius 可用模型；
风险评估默认使用 `NEBIUS_MODEL`。通用模型入口不替用户执行工具，工具调用只返回给调用方。

内部结构化接口：

```python
result, completion = await service.generate_structured(messages, PydanticSchema)
```

- `messages: list[ChatMessage]`，`PydanticSchema: type[BaseModel]`。
- 返回 `(已校验的 Pydantic 实例, 原始 ChatCompletion)`。
- 发送标准 `response_format={"type":"json_schema","json_schema":{"name":...,"strict":true,"schema":...}}`。
- 拒绝、截断、无结果或 JSON/Schema 校验失败均抛出 `ModelServiceError`。
- `get_model_service(Request)` 是 FastAPI 依赖入口；一个应用生命周期共享 HTTP 连接池，退出时关闭。

### HTTP 接口

| 方法与路径 | 请求 / 响应 |
| --- | --- |
| `GET /health` | `{ "status": "ok", "model_configured": false }`，只检查存活及是否配置密钥 |
| `GET /v1/models` | OpenAI `object=list` 格式，仅列出配置的默认模型，不查询远端目录 |
| `POST /v1/chat/completions` | 标准 OpenAI Chat Completions 请求与 `ChatCompletion` 响应 |
| `POST /api/v1/firewall/assess` | `AssessmentRequest → AssessmentResponse`，定义见下方 |
| `GET /docs`、`GET /openapi.json` | 可交互及机器可读契约 |

`/v1/*` 与风险评估接口共享可选 Bearer 鉴权，令牌为 `FIREWALL_API_TOKEN`，
与 Nebius 密钥独立。OpenAI SDK 连接本地服务时应使用这个后端令牌。
默认绑定 `127.0.0.1` 用于本地开发；偏好来自受信任调用方，当前没有多用户身份和偏好存储。
进入多用户场景前，需要按已认证用户读取偏好，不能直接信任网页请求中的规则声明。

**Chat Completions 支持范围**

- 必填 `model`、`messages`，支持 SDK 文本消息角色及文本内容数组、工具调用消息。
- 支持 `temperature`、`top_p`、`stop`、`max_tokens` 或 `max_completion_tokens`、
  `response_format`、`tools`、`tool_choice`；其实际可用性由所选 Nebius 模型决定。
- 当前只支持 `stream=false`、`n=1`、`store=false`；不支持多模态、流式、Responses API、
  Embeddings 和未声明的额外参数。未实现能力明确返回 400，不静默丢弃。
- 最多 64 条消息，消息 JSON 上限 64,000 字符；token 上限参数范围 1–8192，
  两种 token 参数不可同时传入，均省略时使用 `max_tokens=2048`。
- 通用接口保留 `finish_reason=length/tool_calls/content_filter` 等原始状态；
  业务风险评估必须获得完整 `stop` 输出才接受结果。
- 所有响应附带 `X-Request-ID`。错误体采用 OpenAI 的 `error.message/type/param/code` 格式。

### 风险评估契约

请求顶层为 `{ "action": ..., "preferences": ... }`，拒绝未知字段。
完整示例见 `backend/examples/delete.json` 与 `backend/examples/purchase.json`。

`action` 按 `type` 区分：

| type | 必填事实 | 可选事实 |
| --- | --- | --- |
| `delete` | `target`、`file_count >= 1`、`permanent` | `important_items`、`supports_trash`（默认 false） |
| `purchase` | `item`、`amount`、`currency` | `remaining_budget`：扣除计划储蓄后可花预算，与消费同币种 |
| `send_message` | `recipient`、`content` | `public`（默认 false） |

金额建议以十进制字符串传入，例如 `"28000.00"`；内部使用 Decimal，
非负、最多 14 位及两位小数。币种为三个大写字母，规则只比较相同币种，不做汇率转换。
文件数量、重要文件名、预算均由上游采集并获授权后传入；模型不扫描设备或读取账户。

`preferences`：

| 字段 | 含义 / 默认值 |
| --- | --- |
| `protected_actions` | 用户主动开启的保护范围，`delete/purchase/send_message` 数组，默认 `[]` |
| `spending_reminder` | 可空，`{threshold, currency}`；金额严格大于阈值时至少提醒 |
| `purchase_cooldown` | 可空，`{enabled, threshold, currency, minutes}`；enabled 默认 false，minutes 为 1–10080 |
| `important_paths` | 用户标注的重要路径，默认 `[]`；交给模型结合操作事实参考 |
| `personal_principles` | 用户希望遵守的原则，默认 `[]` |
| `savings_goals` | 目标名称，默认 `[]`；仅有名称不能证明消费会影响储蓄 |
| `expression_style` | `concise/gentle/direct`，默认 `gentle`，仅影响措辞 |

请求上下文总 JSON 限制为 16,000 字符；数组及文本另有字段级限制，以 OpenAPI 为准。
只有开启保护范围内的数据才发送给 Nebius；不在范围内返回 `source=scope_check`，不调用模型。

响应示例（冷静期规则命中）：

```json
{
  "level": "cooldown",
  "reason": "This purchase exceeds your cooling-off threshold of 5000.00 CNY. Your enabled cooling-off rule applies. Wait 30 minutes before confirming again.",
  "evidence": [
    {"id": "action.amount", "source": "operation", "value": "\"28000.00\""},
    {"id": "preferences.purchase_cooldown.enabled", "source": "user_rule", "value": "true"}
  ],
  "alternatives": [
    {"id": "save_for_later", "label": "Save for later"},
    {"id": "view_budget", "label": "View budget"},
    {"id": "reconsider_later", "label": "Confirm after cooling-off period"},
    {"id": "cancel", "label": "Cancel"}
  ],
  "cooldown_minutes": 30,
  "source": "model",
  "model": "openai/gpt-oss-120b",
  "usage": {"prompt_tokens": 100, "completion_tokens": 50, "total_tokens": 150}
}
```

示例省略部分规则证据；真实响应会补全匹配所需的金额、币种、阈值、开启状态和时长。
`evidence[].id` 是已验证的输入字段路径；`value` 是该字段经类型校验、标准化后的 JSON 文本，
由代码生成，不能由模型编造。`reason` 仍含模型生成文本，引用存在不等于其论述完全正确。

- `level=allow` 是无需介入状态；其余三级为 `remind/confirm/cooldown`。
- 模型只能建议前三种非冷静期状态；永久删除由代码确保至少 `confirm`，
  同币种大额提醒规则确保至少 `remind`。
- 仅当保护范围开启、`purchase_cooldown.enabled=true`、币种一致、金额严格大于阈值时，
  代码返回 `cooldown`。等于阈值不触发；模型不能开启或绕过冷静期。
- `cooldown_minutes` 是规则时长，不是计时凭证。此服务不持久化计时；重复评估也不表示已度过冷静期。
- alternatives 为 UI 操作标识，调用方处理 `view_files/move_to_trash/save_for_later/view_budget/`
  `save_draft/edit_message/proceed/reconsider_later/cancel`；此层不执行它们。
- `remind/confirm` 提供继续选项；`cooldown` 不提供立即继续，需执行层验证等待及再次确认。
- 不将模型失败转换为 allow。任何非 2xx、未知等级或无效响应，调用方应保留暂停状态，
  提供重试或人工核对入口，不能当作自动放行依据。
- 提示词将文件名、消息等作为不可信数据；结构校验和规则最低等级提供代码约束，
  不保证消除所有提示注入或模型误判。

### 配置与错误

| 环境变量 | 默认值 / 作用 |
| --- | --- |
| `NEBIUS_API_KEY` | 空；仅服务端保存，无密钥仍可启动及检查健康，模型调用返回 503 |
| `NEBIUS_BASE_URL` | `https://api.tokenfactory.nebius.com/v1/`，只接受无内嵌凭证的 HTTPS URL |
| `NEBIUS_MODEL` | `openai/gpt-oss-120b`，需账户可用且支持 JSON Schema；可从环境更换 |
| `NEBIUS_TIMEOUT_SECONDS` | 30 秒，覆盖所有重试和等待的总截止时间，范围 `(0,120]` |
| `NEBIUS_MAX_RETRIES` | 1 次额外重试，范围 0–3，由 SDK 处理连接错误、408/409/429/5xx 等 |
| `FIREWALL_API_TOKEN` | 空表示本地开发模式；设置后所有业务接口要求 Bearer 令牌 |
| `FIREWALL_CORS_ORIGINS` | `[]`，JSON 数组格式的显式允许来源 |

进程环境优先于 `backend/.env`，启动时加载，修改后需重启。上游重试可能消耗额外推理额度；
业务方通过本地 SDK 调用时可设置 `max_retries=0`，避免再叠加一层重试。

| HTTP 状态 | error.code |
| --- | --- |
| 400 | `invalid_request`：输入无效或能力未实现 |
| 401 | `unauthorized`：后端令牌错误 |
| 429 | `model_rate_limited`：Nebius 限流重试后仍失败 |
| 503 | `model_not_configured` / `model_auth_failed` |
| 504 | `model_timeout` |
| 502 | `model_unavailable` / `model_upstream_error` / `model_invalid_response` / `model_invalid_evidence` / `model_refused` / `model_incomplete` |

错误响应不回传 Nebius 原始正文、密钥或请求内容；输入校验也不回显消息草稿。

### 验证记录

本地自动化测试使用 httpx MockTransport 模拟 Nebius，并用真实 OpenAI SDK 连接 ASGI 后端：
覆盖标准请求响应、内部调用格式、工具调用、结构化输出、输入约束、密钥缺失、鉴权、限流、
重试、总超时、连接异常、错误脱敏、保护范围、永久删除、金额精度、币种及冷静期阈值边界。
验证结果：48 项测试通过；`ruff check`、`ruff format --check`、`git diff --check` 通过。
另覆盖 SDK `chat.completions.parse()` 与文本内容数组、工具结果消息的往返兼容。
当前未配置真实 Nebius 密钥，尚未进行真实推理及模型效果评估。


## 2026-10-17 · English display text

- All backend error messages, rule explanations, scope notices, and alternative labels now use English.
- The firewall system prompt is in English and instructs the model to produce English explanations.
- Every model request prepends an English output-language system instruction, including requests through
  the OpenAI-compatible endpoint and the internal completions resource. The request/response schemas
  and OpenAI SDK call shape remain unchanged.
- Original user input, quoted source names, evidence values, identifiers, and tool arguments derived
  from source data retain their original content and language. Generated text is requested in English;
  the service does not translate raw evidence or rewrite returned tool arguments.
- Example requests and documented model output were updated to English.
- Verification: 49 tests passed with warnings treated as errors; Ruff lint/format and
  `git diff --check` passed. Coverage includes English language instructions and display text
  while preserving original non-English evidence values.

## 2026-10-17 · macOS message reminders

Implemented a native Swift menu bar app in `desktop/` and a dedicated backend message
assessment service. The flow is keyboard activity → focused draft → local keyword
screening → AI context assessment → optional reminder panel. All generated display text
and prompts are English; source drafts and evidence retain their language.

### Backend interfaces

`GET /api/v1/messages/terms` returns the configured local-screening dictionary:

```json
{
  "terms": [
    {"term": "idiot", "match_mode": "word"},
    {"term": "蠢货", "match_mode": "substring"}
  ]
}
```

The example is abbreviated. The source of truth is
`backend/app/data/sensitive_terms.json`; restart the backend and restart protection
after editing it. Terms use Unicode NFKC normalization and lowercase matching.
Word mode matches whole words; substring mode supports phrases without word separators.
The desktop fetches this configuration before starting, so it does not send unmatched
drafts to the backend. The backend repeats screening before any model call.

`POST /api/v1/messages/assess` accepts:

```json
{
  "enabled": true,
  "content": "You are an idiot. Fix the report.",
  "application": "com.apple.TextEdit",
  "recipient": "Project teammate",
  "public": false,
  "personal_principles": ["Disagree without personal attacks."]
}
```

Only `content` is required. `enabled` defaults to false; `application` and `recipient`
default to null, `public` to false, and `personal_principles` to an empty array.
`content` is a non-empty draft/context fragment up to 4,000 Unicode code points.
`application` is limited to 200 characters, `recipient` to 500, and principles to
10 strings of at most 500 characters each. Unknown fields are rejected with HTTP 400.

The desktop currently sends only `enabled=true`, `content`, and `application`.
It does not infer a recipient, public/private status, or conversation history from
the application name. Those fields can be supplied by later application-specific integrations.

Successful assessment response example:

```json
{
  "status": "assessed",
  "should_remind": true,
  "reason": "The personal insult may escalate the conversation.",
  "matched_terms": ["idiot"],
  "suggested_revision": "Please fix the report.",
  "model": "openai/gpt-oss-120b",
  "usage": {"prompt_tokens": 200, "completion_tokens": 50, "total_tokens": 250}
}
```

- `status` is `disabled`, `no_match`, or `assessed`.
- Disabled and unmatched requests return `should_remind=false`, an English explanation,
  null model/usage/revision, and no model call. They work without a Nebius key.
- A keyword match is only a trigger. The model may return `should_remind=false`, for
  example for a quotation or educational use. Revisions are only returned when a reminder
  is recommended. They are optional and must not be applied without a user action.
- Internal interface: `MessageService(ModelService).assess(MessageAssessmentRequest)`
  returns `MessageAssessmentResponse`. Structured inference uses the existing
  `ModelService.generate_structured(...)` and standard OpenAI-compatible completions.
- Both new routes use the existing optional `FIREWALL_API_TOKEN` Bearer authentication.
  Model failures use the existing sanitized OpenAI-style errors and are never converted
  to a safe assessment. No raw drafts are included in error logs/responses.
- `enabled` represents opt-in from the trusted desktop client. It is not a substitute
  for user authentication or persisted policy in a future multi-user deployment.

### Desktop implementation and boundaries

| Component | Responsibility |
| --- | --- |
| `desktop/Sources/MessageGuard/KeyboardMonitor.swift` | Listen-only CGEvent tap; key-down events signal activity without decoding characters |
| `FocusedInput.swift` | Allowed foreground app, editable AX text control, secure-field exclusion, caret-centered bounded context |
| `AppDelegate.swift` | Paused startup, app-list configuration, explicit enable flow, permissions, debounce, cancellation, throttling, stale checks |
| `ReminderPanel.swift` | Nonactivating English panel, keep editing, explicit copy, pause |
| `desktop/Sources/MessageGuardCore/` | Keyword matcher, capture policy, revision gate, bounded hash cache, API DTOs and ephemeral HTTP client |
| `desktop/scripts/build-app.sh` | Builds and ad-hoc signs a local `MessageGuard.app` |

The desktop requires macOS 13+ and Xcode Command Line Tools. No third-party desktop
dependencies are needed. It starts paused with no default allowed apps; supply repeatable
`--app` flags or use **Configure allowed apps…** in the shield menu. App-list changes
are in-memory for the current session. User enablement requires Accessibility and Input
Monitoring permissions; the app only opens the relevant settings page on a user action.

The app waits for 600 ms of keyboard inactivity and reads at most 4,000 UTF-16 units
around the caret in the focused draft. Read-only, standard secure, unsupported, or
inaccessible controls are skipped. Custom controls depend on their AX metadata.
This reads current text rather than reconstructing keystrokes, supporting text edits
and paste when a keyboard event triggers a check. Mouse-only changes are not independently watched.

At least three seconds separate inference starts. SHA-256 draft/field hashes are
deduplicated for 120 seconds with a 128-entry memory limit. Actual draft text is not
logged, persisted, or retained in the deduplication cache. HTTP uses an ephemeral session,
no cookies or response cache, rejects redirects, and permits plain HTTP only on loopback.

Typing, switching apps, changing fields/content, or pausing cancels or invalidates old work.
The focused field and content are checked again immediately before showing a result.
Pause removes the event tap, cancels tasks, closes the panel, and clears the hash cache.
Already-received server/provider requests can still complete after client cancellation.
Backend failures show **Check** in the menu bar and back off for 15 seconds.

This implementation is a typing-time reminder, not a send interceptor. It cannot guarantee
that AI responds before an immediate Enter/Send action. It does not synthesize input,
change drafts, save messages, or send anything. **Copy suggestion** only writes to the
clipboard after the user clicks it. Application-specific send hooks remain separate work.

`--preview` shows clearly labeled sample content while paused, without monitoring or network calls.
Run and permission instructions are in `desktop/README.md`.

### Verification

- Backend: 70 tests pass with warnings treated as errors, including 21 new message tests.
- Desktop: native executable compiles and 9 Swift tests pass, covering capture policy,
  Unicode/word boundaries, literal keyword escaping, stale results, pause, bounded TTL
  deduplication, URL policy, and Unicode request encoding.
- Python Ruff lint/format checks pass. The local app bundle passes ad-hoc code-sign verification.
- Live keyboard capture, actual target-app AX behavior, and real Nebius inference were not
  exercised: the environment has no configured model key or granted capture permissions.
- The initial LaunchServices preview launch failed in the sandbox. Launching the local
  executable's paused `--preview` outside that sandbox succeeded; desktop inspection
  confirmed the English reminder, suggested wording, three action buttons, and unchanged-message
  note render without clipping. Preview did not enable keyboard monitoring or network calls.

## 2026-10-17 · Live Nebius and macOS validation

Applied a user-supplied temporary test credential only to the ignored `backend/.env`,
with mode 0600. No credential value is included in source, test reports, or this log.
No OS permissions were changed; the native process already had Accessibility and
Input Monitoring access outside the execution sandbox.

Started an isolated backend on `127.0.0.1:18765`, with request access logging disabled,
and used the actual Nebius API with `openai/gpt-oss-120b`.

| Live check | Observed result | Duration |
| --- | --- | --- |
| Nebius model listing | HTTP 200; configured model available | — |
| OpenAI-compatible chat | HTTP 200, `finish_reason=stop`, expected English reply | 0.43 s |
| Ordinary draft | `no_match`, no model call | <0.01 s |
| Disabled protection | `disabled`, no model call | <0.01 s |
| English direct insult | `assessed`, reminder and English suggested revision | 1.66 s |
| Educational quotation | `assessed`, no reminder, no revision | 1.57 s |
| Chinese direct insult | `assessed`, reminder and English suggested revision | 1.82 s |

The six HTTP behavior checks passed. Timings reflect this small test run, not a latency
guarantee or a broader model-quality evaluation. All drafts were synthetic test examples.
The reproducible runner is `backend/scripts/live_message_smoke.py`; it uses server-side
configuration and never embeds or prints the Nebius credential.

Desktop validation used a newly created TextEdit test document and an explicit
`com.apple.TextEdit` allowlist. The normal enable-confirmation flow and real keyword
configuration were used, not `--preview`. The automated tool's directed input did not
exercise the global listener. After the user physically entered a space in that test
document, the native process recorded these content-free diagnostic stages:

```text
assessment_requested
reminder_received
reminder_displayed
```

This verifies a physical keyboard event → focused TextEdit context → local keyword
match → actual backend/Nebius inference → native reminder presentation. Switching
away from the target app invalidates and closes the reminder by design. Other host
applications and custom secure controls have not been validated by this test.

Added `--check-permissions` (read-only), `--start` (opens normal confirmation), and
`--diagnostics` (fixed stage labels only) to support future testing without logging
drafts, key characters, window titles, or credentials. The temporary desktop monitor
and isolated backend were stopped after the test; no background listener was left running.
