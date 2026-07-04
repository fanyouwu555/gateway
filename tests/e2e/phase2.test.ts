/**
 * Phase 2 End-to-End Tests
 * 验证 Phase 2 里程碑的完整功能�? *   - Admin API Key 认证（前端登录验�?/v1/ws�? *   - Dashboard 概览统计 API
 *   - 时间序列指标 API
 *   - Provider 维度统计 API
 *   - 状态码分布统计 API
 *   - Admin 路由权限隔离
 *   - WebSocket 统计管理
 */
import { createApp } from '../../src/app';
import type { Hono } from 'hono';
import { registerProvider, resetProviders, resetProviderDeps } from '../../src/providers';
import { resetCache } from '../../src/services/cache';
import { resetMetricsStore, recordMetric } from '../../src/services/metrics';
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

// Mock config with Phase 2 test settings
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
    rate_limit: { enabled: true, qps: 1000, burst: 500 },
    failover: {
      enabled: true,
      failureThreshold: 5,
      successThreshold: 3,
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

const userHeaders = {
  'Content-Type': 'application/json',
  Authorization: 'Bearer gateway-test-key-123',
};

describe('Phase 2 End-to-End Tests', () => {
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
  // 1. Admin Key Validation (frontend login verification)
  // ============================================================
  describe('Admin Key Validation', () => {
    it('should return 200 for valid admin key on /v1/ws', async () => {
      const res = await app.request('/v1/ws', { headers: adminHeaders });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { authenticated: boolean };
      expect(body.authenticated).toBe(true);
    });

    it('should return 200 for valid non-admin key (login verification)', async () => {
      // /v1/ws (public route) only checks auth, not admin status
      const res = await app.request('/v1/ws', {
        headers: { Authorization: 'Bearer gateway-test-key-123' },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { authenticated: boolean };
      expect(body.authenticated).toBe(true);
    });

    it('should return 401 for missing auth on /v1/ws', async () => {
      const res = await app.request('/v1/ws');
      expect(res.status).toBe(401);
    });

    it('should return 401 for invalid key on /v1/ws', async () => {
      const res = await app.request('/v1/ws', {
        headers: { Authorization: 'Bearer invalid-key' },
      });
      expect(res.status).toBe(401);
    });

    it('should accept admin key via Authorization header (WebSocket use case)', async () => {
      const res = await app.request('/v1/ws', {
        headers: { Authorization: 'Bearer admin-dashboard-key-456' },
      });
      expect(res.status).toBe(200);
    });

    it('should accept non-admin key via Authorization header (login verification)', async () => {
      const res = await app.request('/v1/ws', {
        headers: { Authorization: 'Bearer gateway-test-key-123' },
      });
      expect(res.status).toBe(200);
    });

    it('should reject invalid key via Authorization header', async () => {
      const res = await app.request('/v1/ws', {
        headers: { Authorization: 'Bearer invalid' },
      });
      expect(res.status).toBe(401);
    });

    it('should accept key via sec-websocket-protocol (browser WebSocket use case)', async () => {
      const res = await app.request('/v1/ws', {
        headers: { 'sec-websocket-protocol': 'gateway-token-admin-dashboard-key-456' },
      });
      expect(res.status).toBe(200);
    });
  });

  // ============================================================
  // 2. Dashboard Overview API
  // ============================================================
  describe('Dashboard Overview API', () => {
    it('should return dashboard overview with defaults', async () => {
      const res = await app.request('/v1/usage/overview', { headers: adminHeaders });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        total_requests: number;
        total_tokens: number;
        total_cost: number;
        avg_duration_ms: number;
        success_rate: number;
        error_rate: number;
        total_providers: number;
        total_models: number;
        total_tenants: number;
      };
      expect(body).toHaveProperty('total_requests');
      expect(body).toHaveProperty('total_tokens');
      expect(body).toHaveProperty('avg_duration_ms');
      expect(body).toHaveProperty('success_rate');
      expect(body.total_providers).toBeGreaterThanOrEqual(0);
    });

    it('should reflect recorded metrics in overview', async () => {
      // Record some metrics
      recordMetric('req-1', 'tenant-1', 'openai', 'gpt-4o', 100, 200, {
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15,
      });

      const now = Date.now();
      const start = now - 60000;
      const res = await app.request(`/v1/usage/overview?start=${start}&end=${now + 60000}`, {
        headers: adminHeaders,
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { total_requests: number; total_tokens: number; avg_duration_ms: number };
      expect(body.total_requests).toBe(1);
      expect(body.total_tokens).toBe(15);
    });

    it('should require admin auth for overview endpoint', async () => {
      const res = await app.request('/v1/usage/overview');
      expect(res.status).toBe(401);
    });
  });

  // ============================================================
  // 3. Time Series Metrics API
  // ============================================================
  describe('Time Series Metrics API', () => {
    it('should return time series data', async () => {
      const res = await app.request('/v1/usage/timeseries?granularity=hour', { headers: adminHeaders });
      expect(res.status).toBe(200);
      const body = (await res.json()) as Array<{ time_label: string; total_requests: number }>;
      expect(Array.isArray(body)).toBe(true);
    });

    it('should return filtered time series within time range', async () => {
      const now = Date.now();
      const start = now - 60 * 60 * 1000;
      const res = await app.request(
        `/v1/usage/timeseries?start=${start}&end=${now}&granularity=hour`,
        { headers: adminHeaders }
      );
      expect(res.status).toBe(200);
    });
  });

  // ============================================================
  // 4. Provider Stats API
  // ============================================================
  describe('Provider Stats API', () => {
    it('should return provider stats', async () => {
      // Record metrics for openai and deepseek
      recordMetric('req-p1', 'tenant-1', 'openai', 'gpt-4o', 100, 200, {
        prompt_tokens: 10, completion_tokens: 5, total_tokens: 15,
      });
      recordMetric('req-p2', 'tenant-1', 'deepseek', 'deepseek-chat', 50, 200, {
        prompt_tokens: 5, completion_tokens: 10, total_tokens: 15,
      });

      const res = await app.request('/v1/usage/providers', { headers: adminHeaders });
      expect(res.status).toBe(200);
      const body = (await res.json()) as Array<{ provider: string; total_requests: number }>;
      expect(Array.isArray(body)).toBe(true);
      expect(body.length).toBeGreaterThanOrEqual(2);

      const openai = body.find((p) => p.provider === 'openai');
      const deepseek = body.find((p) => p.provider === 'deepseek');
      expect(openai?.total_requests).toBe(1);
      expect(deepseek?.total_requests).toBe(1);
    });
  });

  // ============================================================
  // 5. Status Code Stats API
  // ============================================================
  describe('Status Code Stats API', () => {
    it('should return status code distribution', async () => {
      recordMetric('req-sc1', 'tenant-1', 'openai', 'gpt-4o', 100, 200, {
        prompt_tokens: 10, completion_tokens: 5, total_tokens: 15,
      });

      const res = await app.request('/v1/usage/status-codes', { headers: adminHeaders });
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, number>;
      expect(body['200']).toBeGreaterThanOrEqual(1);
    });
  });

  // ============================================================
  // 6. Admin Route Protection
  // ============================================================
  describe('Admin Route Protection', () => {
    it('should reject non-admin key from usage endpoints', async () => {
      const res = await app.request('/v1/usage/overview', { headers: userHeaders });
      expect(res.status).toBe(403);
    });

    it('should reject non-admin key from config endpoints', async () => {
      const res = await app.request('/v1/config', { headers: userHeaders });
      expect(res.status).toBe(403);
    });

    it('should reject non-admin key from tenant management', async () => {
      const res = await app.request('/v1/tenants', { headers: userHeaders });
      expect(res.status).toBe(403);
    });

    it('should reject non-admin key from cache management', async () => {
      const res = await app.request('/v1/cache', { headers: userHeaders });
      expect(res.status).toBe(403);
    });

    it('should reject non-admin key from session management', async () => {
      const res = await app.request('/v1/sessions', { headers: userHeaders });
      expect(res.status).toBe(403);
    });
  });

  // ============================================================
  // 7. WebSocket Clean Management
  // ============================================================
  describe('WebSocket Management', () => {
    it('should POST /v1/ws/clean to clean connections', async () => {
      const res = await app.request('/v1/ws/clean', {
        method: 'POST',
        headers: adminHeaders,
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { cleaned: number };
      expect(typeof body.cleaned).toBe('number');
    });

    it('should reject /v1/ws/clean without admin key', async () => {
      const res = await app.request('/v1/ws/clean', {
        method: 'POST',
        headers: { Authorization: 'Bearer gateway-test-key-123' },
      });
      expect(res.status).toBe(403);
    });
  });

  // ============================================================
  // 8. Cross-Endpoint Data Consistency
  // ============================================================
  describe('Cross-Endpoint Data Consistency', () => {
    it('should reflect same data across overview, provider, and status-code endpoints', async () => {
      // Record a single request and verify it appears in all three admin endpoints
      recordMetric('req-consistency', 'tenant-1', 'openai', 'gpt-4o', 150, 200, {
        prompt_tokens: 20, completion_tokens: 10, total_tokens: 30,
      });

      const now = Date.now();
      const start = now - 60000;

      // Overview
      const overviewRes = await app.request(
        `/v1/usage/overview?start=${start}&end=${now + 60000}`,
        { headers: adminHeaders }
      );
      const overview = (await overviewRes.json()) as { total_requests: number; total_tokens: number; avg_duration_ms: number };
      expect(overview.total_requests).toBe(1);
      expect(overview.total_tokens).toBe(30);
      expect(overview.avg_duration_ms).toBe(150);

      // Provider stats
      const providerRes = await app.request('/v1/usage/providers', { headers: adminHeaders });
      const providers = (await providerRes.json()) as Array<{ provider: string; total_requests: number }>;
      const openaiStats = providers.find((p) => p.provider === 'openai');
      expect(openaiStats?.total_requests).toBe(1);

      // Status codes
      const statusRes = await app.request('/v1/usage/status-codes', { headers: adminHeaders });
      const codes = (await statusRes.json()) as Record<string, number>;
      expect(codes['200']).toBeGreaterThanOrEqual(1);
    });
  });
});