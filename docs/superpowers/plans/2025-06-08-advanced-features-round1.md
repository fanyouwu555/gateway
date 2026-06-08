# 网关高级功能支持 Round 1 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复 OpenAI 兼容 Provider 的流式响应字段过滤问题，使 reasoning、tool calling、multimodal 的流式响应能完整透传到客户端。

**Architecture:** 保留 `BaseProvider.parseStream()` 中现有兜底值的同时，通过展开运算符透传原始 chunk 的所有额外字段。同步修正类型定义和 Provider 能力声明。

**Tech Stack:** TypeScript, Jest, Node.js ReadableStream, SSE

---

## File Structure

| File | Responsibility | Action |
|------|---------------|--------|
| `src/types/index.ts` | 共享类型定义 | Modify: 扩展 `ChatCompletionChunk.finish_reason` |
| `src/providers/base.ts` | BaseProvider 抽象类 | Modify: `parseStream()` 透传额外字段 |
| `src/providers/deepseek/index.ts` | DeepSeek Provider | Modify: `function_call: true` |
| `src/providers/dynamic.ts` | DynamicProvider | Modify: body 构建增加 `tools`/`tool_choice` |
| `tests/providers/base-provider.test.ts` | BaseProvider 测试 | Modify: 新增透传字段测试 |
| `tests/providers/openai-compatible.test.ts` | OpenAICompatibleProvider 测试 | Modify: 新增流式工具调用测试 |
| `tests/providers/dynamic.test.ts` | DynamicProvider 测试 | Modify: 新增 tools 透传测试 |

---

### Task 1: 类型定义修正

**Files:**
- Modify: `src/types/index.ts:124`

- [ ] **Step 1: 扩展 `ChatCompletionChunk` 的 `finish_reason` 类型**

  将 `finish_reason` 从 `'stop' | 'length' | null` 扩展为 `'stop' | 'length' | 'tool_calls' | null`：

  ```typescript
  // src/types/index.ts 第 116-126 行附近
  export interface ChatCompletionChunk {
    id: string;
    object: 'chat.completion.chunk';
    created: number;
    model: string;
    choices: Array<{
      index: number;
      delta: ChatMessage;
      finish_reason: 'stop' | 'length' | 'tool_calls' | null;
    }>;
  }
  ```

  找到当前代码（约第 124 行）：
  ```typescript
  finish_reason: 'stop' | 'length' | null;
  ```

  替换为：
  ```typescript
  finish_reason: 'stop' | 'length' | 'tool_calls' | null;
  ```

- [ ] **Step 2: 运行类型检查**

  Run: `npx tsc --noEmit`
  Expected: 无错误（类型扩展是向后兼容的）

- [ ] **Step 3: Commit**

  ```bash
  git add src/types/index.ts
  git commit -m "types: extend ChatCompletionChunk finish_reason to include 'tool_calls'"
  ```

---

### Task 2: `parseStream` 透传额外字段

**Files:**
- Modify: `src/providers/base.ts:128-137`
- Test: `tests/providers/base-provider.test.ts`

- [ ] **Step 1: 修改 `parseStream()` 实现**

  找到 `src/providers/base.ts` 中 `parseStream` 方法内的 chunk 组装代码（约第 128-137 行）：

  ```typescript
  const parsed = JSON.parse(data);
  const chunk = {
    id: parsed.id || '',
    object: 'chat.completion.chunk',
    created: parsed.created || Date.now(),
    model: parsed.model || '',
    choices: parsed.choices || [],
  };
  controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(chunk)}\n\n`));
  ```

  替换为：

  ```typescript
  const parsed = JSON.parse(data);
  const chunk = {
    ...parsed,
    id: parsed.id || '',
    object: parsed.object || 'chat.completion.chunk',
    created: parsed.created || Date.now(),
    model: parsed.model || '',
    choices: parsed.choices || [],
  };
  controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(chunk)}\n\n`));
  ```

  **关键原理**：`{...parsed}` 展开所有原始字段，后面的固定字段会覆盖同名字段（如果有的话），同时保留兜底值。这样原始 chunk 中的 `system_fingerprint`、`usage`、`reasoning_content` 等都会被保留。

- [ ] **Step 2: 运行现有 BaseProvider 测试确保未破坏**

  Run: `npx jest tests/providers/base-provider.test.ts --no-coverage`
  Expected: 全部通过（3 个 describe 块：buildHeaders、fetch、parseStream）

- [ ] **Step 3: 编写 `parseStream` 透传字段测试**

  在 `tests/providers/base-provider.test.ts` 的 `describe('parseStream')` 块中，在现有测试之后新增：

  ```typescript
  it('should pass through extra fields in stream chunks', async () => {
    const provider = new TestProvider();
    const encoder = new TextEncoder();
    const source = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(
          'data: {"id":"1","object":"chat.completion.chunk","created":1234567890,"model":"gpt-4","system_fingerprint":"fp-test","choices":[{"index":0,"delta":{"role":"assistant","content":"hi","reasoning_content":"think"},"finish_reason":null}]}\n\n'
        ));
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      },
    });

    const stream = (provider as any).parseStream(source);
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    const chunks: string[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(decoder.decode(value));
    }

    expect(chunks.length).toBeGreaterThan(0);
    const firstChunk = chunks[0];
    expect(firstChunk).toContain('system_fingerprint');
    expect(firstChunk).toContain('fp-test');
    expect(firstChunk).toContain('reasoning_content');
    expect(firstChunk).toContain('think');
    // 验证兜底值仍然有效
    expect(firstChunk).toContain('"object":"chat.completion.chunk"');
  });

  it('should pass through tool_calls delta in stream chunks', async () => {
    const provider = new TestProvider();
    const encoder = new TextEncoder();
    const source = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(
          'data: {"id":"2","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"get_weather","arguments":""}}]},"finish_reason":null}]}\n\n'
        ));
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      },
    });

    const stream = (provider as any).parseStream(source);
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    const chunks: string[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(decoder.decode(value));
    }

    expect(chunks.length).toBeGreaterThan(0);
    const firstChunk = chunks[0];
    expect(firstChunk).toContain('tool_calls');
    expect(firstChunk).toContain('get_weather');
  });

  it('should preserve fallback values when fields are missing', async () => {
    const provider = new TestProvider();
    const encoder = new TextEncoder();
    const source = new ReadableStream({
      start(controller) {
        // 故意缺少 id、created、model、object、choices
        controller.enqueue(encoder.encode(
          'data: {"custom_field":"value"}\n\n'
        ));
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      },
    });

    const stream = (provider as any).parseStream(source);
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    const chunks: string[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(decoder.decode(value));
    }

    expect(chunks.length).toBeGreaterThan(0);
    const firstChunk = chunks[0];
    const parsedChunk = JSON.parse(firstChunk.replace(/^data: /, ''));
    expect(parsedChunk.id).toBe('');
    expect(parsedChunk.object).toBe('chat.completion.chunk');
    expect(parsedChunk.created).toBeGreaterThan(0);
    expect(parsedChunk.model).toBe('');
    expect(parsedChunk.choices).toEqual([]);
    expect(parsedChunk.custom_field).toBe('value');
  });
  ```

- [ ] **Step 4: 运行新增测试**

  Run: `npx jest tests/providers/base-provider.test.ts --no-coverage`
  Expected: 全部通过（原有 3 个 + 新增 3 个 = 6 个测试）

- [ ] **Step 5: Commit**

  ```bash
  git add src/providers/base.ts tests/providers/base-provider.test.ts
  git commit -m "feat: pass through extra fields in parseStream while preserving fallbacks"
  ```

---

### Task 3: DeepSeek 能力声明修正

**Files:**
- Modify: `src/providers/deepseek/index.ts:15`

- [ ] **Step 1: 修改 DeepSeek 的 `function_call` 声明**

  找到 `src/providers/deepseek/index.ts`：

  ```typescript
  export const deepseekProvider = new OpenAICompatibleProvider({
    name: 'deepseek',
    capabilities: {
      chat: true,
      embed: true,
      streaming: true,
      vision: false,
      function_call: false,  // <-- 改这一行
    },
    // ...
  });
  ```

  将 `function_call: false` 改为 `function_call: true`。

- [ ] **Step 2: Commit**

  ```bash
  git add src/providers/deepseek/index.ts
  git commit -m "fix(deepseek): correct function_call capability to true"
  ```

---

### Task 4: DynamicProvider 增加 `tools`/`tool_choice` 透传

**Files:**
- Modify: `src/providers/dynamic.ts:36-61` (chat) 和 `63-97` (chatStream)
- Test: `tests/providers/dynamic.test.ts`

- [ ] **Step 1: 修改 `chat()` 方法中的 body 构建**

  找到 `src/providers/dynamic.ts` 的 `chat()` 方法（约第 36-61 行）：

  ```typescript
  const body = {
    model: request.model,
    messages: request.messages,
    temperature: request.temperature,
    top_p: request.top_p,
    max_tokens: request.max_tokens,
    stream: false,
    stop: request.stop,
    presence_penalty: request.presence_penalty,
    frequency_penalty: request.frequency_penalty,
    user: request.user,
  };
  ```

  在该对象后增加：

  ```typescript
  if (request.tools && request.tools.length > 0) {
    (body as Record<string, unknown>).tools = request.tools;
  }
  if (request.tool_choice) {
    (body as Record<string, unknown>).tool_choice = request.tool_choice;
  }
  ```

- [ ] **Step 2: 修改 `chatStream()` 方法中的 body 构建**

  找到 `src/providers/dynamic.ts` 的 `chatStream()` 方法（约第 71-82 行）：

  ```typescript
  const body = {
    model: request.model,
    messages: request.messages,
    temperature: request.temperature,
    top_p: request.top_p,
    max_tokens: request.max_tokens,
    stream: true,
    stop: request.stop,
    presence_penalty: request.presence_penalty,
    frequency_penalty: request.frequency_penalty,
    user: request.user,
  };
  ```

  在该对象后增加同样的条件：

  ```typescript
  if (request.tools && request.tools.length > 0) {
    (body as Record<string, unknown>).tools = request.tools;
  }
  if (request.tool_choice) {
    (body as Record<string, unknown>).tool_choice = request.tool_choice;
  }
  ```

- [ ] **Step 3: 运行现有 DynamicProvider 测试**

  Run: `npx jest tests/providers/dynamic.test.ts --no-coverage`
  Expected: 全部通过（现有 15 个测试）

- [ ] **Step 4: 编写 DynamicProvider tools 透传测试**

  在 `tests/providers/dynamic.test.ts` 的 `describe('chat')` 块中，在 `should include optional fields in body when provided` 测试之后新增：

  ```typescript
  it('should include tools and tool_choice in body when provided', async () => {
    const config: DynamicProviderConfig = {
      name: 'test',
      base_url: 'https://api.example.com',
      endpoints: { chat: '/chat' },
    };

    const provider = new DynamicProvider(config);

    mockFetchWithAgent.mockResolvedValue({
      ok: true,
      json: async () => ({
        id: 'chat-1',
        object: 'chat.completion',
        created: 1,
        model: 'test-model',
        choices: [],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    });

    const request: ChatCompletionRequest = {
      model: 'test-model',
      messages: [{ role: 'user', content: 'hello' }],
      tools: [{ type: 'function', function: { name: 'fn', description: 'desc', parameters: {} } }],
      tool_choice: { type: 'function', function: { name: 'fn' } },
    };

    await provider.chat(request, providerConfig);

    const callBody = JSON.parse(mockFetchWithAgent.mock.calls[0][1].body);
    expect(callBody.tools).toEqual(request.tools);
    expect(callBody.tool_choice).toEqual(request.tool_choice);
  });

  it('should not include tools when tools array is empty', async () => {
    const config: DynamicProviderConfig = {
      name: 'test',
      base_url: 'https://api.example.com',
      endpoints: { chat: '/chat' },
    };

    const provider = new DynamicProvider(config);

    mockFetchWithAgent.mockResolvedValue({
      ok: true,
      json: async () => ({
        id: 'chat-1',
        object: 'chat.completion',
        created: 1,
        model: 'test-model',
        choices: [],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    });

    const request: ChatCompletionRequest = {
      model: 'test-model',
      messages: [{ role: 'user', content: 'hello' }],
      tools: [],
    };

    await provider.chat(request, providerConfig);

    const callBody = JSON.parse(mockFetchWithAgent.mock.calls[0][1].body);
    expect(callBody.tools).toBeUndefined();
  });
  ```

  在 `describe('chatStream')` 块中，在 `should set stream to true in body` 测试之后新增：

  ```typescript
  it('should include tools and tool_choice in stream body when provided', async () => {
    const config: DynamicProviderConfig = {
      name: 'test',
      base_url: 'https://api.example.com',
      endpoints: { chat_stream: '/chat/stream' },
    };

    const provider = new DynamicProvider(config);

    const stream = new ReadableStream({
      start(controller) {
        controller.close();
      },
    });

    mockFetchWithAgent.mockResolvedValue({
      ok: true,
      body: stream,
    });

    const request: ChatCompletionRequest = {
      model: 'test-model',
      messages: [{ role: 'user', content: 'hello' }],
      tools: [{ type: 'function', function: { name: 'fn', description: 'desc', parameters: {} } }],
      tool_choice: 'auto',
    };

    await provider.chatStream(request, providerConfig);

    const callBody = JSON.parse(mockFetchWithAgent.mock.calls[0][1].body);
    expect(callBody.tools).toEqual(request.tools);
    expect(callBody.tool_choice).toBe('auto');
    expect(callBody.stream).toBe(true);
  });
  ```

- [ ] **Step 5: 运行新增测试**

  Run: `npx jest tests/providers/dynamic.test.ts --no-coverage`
  Expected: 全部通过（原有 15 个 + 新增 3 个 = 18 个测试）

- [ ] **Step 6: Commit**

  ```bash
  git add src/providers/dynamic.ts tests/providers/dynamic.test.ts
  git commit -m "feat(dynamic-provider): pass through tools and tool_choice in request body"
  ```

---

### Task 5: OpenAICompatibleProvider 流式测试增强

**Files:**
- Test: `tests/providers/openai-compatible.test.ts`

- [ ] **Step 1: 编写流式 reasoning_content 和 tool_calls 测试**

  在 `tests/providers/openai-compatible.test.ts` 的 `describe('chatStream')` 块中，在最后一个测试之后新增：

  ```typescript
  it('should pass through reasoning_content in stream chunks', async () => {
    const provider = new OpenAICompatibleProvider({
      name: 'test',
      capabilities: { chat: true, embed: false, streaming: true, vision: false, function_call: false },
    });

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(
          'data: {"id":"1","object":"chat.completion.chunk","created":1234567890,"model":"deepseek-reasoner","choices":[{"index":0,"delta":{"role":"assistant","content":"","reasoning_content":"Let me think"},"finish_reason":null}]}\n\n'
        ));
        controller.enqueue(encoder.encode(
          'data: {"id":"1","choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}\n\n'
        ));
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      },
    });

    mockFetchWithAgent.mockResolvedValue({
      ok: true,
      body: stream,
    });

    const request: ChatCompletionRequest = {
      model: 'deepseek-reasoner',
      messages: [{ role: 'user', content: 'hello' }],
    };

    const result = await provider.chatStream(request, providerConfig);
    expect(result).toBeInstanceOf(ReadableStream);

    // 读取流并验证 reasoning_content 被保留
    const reader = result.getReader();
    const decoder = new TextDecoder();
    const chunks: string[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(decoder.decode(value));
    }

    const firstChunk = chunks[0];
    expect(firstChunk).toContain('reasoning_content');
    expect(firstChunk).toContain('Let me think');
  });

  it('should pass through tool_calls delta in stream chunks', async () => {
    const provider = new OpenAICompatibleProvider({
      name: 'test',
      capabilities: { chat: true, embed: false, streaming: true, vision: false, function_call: true },
      fields: { tools: true },
    });

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(
          'data: {"id":"2","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"get_weather"}}]},"finish_reason":null}]}\n\n'
        ));
        controller.enqueue(encoder.encode(
          'data: {"id":"2","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"location\\":\\"Beijing\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n'
        ));
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      },
    });

    mockFetchWithAgent.mockResolvedValue({
      ok: true,
      body: stream,
    });

    const request: ChatCompletionRequest = {
      model: 'gpt-4',
      messages: [{ role: 'user', content: 'What is the weather?' }],
      tools: [{ type: 'function', function: { name: 'get_weather', description: 'Get weather', parameters: { type: 'object', properties: {} } } }],
    };

    const result = await provider.chatStream(request, providerConfig);
    const reader = result.getReader();
    const decoder = new TextDecoder();
    const chunks: string[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(decoder.decode(value));
    }

    const firstChunk = chunks[0];
    expect(firstChunk).toContain('tool_calls');
    expect(firstChunk).toContain('get_weather');

    // 验证 finish_reason='tool_calls' 被保留
    const secondChunk = chunks[1];
    expect(secondChunk).toContain('"finish_reason":"tool_calls"');
  });
  ```

- [ ] **Step 2: 运行测试**

  Run: `npx jest tests/providers/openai-compatible.test.ts --no-coverage`
  Expected: 全部通过（原有 15 个 + 新增 2 个 = 17 个测试）

- [ ] **Step 3: Commit**

  ```bash
  git add tests/providers/openai-compatible.test.ts
  git commit -m "test(openai-compatible): add stream tests for reasoning_content and tool_calls"
  ```

---

### Task 6: 全量验证

- [ ] **Step 1: 运行 Linter**

  Run: `npm run lint`
  Expected: 无错误

- [ ] **Step 2: 运行类型检查**

  Run: `npx tsc --noEmit`
  Expected: 无错误

- [ ] **Step 3: 运行全量测试**

  Run: `npm test`
  Expected: 全部通过（当前基线 395 个测试，预期增加到 401 个）

- [ ] **Step 4: Commit（如全量通过则标记完成）**

  如果上述全部通过，Round 1 完成。不需要额外 commit（每个 Task 已分别 commit）。

---

## Self-Review Checklist

**1. Spec coverage:**
- [x] `finish_reason` 扩展 → Task 1
- [x] `parseStream` 透传 → Task 2
- [x] DeepSeek `function_call` 修正 → Task 3
- [x] DynamicProvider `tools`/`tool_choice` → Task 4
- [x] 测试覆盖 → Task 2/4/5
- [x] 全量验证 → Task 6

**2. Placeholder scan:**
- [x] 无 "TBD"、"TODO"、"implement later"
- [x] 所有代码块包含完整代码
- [x] 所有命令包含预期输出

**3. Type consistency:**
- [x] `ChatCompletionChunk.finish_reason` 在类型定义和测试中一致使用 `'tool_calls'`
- [x] `parseStream` 的兜底字段名（`id`, `object`, `created`, `model`, `choices`）与原始代码一致
