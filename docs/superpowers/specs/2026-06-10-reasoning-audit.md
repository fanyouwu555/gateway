# Reasoning 功能审查记录

**日期:** 2026-06-10
**范围:** 网关 reasoning/thinking 跨 Provider 统一支持
**目标:** 兼容 OpenCode / Trae / Cursor / Claude Code 等 IDE 插件

---

## 审查结论

| 功能 | 状态 | 说明 |
|---|---|---|
| 流式 (streaming) | ✅ 已支持 | SSE 完整透传 |
| 工具调用 (tool calling) | ✅ 已支持 | Anthropic + OpenAI 兼容 Provider 完备 |
| 推理/思考 (reasoning) | ⚠️ 已修复 | Anthropic thinking block 提取 + 全 Provider capabilities 标记 |
| 格式化输出 (structured output) | ❌ 暂缓 | 用户决定暂不实现 |

---

## 发现的问题

### 问题 1：Anthropic Provider 不提取 thinking block（已修复）

**影响:** Anthropic 模型的 thinking/reasoning 内容丢失，IDE 插件无法显示 Claude 的思考过程。

**根因:** `AnthropicProvider.chat()` 只提取 `text` 和 `tool_use` content blocks；`parseAnthropicStream()` 只处理 `text_delta` 和 `input_json_delta`。

**修复:**
- `AnthropicContentBlock` 类型增加 `{ type: 'thinking'; thinking: string }`
- 非流式：从 content blocks 过滤 `thinking` 类型，映射到 `message.reasoning_content`
- 流式：在 `content_block_delta` 分支中增加 `thinking_delta` → `delta.reasoning_content` 处理

### 问题 2：流式 completion token 计数遗漏 reasoning（已修复）

**影响:** `src/routes/chat.ts:247` 中 `countCompletionTokens(accumulatedContent, model)` 未包含 `accumulatedReasoning`，导致：
- 用量统计偏低（DeepSeek R1 的 reasoning 可能占 50%+ tokens）
- 定价计算不准确

**修复:** `countCompletionTokens(accumulatedContent + accumulatedReasoning, model)`

### 问题 3：IProviderCapabilities 缺少 reasoning 标志（已修复）

**影响:** 路由层和模型列表无法感知 Provider 的 reasoning 能力。

**修复:** `IProviderCapabilities` 增加 `reasoning: boolean`，同步更新所有 Provider 和测试 mock。

### 问题 4：模型列表不暴露 capabilities（记录，暂不修复）

**影响:** `GET /v1/models` 返回字段不含 `capabilities`，IDE 插件无法通过 API 判断模型是否支持 reasoning。

**决策:** 暂不修复。需要 API 契约变更 + 前端适配，超出当前 scope。

### 问题 5：路由层未感知 reasoning 需求（记录，暂不修复）

**影响:** SmartRouter 基于 cost/latency/quality/balance 策略，没有 `has_reasoning` 条件。若配置不当，reasoning 模型请求可能被路由到无 reasoning 能力的 Provider。

**决策:** 暂不修复。用户通常直接指定模型名（如 `deepseek-reasoner`），路由按 `explicit_model` 匹配。

---

## 跨 Provider reasoning 统一映射

| Provider | 原始格式 | 网关统一输出 |
|---|---|---|
| DeepSeek / Kimi / 其他 OpenAI 兼容 | `choices[0].message.reasoning_content` | 直接透传 |
| Anthropic | `content` 中的 `thinking` block | 提取后映射到 `reasoning_content` |
| Google Gemini | 无 | 不支持 |

---

## 改动文件

**核心改动 (src):**
- `src/types/index.ts` — IProviderCapabilities 增加 `reasoning`
- `src/providers/anthropic/index.ts` — thinking block 提取（非流式+流式）
- `src/providers/dynamic.ts` — capabilities 读取 `reasoning`
- `src/routes/chat.ts` — 流式 token 计数包含 reasoning
- `src/providers/*/index.ts` × 13 — capabilities 加 `reasoning`
- `src/providers/registry.ts` — mock provider capabilities

**测试改动 (tests):**
- `tests/providers/anthropic.test.ts` — +3 个 reasoning 专项测试
- `tests/providers/base-provider.test.ts` — mock capabilities
- `tests/providers/openai-compatible.test.ts` — mock capabilities
- `tests/e2e/*.test.ts` × 5 — mock capabilities
- `tests/integration.test.ts` — mock capabilities
- `tests/opencode-integration.test.ts` — mock capabilities
- `tests/providers/failover-chain.test.ts` — mock capabilities
- `tests/providers/model-fallback.test.ts` — mock capabilities
- `tests/providers/stream-failover.test.ts` — mock capabilities
- `tests/routes/admin.test.ts` — mock capabilities
- `tests/services/model-equivalents.test.ts` — mock capabilities

---

## 验证结果

- `npm run lint` — ✅ 通过
- `npx tsc --noEmit` — ✅ 通过
- `npx jest --no-coverage` — ✅ 76 suites, 940 tests 全部通过
