# Hackathon2026
# AI 防火墙

**Shopping Guard prototype:** [Install and test the Chrome extension](extension/README.md). All extension screens are in English. API configuration starts blank; local GBP price detection works immediately.

在冲动变成行动之前，替你按一下暂停键。

一个探索中的 AI 插件：结合当前操作和用户设定的个人规则，在可能让你后悔的操作发生前，提醒、暂停，并提供替代选择。

## 计划功能

### 1. 购物拦截

在付款前，根据用户设定的金额上限、消费预算等规则触发提醒。

- 提示大额支出及其对预算的影响
- 支持先收藏、开启冷静期或确认购买

> “这笔消费超过了你设置的提醒金额，要先收藏，明天再决定吗？”

### 2. 发消息拦截

在消息发送前，识别可能激化冲突的表达，提醒用户重新考虑。

- 提示攻击性措辞及可能引起的误解
- 提供保留原意、表达更清楚的改写建议
- 支持暂存草稿、修改或确认发送

> “这条消息可能让争论升级，要试试一版态度坚定、但不攻击对方的表达吗？”

### 3. 更多场景（待定）

探索误删重要文件、公开发布敏感信息等操作的事前保护。

## 基本原则

- **用户设定边界：** 自主选择保护场景和拦截规则。
- **解释每次拦截：** 说明触发原因和可能的后果。
- **保留决定权：** 提供提醒、确认和自愿开启的冷静期。
- **最小必要授权：** 仅访问所选功能需要的信息。

## Hackathon 目标

先完成购物和发消息两个演示场景，跑通：

**识别风险 → 暂停操作 → 解释原因 → 用户选择 → 执行操作**

## 后端模型服务层

当前已实现后端模型服务层：使用 OpenAI Python SDK 调用 Nebius Token Factory，
提供 OpenAI Chat Completions 兼容接口及结构化风险评估接口。

## 本地启动

需要 Python 3.11+ 和 [uv](https://docs.astral.sh/uv/)。

```bash
cd backend
uv sync --frozen
cp .env.example .env
# 编辑 .env，填写 NEBIUS_API_KEY 和账户可用的 NEBIUS_MODEL
uv run uvicorn app.main:app --host 127.0.0.1 --port 8000 --reload
```

交互文档：<http://127.0.0.1:8000/docs>；健康检查：<http://127.0.0.1:8000/health>。
`.env` 已加入忽略规则。`NEBIUS_API_KEY` 仅保留在后端。
如向其他设备开放服务，设置独立的 `FIREWALL_API_TOKEN`，请求使用
`Authorization: Bearer <FIREWALL_API_TOKEN>`。浏览器来源通过 `FIREWALL_CORS_ORIGINS` 显式配置。

## OpenAI SDK 兼容调用

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

兼容范围为非流式文本 Chat Completions（含文本工具调用与 `response_format`）；
`stream=true`、多模态、`n>1`、`store=true` 等未实现能力会明确返回 400。
内部模块同样使用 `service.chat.completions.create(...) -> ChatCompletion`。

## 风险评估

在 `backend/` 下执行（若设置后端令牌，增加上述 Authorization 请求头）：

```bash
curl http://127.0.0.1:8000/api/v1/firewall/assess \
  -H 'Content-Type: application/json' \
  --data-binary @examples/delete.json

curl http://127.0.0.1:8000/api/v1/firewall/assess \
  -H 'Content-Type: application/json' \
  --data-binary @examples/purchase.json
```

接口返回介入等级、原因、原始事实依据和可选操作。所有生成的显示文案使用英语；
原始证据保留输入语言。
此层只做评估；实际暂停、执行、计时和再次确认由后续插件及执行层实现。
接口契约与接入约定见 [development_log.md](development_log.md)。

## 验证

```bash
cd backend
uv run pytest -q
uv run ruff check .
uv run ruff format --check .
```

测试使用模拟 Nebius 响应，不消耗真实推理额度。

## macOS 消息提醒模块

新增原生 Swift 菜单栏应用，默认暂停，仅检查显式指定应用中的输入框。
流程为：键盘事件触发 → 本地敏感词初筛 → 有限上下文交给 AI → 必要时弹出英语提醒。

先启动后端，然后在另一个终端执行：

```bash
cd desktop
swift run MessageGuard --app com.apple.TextEdit
```

从盾牌菜单选择 **Start protection…**，按提示授予 macOS Accessibility 和 Input Monitoring
权限后开启。可随时暂停。该版本在输入过程中提醒，不拦截发送。

详细安装、预览、权限和支持范围见 [desktop/README.md](desktop/README.md)。
新增接口为 `GET /api/v1/messages/terms` 和 `POST /api/v1/messages/assess`。

已配置密钥并启动后端后，可用合成文本进行真实 API 联调（会消耗推理额度）：

```bash
backend/.venv/bin/python backend/scripts/live_message_smoke.py --base-url http://127.0.0.1:8000
```
