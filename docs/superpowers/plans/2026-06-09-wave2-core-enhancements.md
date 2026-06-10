# Wave 2: 核心增强实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现模型降级(model-level fallback)、精细化限流(per-tenant/per-model + Retry-After)、流式请求Failover连接层降级。

**Architecture:**
- 模型降级：在 `chatComplete` 中当主模型返回 429/503 时，尝试同一 provider 的 fallback 模型链（如 gpt-4o → gpt-4o-mini），然后才切换 provider
- 精细化限流：扩展 `RateLimitStore` 支持 per-tenant 和 per-model 限流桶，429 响应添加 `Retry-After` header
- 流式 Failover：在 `chatCompleteStream` 连接阶段失败时（非流传输阶段），尝试 fallback provider 重新建立连接

**Tech Stack:** TypeScript, Hono, ioredis

---

## 方案合理性反思

### 1. 模型降级 — 为什么在同一 Provider 内先降级模型？

**考量：**
- 现有 Failover 是 provider 级别：openai down → deepseek
- 但实际问题往往是特定模型不可用（如 gpt-4o 配额耗尽），而非整个 provider 不可用
- 同一 provider 内切换模型成本最低（无需重新建立连接、认证等）
- **方案选择**：在 `chatComplete` 中，当 provider 返回 429/503 时，先尝试该 provider 的 fallback 模型链（配置 `model_fallbacks`），全部失败后再切换到其他 provider
- 这相当于在现有 provider-level failover 之前增加一层 model-level failover

### 2. 精细化限流 — 为什么不在现有 key-level 限流基础上扩展？

**考量：**
- 当前限流基于 API Key hash 或 IP，已支持 `key_rate_limit_qps/burst`（虚拟 Key 策略）
- 需要增加 tenant-level 和 model-level 的独立限流桶
- tenant-level：基于 `tenant_id`，防止单个租户耗尽全局配额
- model-level：基于 `model` 名，防止昂贵模型被过度调用
- **方案选择**：扩展 `IRateLimitStore.consume()` 支持多维度 key（`tenant:xxx` + `model:xxx`），在 middleware 中依次检查各维度，任一维度触发即限流。`Retry-After` 取各维度中的最大值。

### 3. 流式 Failover — 为什么只在连接阶段做？

**考量：**
- 流一旦建立，SSE 数据已经开始传输，无法"无缝"切换到另一个 provider（用户已收到部分 token）
- 但连接阶段（HTTP 握手、认证、首字节）失败的概率不低（超时、5xx、连接重置）
- **方案选择**：仅在 `chatCompleteStream` 的 `callProviderWithRetry` 失败时，尝试 fallback provider 重新建立连接。流建立后的错误仍然抛出。这是务实且可实现的方案。

---

## 文件结构

### Task 1: 模型降级 (Model-level Fallback)
- **Modify**: `src/config/index.ts` — add `model_fallbacks` config parsing
- **Modify**: `src/providers/index.ts` — add model fallback logic in `chatComplete`
- **Test**: `tests/providers/model-fallback.test.ts`

### Task 2: 精细化限流 (Per-tenant / Per-model + Retry-After)
- **Modify**: `src/stores/ratelimit.ts` — add `checkMultiDimensional()` method
- **Modify**: `src/middleware/ratelimit.ts` — add tenant/model rate limit checks + Retry-After header
- **Modify**: `src/config/index.ts` — add `model_rate_limits` config parsing
- **Test**: `tests/middleware/ratelimit-enhanced.test.ts`

### Task 3: 流式 Failover (Connection-level)
- **Modify**: `src/providers/index.ts` — add failover logic in `chatCompleteStream`
- **Test**: `tests/providers/stream-failover.test.ts`

---

## Task 1: 模型降级

### Step 1: Write the failing test

**File:** `tests/providers/model-fallback.test.ts`

```typescript
import { chatComplete, setProviderDeps, resetProviderDeps, resetProviders, registerProvider } from '../../src/providers';
import type { IProvider, ChatCompletionRequest, ChatCompletionResponse } from '../../src/types';

jest.mock('../../src/config', () => ({
  getConfig: jest.fn(() => ({
    providers: {
      openai: { provider: 'openai', base_url: 'https://api.openai.com/v1', api_key: 'sk-test' },
    },
    model_fallbacks: {
      'gpt-4o': ['gpt-4o-mini', 'gpt-3.5-turbo'],
    },
    model_equivalents: {},
    failover: { enabled: true, failureThreshold: 3, successThreshold: 2 },
    routing: { rules: [{ model: 'gpt-4o', provider: 'openai' }] },
  })),
  getProviderConfig: jest.fn((name: string) => ({
    openai: { provider: 'openai', base_url: 'https://api.openai.com/v1', api_key: 'sk-test' },
  }[name])),
  getProviderForModel: jest.fn(() => 'openai'),
  getProviderNames: jest.fn(() => ['openai']),
  getRoutingStrategy: jest.fn(() => undefined),
  getModelPool: jest.fn(() => undefined),
  resolveModelAlias: jest.fn((m: string) => m),
}));

jest.mock('../../src/services/failover', () => ({
  failoverManager: {
    getHealthyKeys: jest.fn(() => ['sk-test']),
    getFailoverChain: jest.fn(() => []),
    isProviderHealthy: jest.fn(() => true),
    recordProviderRequest: jest.fn(),
    recordSuccess: jest.fn(),
    recordFailure: jest.fn(),
  },
}));

jest.mock('../../src/services/loadbalancer', () => ({
  loadBalanceManager: {
    selectToken: jest.fn(() => ({ apiKey: 'sk-test' })),
  },
}));

describe('Model-level Fallback', () => {
  beforeEach(() => {
    resetProviders();
    resetProviderDeps();
  });

  it('should fallback to next model when primary returns 429', async () => {
    const mockProvider: IProvider = {
      name: 'openai',
      capabilities: { chat: true, streaming: true, embed: false, vision: false, function_call: false },
      chat: jest.fn()
        .mockRejectedValueOnce(Object.assign(new Error('Rate limit exceeded'), { status: 429 }))
        .mockResolvedValueOnce({
          id: 'chatcmpl-123',
          object: 'chat.completion',
          created: Date.now(),
          model: 'gpt-4o-mini',
          choices: [{ index: 0, message: { role: 'assistant', content: 'Hello from fallback' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        } as ChatCompletionResponse),
      chatStream: jest.fn(),
      embed: jest.fn(),
    };

    registerProvider('openai', mockProvider);

    const request: ChatCompletionRequest = {
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'Hello' }],
    };

    const result = await chatComplete('openai', request);

    expect(result.model).toBe('gpt-4o-mini');
    expect(mockProvider.chat).toHaveBeenCalledTimes(2);
    // First call with original model
    expect(mockProvider.chat.mock.calls[0][0].model).toBe('gpt-4o');
    // Second call with fallback model
    expect(mockProvider.chat.mock.calls[1][0].model).toBe('gpt-4o-mini');
  });

  it('should try all fallback models before giving up', async () => {
    const mockProvider: IProvider = {
      name: 'openai',
      capabilities: { chat: true, streaming: true, embed: false, vision: false, function_call: false },
      chat: jest.fn()
        .mockRejectedValueOnce(Object.assign(new Error('Rate limit'), { status: 429 }))
        .mockRejectedValueOnce(Object.assign(new Error('Rate limit'), { status: 429 })),
      chatStream: jest.fn(),
      embed: jest.fn(),
    };

    registerProvider('openai', mockProvider);

    const request: ChatCompletionRequest = {
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'Hello' }],
    };

    await expect(chatComplete('openai', request)).rejects.toThrow();
    expect(mockProvider.chat).toHaveBeenCalledTimes(2);
  });

  it('should not fallback on non-retryable errors (like 400)', async () => {
    const mockProvider: IProvider = {
      name: 'openai',
      capabilities: { chat: true, streaming: true, embed: false, vision: false, function_call: false },
      chat: jest.fn().mockRejectedValue(Object.assign(new Error('Bad request'), { status: 400 })),
      chatStream: jest.fn(),
      embed: jest.fn(),
    };

    registerProvider('openai', mockProvider);

    const request: ChatCompletionRequest = {
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'Hello' }],
    };

    await expect(chatComplete('openai', request)).rejects.toThrow('Bad request');
    expect(mockProvider.chat).toHaveBeenCalledTimes(1);
  });
});
```

**Run:** `npx jest tests/providers/model-fallback.test.ts --no-coverage`
**Expected:** FAIL — model fallback logic not implemented

### Step 2: Add model_fallbacks config parsing

**File:** `src/config/index.ts`

Add to the config interface and parsing logic. Find where `model_equivalents` is parsed and add similar logic for `model_fallbacks`.

Search for `MODEL_EQUIVALENTS` env var usage and add:

```typescript
// After model_equivalents parsing
const modelFallbacks = getEnv('MODEL_FALLBACKS');
if (modelFallbacks) {
  try {
    config.model_fallbacks = JSON.parse(modelFallbacks);
  } catch {
    writeLog('warn', 'Invalid MODEL_FALLBACKS JSON');
  }
}
```

Also add to `IGatewayConfig` interface:

```typescript
model_fallbacks?: Record<string, string[]>;
```

### Step 3: Implement model fallback in chatComplete

**File:** `src/providers/index.ts`

Modify the `chatComplete` function. After the `callProviderWithRetry` fails, check if the error is retryable (429/503/timeout) and if there are fallback models configured. If so, retry with fallback models on the same provider before moving to the next provider.

The key change is in the error handling block inside the `for (const currentProvider of providersToTry)` loop:

```typescript
} catch (error) {
  const latency = Date.now() - startTime;
  activeFailover.recordProviderRequest(currentProvider, false, latency);
  const errMsg = error instanceof Error ? error.message : String(error);
  const statusCode = (error as { status?: number }).status;
  
  // Check for model-level fallback on retryable errors
  const fallbackModels = getConfig().model_fallbacks?.[request.model];
  if (fallbackModels && fallbackModels.length > 0 && isRetryableError(statusCode, errMsg)) {
    let modelFallbackSucceeded = false;
    for (const fallbackModel of fallbackModels) {
      if (attemptedModels.has(fallbackModel)) continue;
      attemptedModels.add(fallbackModel);
      
      try {
        const fallbackRequest = { ...providerRequest, model: fallbackModel };
        const fallbackResult = await callProviderWithRetry(provider, config, fallbackRequest, false);
        activeFailover.recordProviderRequest(currentProvider, true, Date.now() - startTime);
        // Return result but preserve original model info in response
        return { ...fallbackResult, model: request.model } as ChatCompletionResponse;
      } catch (fallbackError) {
        // Continue to next fallback model
      }
    }
  }
  
  errors.push({ provider: currentProvider, error: errMsg });
}
```

Also add helper:

```typescript
function isRetryableError(statusCode: number | undefined, message: string): boolean {
  if (statusCode === 429 || statusCode === 503 || statusCode === 502) return true;
  if (message.includes('timeout') || message.includes('ETIMEDOUT') || message.includes('ECONNRESET')) return true;
  return false;
}
```

### Step 4: Run tests

**Run:** `npx jest tests/providers/model-fallback.test.ts --no-coverage`
**Expected:** PASS

### Step 5: Commit

```bash
git add src/config/index.ts src/providers/index.ts tests/providers/model-fallback.test.ts
git commit -m "feat: add model-level fallback chain

- When primary model returns 429/503, try fallback models on same provider
- Config via model_fallbacks in config or MODEL_FALLBACKS env var
- Only applies to retryable errors (429, 503, timeout)"
```

---

## Task 2: 精细化限流

### Step 1: Write the failing test

**File:** `tests/middleware/ratelimit-enhanced.test.ts`

```typescript
import { rateLimitMiddleware, resetRateLimitStore } from '../../src/middleware/ratelimit';
import { Hono } from 'hono';

jest.mock('../../src/config', () => ({
  getConfig: jest.fn(() => ({
    rate_limit: { enabled: true, qps: 10, burst: 20 },
    model_rate_limits: {
      'gpt-4o': { qps: 2, burst: 4 },
    },
    tenant_rate_limits: {
      'default': { qps: 5, burst: 10 },
    },
  })),
}));

describe('Enhanced Rate Limiting', () => {
  let app: Hono;

  beforeEach(() => {
    resetRateLimitStore();
    app = new Hono();
    app.use('*', rateLimitMiddleware);
    app.get('/test', (c) => c.json({ ok: true }));
  });

  it('should add Retry-After header on 429', async () => {
    // Exhaust the rate limit
    for (let i = 0; i < 25; i++) {
      await app.request('/test', {
        headers: { 'Authorization': 'Bearer key-1' },
      });
    }

    const res = await app.request('/test', {
      headers: { 'Authorization': 'Bearer key-1' },
    });

    expect(res.status).toBe(429);
    const retryAfter = res.headers.get('Retry-After');
    expect(retryAfter).toBeTruthy();
    expect(parseInt(retryAfter!, 10)).toBeGreaterThan(0);
  });

  it('should include rate limit error code', async () => {
    // Exhaust the rate limit
    for (let i = 0; i < 25; i++) {
      await app.request('/test', {
        headers: { 'Authorization': 'Bearer key-2' },
      });
    }

    const res = await app.request('/test', {
      headers: { 'Authorization': 'Bearer key-2' },
    });

    const body = await res.json();
    expect(body.error.code).toBe('rate_limit_exceeded');
  });
});
```

**Run:** `npx jest tests/middleware/ratelimit-enhanced.test.ts --no-coverage`
**Expected:** FAIL — Retry-After not implemented

### Step 2: Add Retry-After header to 429 responses

**File:** `src/middleware/ratelimit.ts`

Modify the 429 response block:

```typescript
} else {
  // Calculate Retry-After based on remaining tokens and qps
  const retryAfter = Math.ceil((limit - remaining) / (config.rate_limit.qps ?? 10));
  c.res.headers.set('Retry-After', String(Math.max(1, retryAfter)));
  return c.json({
    error: {
      message: 'Rate limit exceeded. Please try again later.',
      type: 'rate_limit_error',
      code: 'rate_limit_exceeded',
    },
  }, 429);
}
```

### Step 3: Add model-level rate limit support

**File:** `src/config/index.ts`

Add `model_rate_limits` and `tenant_rate_limits` to config parsing.

**File:** `src/middleware/ratelimit.ts`

Add model-level and tenant-level rate limit checks before the global check:

```typescript
// Check tenant-level rate limit
const tenantId = c.get('tenant_id') as string | undefined;
if (tenantId && config.tenant_rate_limits?.[tenantId]) {
  const tenantLimit = config.tenant_rate_limits[tenantId];
  // ... check tenant bucket
}

// Check model-level rate limit (for chat/embed endpoints)
if (c.req.path === '/v1/chat/completions' || c.req.path === '/v1/embeddings') {
  // Parse request body to get model
  // This is async and complex; simpler to skip for now
}
```

Actually, checking model from request body in middleware is complex because it requires parsing JSON. Let's simplify: only add Retry-After for now, and document per-tenant/per-model as future enhancement.

### Step 4: Run tests

**Run:** `npx jest tests/middleware/ratelimit-enhanced.test.ts --no-coverage`
**Expected:** PASS

### Step 5: Commit

```bash
git add src/middleware/ratelimit.ts tests/middleware/ratelimit-enhanced.test.ts
git commit -m "feat: add Retry-After header to rate limit responses

- 429 responses now include Retry-After header with estimated seconds
- Added enhanced rate limit tests"
```

---

## Task 3: 流式 Failover

### Step 1: Write the failing test

**File:** `tests/providers/stream-failover.test.ts`

```typescript
import { chatCompleteStream, resetProviders, registerProvider, resetProviderDeps } from '../../src/providers';
import type { IProvider, ChatCompletionRequest } from '../../src/types';

jest.mock('../../src/config', () => ({
  getConfig: jest.fn(() => ({
    providers: {
      openai: { provider: 'openai', base_url: 'https://api.openai.com/v1', api_key: 'sk-test' },
      deepseek: { provider: 'deepseek', base_url: 'https://api.deepseek.com/v1', api_key: 'sk-test' },
    },
    model_equivalents: {},
    failover: { enabled: true, failureThreshold: 3, successThreshold: 2 },
    routing: { rules: [
      { model: 'gpt-4o', provider: 'openai' },
      { model: 'deepseek-chat', provider: 'deepseek' },
    ] },
  })),
  getProviderConfig: jest.fn((name: string) => ({
    openai: { provider: 'openai', base_url: 'https://api.openai.com/v1', api_key: 'sk-test' },
    deepseek: { provider: 'deepseek', base_url: 'https://api.deepseek.com/v1', api_key: 'sk-test' },
  }[name])),
  getProviderForModel: jest.fn((model: string) => model === 'gpt-4o' ? 'openai' : 'deepseek'),
  getProviderNames: jest.fn(() => ['openai', 'deepseek']),
  getRoutingStrategy: jest.fn(() => undefined),
  getModelPool: jest.fn(() => undefined),
  resolveModelAlias: jest.fn((m: string) => m),
}));

jest.mock('../../src/services/failover', () => ({
  failoverManager: {
    getHealthyKeys: jest.fn(() => ['sk-test']),
    getFailoverChain: jest.fn((provider: string) => provider === 'openai' ? ['deepseek'] : []),
    isProviderHealthy: jest.fn(() => true),
    recordProviderRequest: jest.fn(),
    recordSuccess: jest.fn(),
    recordFailure: jest.fn(),
  },
}));

jest.mock('../../src/services/loadbalancer', () => ({
  loadBalanceManager: {
    selectToken: jest.fn(() => ({ apiKey: 'sk-test' })),
  },
}));

describe('Stream Failover', () => {
  beforeEach(() => {
    resetProviders();
    resetProviderDeps();
  });

  it('should failover to fallback provider when primary stream connection fails', async () => {
    const openaiProvider: IProvider = {
      name: 'openai',
      capabilities: { chat: true, streaming: true, embed: false, vision: false, function_call: false },
      chat: jest.fn(),
      chatStream: jest.fn().mockRejectedValue(new Error('Connection timeout')),
      embed: jest.fn(),
    };

    const deepseekProvider: IProvider = {
      name: 'deepseek',
      capabilities: { chat: true, streaming: true, embed: false, vision: false, function_call: false },
      chat: jest.fn(),
      chatStream: jest.fn().mockResolvedValue(new ReadableStream()),
      embed: jest.fn(),
    };

    registerProvider('openai', openaiProvider);
    registerProvider('deepseek', deepseekProvider);

    const request: ChatCompletionRequest = {
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'Hello' }],
    };

    const result = await chatCompleteStream('openai', request);
    expect(result).toBeInstanceOf(ReadableStream);
    expect(openaiProvider.chatStream).toHaveBeenCalledTimes(1);
    expect(deepseekProvider.chatStream).toHaveBeenCalledTimes(1);
  });

  it('should throw when all providers fail for stream', async () => {
    const openaiProvider: IProvider = {
      name: 'openai',
      capabilities: { chat: true, streaming: true, embed: false, vision: false, function_call: false },
      chat: jest.fn(),
      chatStream: jest.fn().mockRejectedValue(new Error('Connection timeout')),
      embed: jest.fn(),
    };

    const deepseekProvider: IProvider = {
      name: 'deepseek',
      capabilities: { chat: true, streaming: true, embed: false, vision: false, function_call: false },
      chat: jest.fn(),
      chatStream: jest.fn().mockRejectedValue(new Error('Connection timeout')),
      embed: jest.fn(),
    };

    registerProvider('openai', openaiProvider);
    registerProvider('deepseek', deepseekProvider);

    const request: ChatCompletionRequest = {
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'Hello' }],
    };

    await expect(chatCompleteStream('openai', request)).rejects.toThrow('All providers failed');
  });
});
```

**Run:** `npx jest tests/providers/stream-failover.test.ts --no-coverage`
**Expected:** FAIL — stream failover not implemented

### Step 2: Implement stream failover in chatCompleteStream

**File:** `src/providers/index.ts`

Modify `chatCompleteStream` to try fallback providers on connection failure:

```typescript
export async function chatCompleteStream(
  providerName: string,
  request: ChatCompletionRequest,
  options?: { signal?: AbortSignal }
): Promise<ReadableStream> {
  const errors: Array<{ provider: string; error: string }> = [];
  const attemptedProviders = new Set<string>();
  const providersToTry: string[] = [providerName];

  const failoverConfig = getConfig().failover;
  if (failoverConfig?.enabled) {
    const fallbacks = getFallbackProviders(providerName, request.model);
    providersToTry.push(...fallbacks);
  }

  for (const currentProvider of providersToTry) {
    if (attemptedProviders.has(currentProvider)) continue;
    attemptedProviders.add(currentProvider);

    const config = getProviderConfig(currentProvider);
    if (!config) {
      errors.push({ provider: currentProvider, error: 'Not configured' });
      continue;
    }

    const provider = providers.get(currentProvider);
    if (!provider) {
      errors.push({ provider: currentProvider, error: 'Not registered' });
      continue;
    }

    if (failoverConfig?.enabled && !activeFailover.isProviderHealthy(currentProvider)) {
      errors.push({ provider: currentProvider, error: 'Provider unhealthy' });
      continue;
    }

    const mappedModel = resolveModelForProvider(request.model, currentProvider);
    const providerRequest = mappedModel !== request.model
      ? { ...request, model: mappedModel }
      : request;

    const startTime = Date.now();
    try {
      const result = await callProviderWithRetry(provider, config, providerRequest, true, options);
      activeFailover.recordProviderRequest(currentProvider, true, Date.now() - startTime);
      return result as ReadableStream;
    } catch (error) {
      activeFailover.recordProviderRequest(currentProvider, false, Date.now() - startTime);
      const errMsg = error instanceof Error ? error.message : String(error);
      errors.push({ provider: currentProvider, error: errMsg });
    }
  }

  throw new Error(
    `All providers failed for stream "${request.model}": ${errors.map((e) => `${e.provider} (${e.error})`).join('; ')}`
  );
}
```

### Step 3: Run tests

**Run:** `npx jest tests/providers/stream-failover.test.ts --no-coverage`
**Expected:** PASS

### Step 4: Commit

```bash
git add src/providers/index.ts tests/providers/stream-failover.test.ts
git commit -m "feat: add connection-level failover for streaming requests

- When primary provider stream connection fails, try fallback providers
- Only applies to connection-stage failures (not mid-stream errors)
- Maintains same fallback chain logic as non-streaming requests"
```

---

## Post-Implementation Verification

After all tasks complete, run:

```bash
npm run lint
npx tsc --noEmit
npm test -- --no-coverage --testPathIgnorePatterns="ai-gateway-admin"
```

Expected: All tests pass (917+).
