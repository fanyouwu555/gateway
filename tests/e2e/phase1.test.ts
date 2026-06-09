/**
 * Phase 1 End-to-End Tests
 * 验证 Phase 1 里程碑的完整请求链路�? *   - �?Provider 故障转移�? *   - 缓存命中
 *   - 分布式限�? *   - Admin API 指标查询
 *   - Health 端点 Provider 健康状�? */
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
  };
});

// Mock config with Phase 1 test settings
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
    rate_limit: { enabled: true, qps: 10, burst: 2 },
    failover: {
      enabled: true,
      failureThreshold: 1,
      successThreshold: 1,
      healthCheckInterval: 60000,
      healthCheckTimeout: 5000,
      healthCheckModel: 'gpt-4o-mini',
      chains: { openai: ['deepseek'] },
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

const userHeaders = {
  'Content-Type': 'application/json',
  Authorization: 'Bearer gateway-test-key-123',
};

const adminHeaders = {
  Authorization: 'Bearer admin-dashboard-key-456',
};

describe('Phase 1 End-to-End Tests', () => {
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

  // ============================================================
  // 1. Basic Chat Completion Pipeline
  // ============================================================
  describe('Basic Chat Completion Pipeline', () => {
    it('should return 200 for valid chat request', async () => {
      mockOpenAI.chat.mockResolvedValue({
        id: 'e2e-1',
        object: 'chat.completion',
        created: 1,
        model: 'gpt-4o',
        choices: [
          { index: 0, message: { role: 'assistant', content: 'Hello!' }, finish_reason: 'stop' },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      });

      const res = await app.request('/v1/chat/completions', {
        method: 'POST',
        headers: userHeaders,
        body: JSON.stringify({
          model: 'gpt-4o',
          messages: [{ role: 'user', content: 'Hello' }],
        }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { choices: Array<{ message: { content: string } }> };
      expect(body.choices[0].message.content).toBe('Hello!');
      expect(mockOpenAI.chat).toHaveBeenCalledTimes(1);
    });

    it('should accept request without model (uses default model fallback)', async () => {
      const res = await app.request('/v1/chat/completions', {
        method: 'POST',
        headers: userHeaders,
        body: JSON.stringify({ messages: [{ role: 'user', content: 'Hi' }] }),
      });
      // model is now optional �?falls back to key default_model or first routing model
      expect(res.status).toBe(200);
    });

    it('should return 401 without API key', async () => {
      const res = await app.request('/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: 'Hi' }] }),
      });
      expect(res.status).toBe(401);
    });
  });

  // ============================================================
  // 2. Cache Hit Pipeline
  // ============================================================
  describe('Cache Hit Pipeline', () => {
    it('should hit cache on repeated identical requests', async () => {
      mockOpenAI.chat.mockResolvedValue({
        id: 'e2e-cache',
        object: 'chat.completion',
        created: 1,
        model: 'gpt-4o',
        choices: [
          { index: 0, message: { role: 'assistant', content: 'Cached!' }, finish_reason: 'stop' },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      });

      const body1 = JSON.stringify({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'Cache test' }],
      });

      // First request hits the provider
      const res1 = await app.request('/v1/chat/completions', {
        method: 'POST',
        headers: userHeaders,
        body: body1,
      });
      expect(res1.status).toBe(200);
      expect(mockOpenAI.chat).toHaveBeenCalledTimes(1);

      // Second identical request should hit cache
      const res2 = await app.request('/v1/chat/completions', {
        method: 'POST',
        headers: userHeaders,
        body: body1,
      });
      expect(res2.status).toBe(200);
      const json2 = (await res2.json()) as { choices: Array<{ message: { content: string } }> };
      expect(json2.choices[0].message.content).toBe('Cached!');
      // Provider should NOT be called a second time
      expect(mockOpenAI.chat).toHaveBeenCalledTimes(1);
    });
  });

  // ============================================================
  // 3. Cross-Provider Failover Chain
  // ============================================================
  describe('Cross-Provider Failover Chain', () => {
    it('should failover to fallback provider when primary fails', async () => {
      mockOpenAI.chat.mockRejectedValue(new Error('OpenAI is down'));
      mockDeepSeek.chat.mockResolvedValue({
        id: 'e2e-failover',
        object: 'chat.completion',
        created: 1,
        model: 'deepseek-chat',
        choices: [
          { index: 0, message: { role: 'assistant', content: 'From DeepSeek' }, finish_reason: 'stop' },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      });

      const res = await app.request('/v1/chat/completions', {
        method: 'POST',
        headers: userHeaders,
        body: JSON.stringify({
          model: 'gpt-4o',
          messages: [{ role: 'user', content: 'Failover test' }],
        }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { choices: Array<{ message: { content: string } }> };
      expect(body.choices[0].message.content).toBe('From DeepSeek');
      expect(mockOpenAI.chat).toHaveBeenCalledTimes(1);
      expect(mockDeepSeek.chat).toHaveBeenCalledTimes(1);
    });

    it('should skip unhealthy primary on subsequent requests', async () => {
      mockOpenAI.chat.mockRejectedValue(new Error('OpenAI is down'));
      mockDeepSeek.chat.mockResolvedValue({
        id: 'e2e-skip',
        object: 'chat.completion',
        created: 1,
        model: 'deepseek-chat',
        choices: [
          { index: 0, message: { role: 'assistant', content: 'DeepSeek again' }, finish_reason: 'stop' },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      });

      const body = JSON.stringify({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'Skip test' }],
      });

      // First request: tries OpenAI (fails), falls back to DeepSeek
      const res1 = await app.request('/v1/chat/completions', {
        method: 'POST',
        headers: userHeaders,
        body,
      });
      expect(res1.status).toBe(200);
      expect(mockOpenAI.chat).toHaveBeenCalledTimes(1);
      expect(mockDeepSeek.chat).toHaveBeenCalledTimes(1);

      jest.clearAllMocks();
      resetCache(); // clear cache so the second request hits providers again
      mockOpenAI.chat.mockRejectedValue(new Error('OpenAI is down'));
      mockDeepSeek.chat.mockResolvedValue({
        id: 'e2e-skip2',
        object: 'chat.completion',
        created: 1,
        model: 'deepseek-chat',
        choices: [
          { index: 0, message: { role: 'assistant', content: 'DeepSeek again' }, finish_reason: 'stop' },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      });

      // Second request: OpenAI is now marked unhealthy, skips directly to DeepSeek
      const res2 = await app.request('/v1/chat/completions', {
        method: 'POST',
        headers: userHeaders,
        body,
      });
      expect(res2.status).toBe(200);
      expect(mockOpenAI.chat).not.toHaveBeenCalled();
      expect(mockDeepSeek.chat).toHaveBeenCalledTimes(1);
    });

    it('should return 500 when all providers in chain fail', async () => {
      mockOpenAI.chat.mockRejectedValue(new Error('OpenAI down'));
      mockDeepSeek.chat.mockRejectedValue(new Error('DeepSeek down'));

      const res = await app.request('/v1/chat/completions', {
        method: 'POST',
        headers: userHeaders,
        body: JSON.stringify({
          model: 'gpt-4o',
          messages: [{ role: 'user', content: 'All fail test' }],
        }),
      });

      expect(res.status).toBe(500);
      const body = (await res.json()) as { error: { message: string } };
      expect(body.error.message).toMatch(/All providers failed/);
    });
  });

  // ============================================================
  // 4. Rate Limiting Pipeline
  // ============================================================
  describe('Rate Limiting Pipeline', () => {
    it('should allow requests within burst limit', async () => {
      mockOpenAI.chat.mockResolvedValue({
        id: 'e2e-rl',
        object: 'chat.completion',
        created: 1,
        model: 'gpt-4o',
        choices: [
          { index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      });

      // burst = 2, send 2 requests
      const res1 = await app.request('/v1/chat/completions', {
        method: 'POST',
        headers: userHeaders,
        body: JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: 'RL 1' }] }),
      });
      const res2 = await app.request('/v1/chat/completions', {
        method: 'POST',
        headers: userHeaders,
        body: JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: 'RL 2' }] }),
      });

      expect(res1.status).toBe(200);
      expect(res2.status).toBe(200);
    });

    it('should return 429 when exceeding burst limit', async () => {
      mockOpenAI.chat.mockResolvedValue({
        id: 'e2e-rl-block',
        object: 'chat.completion',
        created: 1,
        model: 'gpt-4o',
        choices: [
          { index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      });

      // burst = 2, send 3 rapid requests
      const promises = [];
      for (let i = 0; i < 3; i++) {
        promises.push(
          app.request('/v1/chat/completions', {
            method: 'POST',
            headers: userHeaders,
            body: JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: `RL ${i}` }] }),
          })
        );
      }

      const responses = await Promise.all(promises);
      const okCount = responses.filter((r) => r.status === 200).length;
      const limitedCount = responses.filter((r) => r.status === 429).length;

      expect(okCount).toBe(2);
      expect(limitedCount).toBe(1);

      const limited = responses.find((r) => r.status === 429);
      expect(limited).toBeDefined();
    });
  });

  // ============================================================
  // 5. Admin API Metrics Query
  // ============================================================
  describe('Admin API Metrics Query', () => {
    it('should query usage by time range', async () => {
      mockOpenAI.chat.mockResolvedValue({
        id: 'e2e-metrics',
        object: 'chat.completion',
        created: 1,
        model: 'gpt-4o',
        choices: [
          { index: 0, message: { role: 'assistant', content: 'Metrics' }, finish_reason: 'stop' },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      });

      // Send a request to generate metrics
      await app.request('/v1/chat/completions', {
        method: 'POST',
        headers: userHeaders,
        body: JSON.stringify({
          model: 'gpt-4o',
          messages: [{ role: 'user', content: 'Metrics test' }],
        }),
      });

      // Query metrics via admin API
      const now = Date.now();
      const start = now - 60000;
      const end = now + 60000;
      const res = await app.request(`/v1/usage/range?start=${start}&end=${end}`, {
        headers: adminHeaders,
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { total_requests: number };
      expect(body.total_requests).toBeGreaterThanOrEqual(1);
    });

    it('should reject metrics query without admin key', async () => {
      const res = await app.request('/v1/usage/range?start=0&end=999999999', {
        headers: userHeaders, // non-admin key
      });
      expect(res.status).toBe(403);
    });
  });

  // ============================================================
  // 6. Health Endpoint with Provider Health
  // ============================================================
  describe('Health Endpoint', () => {
    it('should return provider health status', async () => {
      const res = await app.request('/health');
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        services: {
          providers: Array<{
            name: string;
            status: string;
            health?: { isHealthy: boolean };
          }>;
        };
      };

      expect(body.services.providers).toBeDefined();
      expect(body.services.providers.length).toBeGreaterThanOrEqual(2);

      const openai = body.services.providers.find((p) => p.name === 'openai');
      const deepseek = body.services.providers.find((p) => p.name === 'deepseek');
      expect(openai).toBeDefined();
      expect(deepseek).toBeDefined();
      expect(openai?.status).toBe('active');
    });

    it('should show degraded status for unhealthy provider', async () => {
      // Make openai unhealthy
      mockOpenAI.chat.mockRejectedValue(new Error('OpenAI down'));
      mockDeepSeek.chat.mockResolvedValue({
        id: 'e2e-health',
        object: 'chat.completion',
        created: 1,
        model: 'deepseek-chat',
        choices: [
          { index: 0, message: { role: 'assistant', content: 'Health' }, finish_reason: 'stop' },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      });

      await app.request('/v1/chat/completions', {
        method: 'POST',
        headers: userHeaders,
        body: JSON.stringify({
          model: 'gpt-4o',
          messages: [{ role: 'user', content: 'Health test' }],
        }),
      });

      const res = await app.request('/health');
      const body = (await res.json()) as {
        services: {
          providers: Array<{ name: string; status: string }>;
        };
      };

      const openai = body.services.providers.find((p) => p.name === 'openai');
      expect(openai?.status).toBe('degraded');
    });
  });
});
