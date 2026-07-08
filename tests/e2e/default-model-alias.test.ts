/**
 * DefaultModel 别名 End-to-End 测试
 * 验证完整链路：创建 Key（带 default_model）→ 用 DefaultModel 调用 Chat → 实际使用 key 的默认模型
 */
import { createApp } from '../../src/app';
import type { Hono } from 'hono';
import { registerProvider, resetProviders, resetProviderDeps } from '../../src/providers';
import { resetCache } from '../../src/services/cache';
import { resetMetricsStore } from '../../src/services/metrics';
import { resetRateLimitStore } from '../../src/middleware/ratelimit';
import { failoverManager } from '../../src/services/failover';
import { resetWebSocketConnections } from '../../src/middleware/websocket';
import { resetTenantStore } from '../../src/services/tenant';

jest.mock('../../src/utils', () => {
  const actual = jest.requireActual('../../src/utils');
  return {
    ...actual,
    verifyApiKey: (plaintext: string, hashed: string) => plaintext === hashed,
    ensureKeyHashed: (key: string) => key,
    hashApiKey: (key: string) => key,
  };
});

jest.mock('../../src/config', () => ({
  getConfig: () => ({
    port: 3000,
    host: '0.0.0.0',
    log_level: 'info',
    providers: {
      openai: { provider: 'openai', base_url: 'https://api.openai.com/v1', api_key: 'sk-openai' },
      deepseek: { provider: 'deepseek', base_url: 'https://api.deepseek.com/v1', api_key: 'sk-deepseek' },
    },
    routing: [
      {
        name: 'default',
        rules: [
          { model: 'gpt-4o', provider: 'openai' },
          { model: 'deepseek-chat', provider: 'deepseek' },
        ],
        fallback: 'deepseek',
      },
    ],
    auth: {
      enabled: true,
      api_keys: [
        { key: 'gateway-test-key-123', tenant_id: 'default', name: 'test', created_at: Date.now() },
        { key: 'admin-dashboard-key-456', tenant_id: 'admin', name: 'admin', created_at: Date.now(), is_admin: true },
      ],
    },
    rate_limit: { enabled: false, qps: 1000, burst: 1000 },
    failover: {
      enabled: false,
      failureThreshold: 1,
      successThreshold: 1,
      healthCheckInterval: 60000,
      healthCheckTimeout: 5000,
      healthCheckModel: 'gpt-4o-mini',
      chains: {},
      errorRateThreshold: 0.5,
      latencyThresholdMs: 30000,
    },
    loadBalance: { strategy: 'roundRobin', providers: {} },
    cache: { enabled: false, ttl: 3600000, max_size: 1000 },
    rate_limit_clean_interval: 60000,
    pricing: {},
    default_model: 'gpt-4o-mini',
  }),
  getProviderConfig: (name: string) => {
    const configs: Record<string, { provider: string; base_url: string; api_key: string }> = {
      openai: { provider: 'openai', base_url: 'https://api.openai.com/v1', api_key: 'sk-openai' },
      deepseek: { provider: 'deepseek', base_url: 'https://api.deepseek.com/v1', api_key: 'sk-deepseek' },
    };
    return configs[name];
  },
  getProviderForModel: (model: string) => {
    const map: Record<string, string> = { 'gpt-4o': 'openai', 'deepseek-chat': 'deepseek' };
    return map[model];
  },
  getRoutingStrategy: () => ({
    name: 'default',
    rules: [
      { model: 'gpt-4o', provider: 'openai' },
      { model: 'deepseek-chat', provider: 'deepseek' },
    ],
    fallback: 'deepseek',
  }),
  resolveModelAlias: jest.fn((alias: string) => alias),
  isModelPool: jest.fn(() => false),
  getModelPool: jest.fn(() => undefined),
  getProviderApiKeys: (config: { api_key?: string; api_keys?: string[] }) => {
    if (config.api_keys && config.api_keys.length > 0) return config.api_keys;
    if (config.api_key) return [config.api_key];
    return [];
  },
}));

const mockOpenAI = {
  name: 'openai',
  capabilities: { chat: true, embed: false, streaming: false, vision: false, function_call: false, reasoning: false },
  chat: jest.fn(),
  chatStream: jest.fn(),
  embed: jest.fn(),
};

const mockDeepSeek = {
  name: 'deepseek',
  capabilities: { chat: true, embed: false, streaming: false, vision: false, function_call: false, reasoning: false },
  chat: jest.fn(),
  chatStream: jest.fn(),
  embed: jest.fn(),
};

const adminHeaders = {
  Authorization: 'Bearer admin-dashboard-key-456',
};

describe('DefaultModel Alias End-to-End', () => {
  let app: Hono;

  beforeEach(() => {
    resetProviders();
    resetProviderDeps();
    resetCache();
    resetMetricsStore();
    resetRateLimitStore();
    failoverManager.reset();
    resetWebSocketConnections();
    resetTenantStore();

    registerProvider('openai', mockOpenAI);
    registerProvider('deepseek', mockDeepSeek);

    app = createApp();

    jest.clearAllMocks();
  });

  async function createTenantAndKey(defaultModel?: string, allowedModels?: string[]) {
    const tenantRes = await app.request('/v1/tenants', {
      method: 'POST',
      headers: { ...adminHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'DefaultModel Test Tenant',
        status: 'active',
        plan: 'pro',
        settings: {},
        limits: {
          daily_requests: 5000,
          daily_tokens: 500000,
          max_api_keys: 10,
          concurrent_requests: 20,
        },
      }),
    });
    expect(tenantRes.status).toBe(201);
    const tenantBody = (await tenantRes.json()) as { tenant: { tenant_id: string } };
    const tenantId = tenantBody.tenant.tenant_id;

    const keyRes = await app.request(`/v1/tenants/${tenantId}/keys`, {
      method: 'POST',
      headers: { ...adminHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Key With Default Model',
        ...(defaultModel !== undefined && { default_model: defaultModel }),
        ...(allowedModels !== undefined && { allowed_models: allowedModels }),
      }),
    });
    expect(keyRes.status).toBe(201);
    const keyBody = (await keyRes.json()) as { key: string; default_model?: string };
    if (defaultModel !== undefined) {
      expect(keyBody.default_model).toBe(defaultModel);
    }

    return { tenantId, key: keyBody.key };
  }

  // ============================================================
  // 1. DefaultModel 替换为 key 的 default_model
  // ============================================================
  it('should replace "DefaultModel" with the key default_model in chat request', async () => {
    const { key } = await createTenantAndKey('gpt-4o');

    mockOpenAI.chat.mockResolvedValue({
      id: 'default-model-alias-1',
      object: 'chat.completion',
      created: 1,
      model: 'gpt-4o',
      choices: [
        { index: 0, message: { role: 'assistant', content: 'Using default model' }, finish_reason: 'stop' },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    });

    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model: 'DefaultModel',
        messages: [{ role: 'user', content: 'Hello' }],
      }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { choices: Array<{ message: { content: string } }> };
    expect(body.choices[0].message.content).toBe('Using default model');

    // 关键断言：provider 收到的模型名已经被替换为 gpt-4o，而不是 DefaultModel
    expect(mockOpenAI.chat).toHaveBeenCalledTimes(1);
    const providerCall = mockOpenAI.chat.mock.calls[0][0] as { model: string };
    expect(providerCall.model).toBe('gpt-4o');
    expect(mockDeepSeek.chat).not.toHaveBeenCalled();
  });

  // ============================================================
  // 2. 不传 model 时同样使用 default_model
  // ============================================================
  it('should use key default_model when request omits model field', async () => {
    const { key } = await createTenantAndKey('deepseek-chat');

    mockDeepSeek.chat.mockResolvedValue({
      id: 'default-model-fallback-1',
      object: 'chat.completion',
      created: 1,
      model: 'deepseek-chat',
      choices: [
        { index: 0, message: { role: 'assistant', content: 'Fallback to default' }, finish_reason: 'stop' },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    });

    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'No model field' }],
      }),
    });

    expect(res.status).toBe(200);
    expect(mockDeepSeek.chat).toHaveBeenCalledTimes(1);
    const providerCall = mockDeepSeek.chat.mock.calls[0][0] as { model: string };
    expect(providerCall.model).toBe('deepseek-chat');
  });

  // ============================================================
  // 3. DefaultModel 绕过 allowed_models 白名单
  // ============================================================
  it('should allow DefaultModel even when default_model is outside allowed_models', async () => {
    // allowed_models 只有 gpt-4o，但 default_model 是 deepseek-chat
    const { key } = await createTenantAndKey('deepseek-chat', ['gpt-4o']);

    mockDeepSeek.chat.mockResolvedValue({
      id: 'default-model-whitelist-1',
      object: 'chat.completion',
      created: 1,
      model: 'deepseek-chat',
      choices: [
        { index: 0, message: { role: 'assistant', content: 'Whitelist bypassed' }, finish_reason: 'stop' },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    });

    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model: 'DefaultModel',
        messages: [{ role: 'user', content: 'Whitelist bypass test' }],
      }),
    });

    expect(res.status).toBe(200);
    expect(mockDeepSeek.chat).toHaveBeenCalledTimes(1);
    const providerCall = mockDeepSeek.chat.mock.calls[0][0] as { model: string };
    expect(providerCall.model).toBe('deepseek-chat');
  });

  // ============================================================
  // 4. 当 key 没有 default_model 时，DefaultModel 走 fallback
  // ============================================================
  it('should fallback to first routing model when key has no default_model', async () => {
    const { key } = await createTenantAndKey();

    mockOpenAI.chat.mockResolvedValue({
      id: 'default-model-no-default-1',
      object: 'chat.completion',
      created: 1,
      model: 'gpt-4o',
      choices: [
        { index: 0, message: { role: 'assistant', content: 'Fallback routing' }, finish_reason: 'stop' },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    });

    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model: 'DefaultModel',
        messages: [{ role: 'user', content: 'Fallback test' }],
      }),
    });

    expect(res.status).toBe(200);
    expect(mockOpenAI.chat).toHaveBeenCalledTimes(1);
    const providerCall = mockOpenAI.chat.mock.calls[0][0] as { model: string };
    expect(providerCall.model).toBe('gpt-4o');
  });

  // ============================================================
  // 5. 更新 default_model 后 DefaultModel 指向新模型
  // ============================================================
  it('should reflect updated default_model after key policy update', async () => {
    const { tenantId, key } = await createTenantAndKey('gpt-4o');

    // 更新 key 的 default_model 为 deepseek-chat
    const updateRes = await app.request(`/v1/tenants/${tenantId}/keys/${key}`, {
      method: 'PUT',
      headers: { ...adminHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ default_model: 'deepseek-chat' }),
    });
    expect(updateRes.status).toBe(200);

    mockDeepSeek.chat.mockResolvedValue({
      id: 'default-model-updated-1',
      object: 'chat.completion',
      created: 1,
      model: 'deepseek-chat',
      choices: [
        { index: 0, message: { role: 'assistant', content: 'Updated default' }, finish_reason: 'stop' },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    });

    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model: 'DefaultModel',
        messages: [{ role: 'user', content: 'Update test' }],
      }),
    });

    expect(res.status).toBe(200);
    expect(mockDeepSeek.chat).toHaveBeenCalledTimes(1);
    const providerCall = mockDeepSeek.chat.mock.calls[0][0] as { model: string };
    expect(providerCall.model).toBe('deepseek-chat');
    expect(mockOpenAI.chat).not.toHaveBeenCalled();
  });
});
