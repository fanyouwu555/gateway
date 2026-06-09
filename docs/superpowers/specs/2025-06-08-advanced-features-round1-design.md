# 网关高级功能支持 — Round 1 设计文档

## 背景

AI Gateway 当前在类型定义和验证层已支持 reasoning、tool calling、multimodal 的字段声明，但在 OpenAI 兼容 Provider 的流式响应处理中，`BaseProvider.parseStream()` 会过滤掉原始 SSE chunk 中的额外字段（如 `reasoning_content`、`tool_calls` delta、`system_fingerprint`、`usage` 等），导致用户通过网关访问 DeepSeek R1、GPT-4o 等模型时，无法获得完整的思考过程、工具调用结果或多模态响应。

## 目标

让使用 OpenAI 兼容协议的所有 Provider 能够**完整透传** reasoning、tool calling、multimodal 的流式和非流式响应，不做字段截断。

## 范围

### 包含（Round 1）
- OpenAI 兼容 Provider（openai, deepseek, groq, mistral, moonshot, volcano, azure-openai, kimi-code, cohere, together, xai）
- 流式响应字段透传
- 非流式响应字段透传（已有，无需改动）
- 类型定义修正
- Provider 能力声明修正（确认错误的部分）

### 排除（后续 Round）
- Anthropic Provider 格式转换（Round 2）
- Google Provider 格式转换（Round 3）
- 新增适配层抽象
- 模型级能力声明（vs Provider 级）

## 详细设计

### 1. 类型层修正（`src/types/index.ts`）

**问题**：`ChatCompletionChunk.choices[].finish_reason` 只支持 `'stop' | 'length' | null`，但 tool calls 结束时应该是 `'tool_calls'`。

**改动**：
```typescript
// ChatCompletionChunk 中
finish_reason: 'stop' | 'length' | 'tool_calls' | null;
```

`ChatChoice.finish_reason` 已有 `'tool_calls'`，无需改动。

### 2. 流式解析透传（`src/providers/base.ts` `parseStream()`）

**问题**：当前实现只提取固定字段：
```typescript
const chunk = {
  id: parsed.id || '',
  object: 'chat.completion.chunk',
  created: parsed.created || Date.now(),
  model: parsed.model || '',
  choices: parsed.choices || [],
};
```

这导致 `system_fingerprint`、`usage`（部分 Provider 在流式中发送）、delta 中的 `reasoning_content`、`tool_calls`、`function_call` 等全部丢失。

**改动**：保留原有兜底值，同时透传原始 parsed 中的所有其他字段：
```typescript
const chunk = {
  ...parsed,
  id: parsed.id || '',
  object: parsed.object || 'chat.completion.chunk',
  created: parsed.created || Date.now(),
  model: parsed.model || '',
  choices: parsed.choices || [],
};
```

**原理**：OpenAI 兼容 Provider 返回的数据本身就是标准 OpenAI 格式，透传不会引入格式问题。非标准字段（如 DeepSeek 的 `reasoning_content`）也会被保留。

**边缘情况处理**：
- SSE 中可能包含非 chunk 事件（如 `[DONE]`、`error`、`ping`），这些在现有逻辑中已被过滤
- `parsed` 可能不是对象（解析失败），`catch` 块会忽略
- `object` 字段缺失时兜底为 `'chat.completion.chunk'`

### 3. Provider 能力声明修正

**DeepSeek**（`src/providers/deepseek/index.ts`）：
- 当前：`function_call: false`
- 实际：DeepSeek V3/V2.5 支持 function calling
- 改为：`function_call: true`

**Groq**：保持现状。Groq 的能力取决于底层模型（Llama-3.2 支持 vision，Mixtral 支持 tools），Provider 级声明无法准确反映，留到后续模型级能力声明解决。

**Google**：保持现状，Round 3 处理。

### 4. 消息体透传确认（`src/providers/openai-compatible.ts` `buildChatBody()`）

经审查，`buildChatBody` 中 `messages: request.messages` 是原样传递，`ChatMessage` 中的 `reasoning_content`、`tool_calls`、`tool_call_id`、`content`（含 `image_url` 数组）都会完整发给 Provider。

**无需改动。**

### 5. DynamicProvider 消息体透传（`src/providers/dynamic.ts`）

**问题**：`chat()` 和 `chatStream()` 的 body 构建中未包含 `tools` 和 `tool_choice`，导致通过配置文件动态添加的 Provider 无法使用工具调用。

**改动**：在 body 构建中增加条件透传：
```typescript
if (request.tools && request.tools.length > 0) {
  body.tools = request.tools;
}
if (request.tool_choice) {
  body.tool_choice = request.tool_choice;
}
```

### 6. 聊天路由确认（`src/routes/chat.ts`）

经审查：
- 非流式响应已提取 `reasoning_content` 和 `tool_calls` 到会话日志
- 流式响应已在 `handleStreamingResponse` 中累积 `reasoning_content` 和 `tool_calls`
- 透传修复后，这些字段会出现在 SSE 中，路由层无需改动

**无需改动。**

## 改动清单

| 文件 | 改动内容 | 行数估算 |
|------|---------|---------|
| `src/types/index.ts` | 扩展 `ChatCompletionChunk.finish_reason` | +1 |
| `src/providers/base.ts` | `parseStream()` 改为透传原始字段 | +2/-5 |
| `src/providers/deepseek/index.ts` | `function_call: true` | +1/-1 |
| `src/providers/dynamic.ts` | body 构建增加 tools/tool_choice 透传 | +6 |
| `tests/providers/base-provider.test.ts` | 新增透传字段测试 | +30 |
| `tests/providers/openai-compatible.test.ts` | 新增流式 reasoning/tool_calls 测试 | +40 |

## 测试策略

### 新增测试

1. **`parseStream` 透传测试**（`base-provider.test.ts`）
   - 输入：包含 `system_fingerprint`、`usage`、`choices.delta.reasoning_content` 的 SSE 数据
   - 断言：输出 chunk 中保留所有原始字段

2. **`parseStream` tool_calls delta 测试**
   - 输入：包含 `choices.delta.tool_calls` 的 SSE 数据
   - 断言：输出 chunk 中保留 `tool_calls`

3. **`chatStream` 完整流测试**（`openai-compatible.test.ts`）
   - Mock 返回包含 reasoning_content 和 tool_calls 的 SSE 流
   - 断言：消费者能读取到完整字段

### 现有测试保护

- `npm test` 全部通过（确保透传改动不破坏现有行为）
- `tests/routes/chat.test.ts` 通过（确保路由层不受影晌）

## 验证方式

实施后的验收 checklist：

- [ ] `npm run lint` 无错误
- [ ] `npx tsc --noEmit` 无类型错误
- [ ] `npm test` 全部通过（当前 395 测试）
- [ ] 新增测试覆盖透传场景

## 风险分析

| 风险 | 可能性 | 影响 | 缓解措施 |
|------|--------|------|---------|
| 透传引入 Provider 特有字段导致下游客户端不兼容 | 低 | 中 | OpenAI 格式本身允许扩展字段；客户端应忽略未知字段 |
| `object` 兜底值与 Provider 实际发送的不一致 | 低 | 低 | 仅影响极少数不发送 `object` 的 Provider |
| 现有测试因 chunk 格式变化而失败 | 低 | 低 | 测试只检查 `chat.completion.chunk` 字符串存在，不检查字段数量 |

## 后续轮次

### Round 2：Anthropic Provider 增强
- 消息转换支持 `tool_calls`、`tool_call_id`、`reasoning_content`
- 响应转换支持 `tool_calls`、`reasoning_content`
- 多模态内容转换（Anthropic 的 image 格式与 OpenAI 不同）

### Round 3：Google Provider 增强
- Gemini 的 `tools`/`toolConfig` 参数映射
- 多模态内容转换（Gemini 的 `inlineData`/`fileData` 格式）
- 流式响应中的 function call 处理

### Round 4：统一能力声明
- 引入模型级能力声明（替代 Provider 级）
- 修正 Groq、Google 等 Provider 的声明

## 决策记录

- **决策**：采用透传而非白名单策略
- **理由**：OpenAI 兼容 Provider 返回的数据本身就是标准格式，白名单维护成本高且容易遗漏新字段
- **替代方案**：维护一个允许透传的字段白名单（被否决，因为 OpenAI  API 经常新增字段）
