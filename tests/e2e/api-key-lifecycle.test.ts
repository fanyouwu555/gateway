/**
 * API Key 生命周期 End-to-End Tests
 * 完整验证�? *   创建租户 �?创建 API Key �?�?Key 调用网关 �?吊销 Key �?Key 失效
 *   租户隔离、Key 上限、无�?Key 拒绝
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

// Mock utils to bypass scrypt hashing in tests (plaintext key == stored key)
jest.mock('../../src/utils', () => {
  const actual = jest.requireActual('../../src/utils');
  return {
    ...actual,
    verifyApiKey: (plaintext: string, hashed: string) => plaintext === hashed,
    ensureKeyHashed: (key: string) => key,
    hashApiKey: (key: string) => key,
  };
});

// Mock config with test settings
jest.mock('../../src/config', () => ({
  getConfig: () => ({
    port: 3000,
    host: '0.0.0.0',
    log_level: 'info',
    providers: {
      openai: { provider: 'openai', base_url: 'https://api.openai.com/v1', api_key: 'sk-openai' },
    },
    routing: [
      {
        name: 'default',
        rules: [{ model: 'gpt-4o', provider: 'openai' }],
        fallback: 'openai',
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
    cache: { enabled: true, ttl: 3600000, max_size: 1000 },
    rate_limit_clean_interval: 60000,
    pricing: {},
    default_model: 'gpt-4o-mini',
  }),
  getProviderConfig: (name: string) => {
    const configs: Record<string, { provider: string; base_url: string; api_key: string }> = {
      openai: { provider: 'openai', base_url: 'https://api.openai.com/v1', api_key: 'sk-openai' },
    };
    return configs[name];
  },
  getProviderForModel: (model: string) => {
    const map: Record<string, string> = { 'gpt-4o': 'openai' };
    return map[model];
  },
  getRoutingStrategy: () => ({
    name: 'default',
    rules: [{ model: 'gpt-4o', provider: 'openai' }],
    fallback: 'openai',
  }),
  resolveModelAlias: jest.fn((alias: string) => alias),
  getProviderApiKeys: (config: { api_key?: string; api_keys?: string[] }) => {
    if (config.api_keys && config.api_keys.length > 0) return config.api_keys;
    if (config.api_key) return [config.api_key];
    return [];
  },
  isModelPool: jest.fn(() => false),
  getModelPool: jest.fn(() => undefined),
}));

const mockOpenAI = {
  name: 'openai',
  capabilities: { chat: true, embed: false, streaming: false, vision: false, function_call: false },
  chat: jest.fn(),
  chatStream: jest.fn(),
  embed: jest.fn(),
};

const adminHeaders = {
  Authorization: 'Bearer admin-dashboard-key-456',
};

describe('API Key Lifecycle End-to-End', () => {
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

    app = createApp();

    jest.clearAllMocks();
  });

  // ============================================================
  // 1. 创建租户 �?创建 API Key �?�?Key 调用 Chat
  // ============================================================
  describe('Full Lifecycle: Create Tenant �?Create Key �?Use Key', () => {
    it('should create a tenant, create an API key, and use it for chat', async () => {
      // Step 1: Create a tenant
      const tenantRes = await app.request('/v1/tenants', {
        method: 'POST',
        headers: { ...adminHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'My Product',
          status: 'active',
          plan: 'pro',
          settings: {
            allowed_providers: ['openai'],
          },
          limits: {
            daily_requests: 5000,
            daily_tokens: 500000,
            monthly_cost: 100,
            max_api_keys: 10,
            concurrent_requests: 20,
          },
        }),
      });

      expect(tenantRes.status).toBe(201);
      const tenantBody = (await tenantRes.json()) as { tenant_id: string; name: string };
      expect(tenantBody.tenant_id).toMatch(/^tenant_/);
      expect(tenantBody.name).toBe('My Product');
      const tenantId = tenantBody.tenant_id;

      // Step 2: Create an API key for this tenant
      const keyRes = await app.request(`/v1/tenants/${tenantId}/keys`, {
        method: 'POST',
        headers: { ...adminHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Production Key' }),
      });

      expect(keyRes.status).toBe(201);
      const keyBody = (await keyRes.json()) as { key: string; name: string; tenant_id: string };
      expect(keyBody.key).toMatch(/^sk-/);
      expect(keyBody.name).toBe('Production Key');
      expect(keyBody.tenant_id).toBe(tenantId);
      const tenantKey = keyBody.key;

      // Step 3: Use the tenant's API key to call chat completion
      mockOpenAI.chat.mockResolvedValue({
        id: 'test-1',
        object: 'chat.completion',
        created: 1,
        model: 'gpt-4o',
        choices: [
          { index: 0, message: { role: 'assistant', content: 'Hello from product!' }, finish_reason: 'stop' },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      });

      const chatRes = await app.request('/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tenantKey}`,
        },
        body: JSON.stringify({
          model: 'gpt-4o',
          messages: [{ role: 'user', content: 'Hello' }],
        }),
      });

      expect(chatRes.status).toBe(200);
      const chatBody = (await chatRes.json()) as { choices: Array<{ message: { content: string } }> };
      expect(chatBody.choices[0].message.content).toBe('Hello from product!');
      expect(mockOpenAI.chat).toHaveBeenCalledTimes(1);
    });
  });

  // ============================================================
  // 2. 租户隔离：普�?API Key 不能访问管理路由
  // ============================================================
  describe('Tenant Isolation', () => {
    it('should reject non-admin keys on admin routes with 403', async () => {
      // Create a tenant and key
      const tenantRes = await app.request('/v1/tenants', {
        method: 'POST',
        headers: { ...adminHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Isolated Product',
          status: 'active',
          plan: 'free',
          settings: {},
          limits: {
            daily_requests: 1000,
            daily_tokens: 100000,
            monthly_cost: 50,
            max_api_keys: 5,
            concurrent_requests: 10,
          },
        }),
      });
      const tenantBody = (await tenantRes.json()) as { tenant_id: string };
      const tenantId = tenantBody.tenant_id;

      const keyRes = await app.request(`/v1/tenants/${tenantId}/keys`, {
        method: 'POST',
        headers: { ...adminHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Tenant Key' }),
      });
      const keyBody = (await keyRes.json()) as { key: string };
      const tenantKey = keyBody.key;

      // Try to list tenants (admin route) with the tenant key
      const listRes = await app.request('/v1/tenants', {
        headers: { Authorization: `Bearer ${tenantKey}` },
      });
      expect(listRes.status).toBe(403);

      // Try to access admin config with the tenant key
      const configRes = await app.request('/v1/config', {
        headers: { Authorization: `Bearer ${tenantKey}` },
      });
      expect(configRes.status).toBe(403);
    });
  });

  // ============================================================
  // 3. API Key 吊销：删除后失效
  // ============================================================
  describe('API Key Revocation', () => {
    it('should reject a deleted API key with 401', async () => {
      // Create a key
      const keyRes = await app.request('/v1/tenants/default/keys', {
        method: 'POST',
        headers: { ...adminHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Temp Key' }),
      });
      expect(keyRes.status).toBe(201);
      const keyBody = (await keyRes.json()) as { key: string };
      const tempKey = keyBody.key;

      // Verify it works first
      mockOpenAI.chat.mockResolvedValue({
        id: 'test-revoke',
        object: 'chat.completion',
        created: 1,
        model: 'gpt-4o',
        choices: [
          { index: 0, message: { role: 'assistant', content: 'Before revoke' }, finish_reason: 'stop' },
        ],
        usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
      });

      const before = await app.request('/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tempKey}`,
        },
        body: JSON.stringify({
          model: 'gpt-4o',
          messages: [{ role: 'user', content: 'Test' }],
        }),
      });
      expect(before.status).toBe(200);

      // Delete the key
      const delRes = await app.request(`/v1/keys/${tempKey}`, {
        method: 'DELETE',
        headers: adminHeaders,
      });
      expect(delRes.status).toBe(200);
      const delBody = (await delRes.json()) as { deleted: boolean };
      expect(delBody.deleted).toBe(true);

      // Try to use the deleted key
      const after = await app.request('/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tempKey}`,
        },
        body: JSON.stringify({
          model: 'gpt-4o',
          messages: [{ role: 'user', content: 'Test after revoke' }],
        }),
      });
      expect(after.status).toBe(401);

      const errBody = (await after.json()) as { error: { code: string } };
      expect(errBody.error.code).toBe('invalid_api_key');
    });
  });

  // ============================================================
  // 4. �?Key / 无效 Key 请求被拒�?  // ============================================================
  describe('Request Validation', () => {
    it('should return 401 when no API key is provided', async () => {
      const res = await app.request('/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'gpt-4o',
          messages: [{ role: 'user', content: 'Hello' }],
        }),
      });

      expect(res.status).toBe(401);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('missing_api_key');
    });

    it('should return 401 when an invalid API key is provided', async () => {
      const res = await app.request('/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer sk-invalid-key-xxx',
        },
        body: JSON.stringify({
          model: 'gpt-4o',
          messages: [{ role: 'user', content: 'Hello' }],
        }),
      });

      expect(res.status).toBe(401);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('invalid_api_key');
    });
  });

  // ============================================================
  // 5. 默认配置 Key 仍然可用
  // ============================================================
  describe('Config-specified API Keys', () => {
    it('should accept API keys from gateway config', async () => {
      mockOpenAI.chat.mockResolvedValue({
        id: 'config-key-test',
        object: 'chat.completion',
        created: 1,
        model: 'gpt-4o',
        choices: [
          { index: 0, message: { role: 'assistant', content: 'Config key works' }, finish_reason: 'stop' },
        ],
        usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
      });

      // Use the config-specified test key
      const res = await app.request('/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer gateway-test-key-123',
        },
        body: JSON.stringify({
          model: 'gpt-4o',
          messages: [{ role: 'user', content: 'Hello' }],
        }),
      });

      expect(res.status).toBe(200);
      expect(mockOpenAI.chat).toHaveBeenCalledTimes(1);
    });
  });

  // ============================================================
  // 6. 管理 API Key 可以访问管理路由
  // ============================================================
  describe('Admin Key Access', () => {
    it('should allow admin key to manage tenants', async () => {
      const res = await app.request('/v1/tenants', {
        headers: adminHeaders,
      });
      expect(res.status).toBe(200);
    });
  });
});