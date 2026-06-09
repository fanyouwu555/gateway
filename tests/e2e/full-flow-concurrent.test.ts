/**
 * 全流程并�?End-to-End Test
 * 模拟 10 个独立用户：
 *   1. Admin 创建租户
 *   2. Admin 为租户创�?API Key
 *   3. 用户使用自己�?Key 调用 /v1/chat/completions
 *   4. 验证租户隔离（用�?key 不能访问 admin 路由�? *
 * 支持并发模式（sequential=false）和串行模式（sequential=true）�? */
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
    cache: { enabled: false, ttl: 3600000, max_size: 1000 },
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

const USER_COUNT = 10;

describe('Full-Flow Concurrent: 10 Users', () => {
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
  // Helper: create tenant + key for one user
  // ============================================================
  async function provisionUser(userIndex: number): Promise<{ tenantId: string; apiKey: string }> {
    const tenantRes = await app.request('/v1/tenants', {
      method: 'POST',
      headers: { ...adminHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: `User ${userIndex}`,
        status: 'active',
        plan: 'pro',
        settings: { allowed_providers: ['openai'] },
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
    const tenantBody = (await tenantRes.json()) as { tenant_id: string };
    const tenantId = tenantBody.tenant_id;

    const keyRes = await app.request(`/v1/tenants/${tenantId}/keys`, {
      method: 'POST',
      headers: { ...adminHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: `Key for user ${userIndex}` }),
    });

    expect(keyRes.status).toBe(201);
    const keyBody = (await keyRes.json()) as { key: string };
    const apiKey = keyBody.key;

    return { tenantId, apiKey };
  }

  // ============================================================
  // Helper: chat with user key
  // ============================================================
  async function chatWithKey(apiKey: string, userIndex: number): Promise<{ status: number; content: string }> {
    // Use mockImplementation so concurrent calls don't overwrite each other's return values
    mockOpenAI.chat.mockImplementation((request: { messages: Array<{ content: string }> }) => {
      const content = request.messages[0]?.content ?? '';
      const idx = content.replace('Hello from user ', '');
      return Promise.resolve({
        id: `chat-${idx}`,
        object: 'chat.completion',
        created: 1,
        model: 'gpt-4o',
        choices: [
          { index: 0, message: { role: 'assistant', content: `Response for user ${idx}` }, finish_reason: 'stop' },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      });
    });

    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: `Hello from user ${userIndex}` }],
      }),
    });

    if (res.status === 200) {
      const body = (await res.json()) as { choices: Array<{ message: { content: string } }> };
      return { status: res.status, content: body.choices[0].message.content };
    }
    return { status: res.status, content: '' };
  }

  // ============================================================
  // 1. Sequential full flow for 10 users
  // ============================================================
  describe('Sequential 10-User Flow', () => {
    it('should provision and chat for 10 users one by one', async () => {
      const results: Array<{ tenantId: string; apiKey: string; status: number; content: string }> = [];

      for (let i = 0; i < USER_COUNT; i++) {
        const { tenantId, apiKey } = await provisionUser(i);
        const { status, content } = await chatWithKey(apiKey, i);
        results.push({ tenantId, apiKey, status, content });
      }

      expect(results).toHaveLength(USER_COUNT);

      for (let i = 0; i < USER_COUNT; i++) {
        expect(results[i].status).toBe(200);
        expect(results[i].content).toBe(`Response for user ${i}`);
        expect(results[i].apiKey).toMatch(/^sk-/);
        expect(results[i].tenantId).toMatch(/^tenant_/);
      }

      // provider called once per user
      expect(mockOpenAI.chat).toHaveBeenCalledTimes(USER_COUNT);
    });
  });

  // ============================================================
  // 2. Concurrent full flow for 10 users
  // ============================================================
  describe('Concurrent 10-User Flow', () => {
    it('should provision and chat for 10 users concurrently', async () => {
      // Step 1: provision all 10 users concurrently
      const provisionPromises = Array.from({ length: USER_COUNT }, (_, i) => provisionUser(i));
      const provisioned = await Promise.all(provisionPromises);

      expect(provisioned).toHaveLength(USER_COUNT);
      provisioned.forEach((p) => {
        expect(p.tenantId).toMatch(/^tenant_/);
        expect(p.apiKey).toMatch(/^sk-/);
      });

      // Step 2: all 10 users chat concurrently
      const chatPromises = provisioned.map((p, i) => chatWithKey(p.apiKey, i));
      const chatResults = await Promise.all(chatPromises);

      expect(chatResults).toHaveLength(USER_COUNT);

      for (let i = 0; i < USER_COUNT; i++) {
        expect(chatResults[i].status).toBe(200);
        expect(chatResults[i].content).toBe(`Response for user ${i}`);
      }

      expect(mockOpenAI.chat).toHaveBeenCalledTimes(USER_COUNT);
    });
  });

  // ============================================================
  // 3. Tenant isolation: user key cannot access admin routes
  // ============================================================
  describe('Tenant Isolation for 10 Users', () => {
    it('should reject all 10 user keys from admin routes', async () => {
      const provisionPromises = Array.from({ length: USER_COUNT }, (_, i) => provisionUser(i));
      const provisioned = await Promise.all(provisionPromises);

      const adminRoutes = ['/v1/tenants', '/v1/config', '/v1/usage/overview', '/v1/cache'];

      for (const route of adminRoutes) {
        const checks = provisioned.map(async (p) => {
          const res = await app.request(route, {
            headers: { Authorization: `Bearer ${p.apiKey}` },
          });
          return res.status;
        });
        const statuses = await Promise.all(checks);
        expect(statuses.every((s) => s === 403)).toBe(true);
      }
    });
  });

  // ============================================================
  // 4. Revoke one key mid-flow, verify it fails while others work
  // ============================================================
  describe('Key Revocation Mid-Flow', () => {
    it('should revoke user 5 key and reject it while other 9 succeed', async () => {
      const provisionPromises = Array.from({ length: USER_COUNT }, (_, i) => provisionUser(i));
      const provisioned = await Promise.all(provisionPromises);

      // Revoke user 5's key
      const revokedKey = provisioned[5].apiKey;
      const delRes = await app.request(`/v1/keys/${revokedKey}`, {
        method: 'DELETE',
        headers: adminHeaders,
      });
      expect(delRes.status).toBe(200);

      // All 10 users attempt to chat
      const chatPromises = provisioned.map((p, i) => chatWithKey(p.apiKey, i));
      const chatResults = await Promise.all(chatPromises);

      // User 5 should be 401, others 200
      for (let i = 0; i < USER_COUNT; i++) {
        if (i === 5) {
          expect(chatResults[i].status).toBe(401);
        } else {
          expect(chatResults[i].status).toBe(200);
        }
      }
    });
  });
});
