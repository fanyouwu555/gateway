/**
 * Conversation Logging Integration Tests
 */
import { createApp } from '../../src/app';
import { getConversationLogService, resetConversationLogService } from '../../src/services/conversation-log';

jest.mock('../../src/config', () => ({
  getConfig: jest.fn(() => ({
    port: 3000,
    host: '0.0.0.0',
    log_level: 'info',
    providers: {
      openai: { provider: 'openai', base_url: 'https://api.openai.com/v1', api_key: 'sk-test' },
    },
    routing: [{ name: 'default', rules: [{ model: 'gpt-4o', provider: 'openai' }] }],
    auth: {
      enabled: true,
      api_keys: [
        {
          key: 'test-api-key-123',
          tenant_id: 'default',
          name: 'Test Key',
          created_at: Date.now(),
        },
        {
          key: 'admin-dashboard-key-456',
          tenant_id: 'default',
          name: 'Admin Key',
          created_at: Date.now(),
          is_admin: true,
        },
      ],
    },
    rate_limit: { enabled: false, qps: 1000, burst: 1000 },
    cache: { enabled: false, ttl: 60000, max_size: 1000 },
    conversation_logging: { enabled: true, max_memory_sessions: 100, redis_ttl_days: 7, max_turns_per_session: 500 },
  })),
  getProviderConfig: jest.fn(() => ({ provider: 'openai', base_url: 'https://api.openai.com/v1', api_key: 'sk-test' })),
  getProviderForModel: jest.fn(() => 'openai'),
  getRoutingStrategy: jest.fn(() => ({ name: 'default', rules: [{ model: 'gpt-4o', provider: 'openai' }] })),
  resolveModelAlias: jest.fn((alias: string) => alias),
}));

jest.mock('../../src/providers', () => ({
  chatComplete: jest.fn(() => Promise.resolve({
    id: 'resp-1',
    object: 'chat.completion',
    created: Date.now(),
    model: 'gpt-4o',
    choices: [{ index: 0, message: { role: 'assistant', content: 'Hello' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  })),
  chatCompleteStream: jest.fn(() => Promise.resolve(new ReadableStream())),
}));

jest.mock('../../src/services/cache', () => ({
  getCache: jest.fn(() => Promise.resolve(null)),
  setCache: jest.fn(() => Promise.resolve()),
}));

jest.mock('../../src/services/semantic-cache', () => ({
  getSemanticCache: jest.fn(() => null),
  initSemanticCache: jest.fn(),
}));

jest.mock('../../src/plugins', () => ({
  runGuardrailPlugins: jest.fn(() => Promise.resolve({ allowed: true })),
  runRequestPlugins: jest.fn((_c, req) => Promise.resolve(req)),
  runResponsePlugins: jest.fn((_c, res) => Promise.resolve(res)),
  runTransformPlugins: jest.fn((_c, req) => Promise.resolve(req)),
}));

jest.mock('../../src/services/router', () => ({
  smartRoute: jest.fn(() => ({ provider: 'openai', reason: 'default' })),
  evaluateConditionalRules: jest.fn(() => null),
  recordLatency: jest.fn(),
  recordError: jest.fn(),
}));

jest.mock('../../src/utils', () => ({
  ...jest.requireActual('../../src/utils'),
  verifyApiKey: jest.fn((apiKey: string, hashed: string) => apiKey === hashed),
}));

jest.mock('../../src/services/pricing', () => ({
  getPricingService: jest.fn(() => ({
    calculateCost: jest.fn(() => 0.0001),
    getAllPrices: jest.fn(() => ({})),
    getOverrides: jest.fn(() => ({})),
    setPrice: jest.fn(),
    deletePrice: jest.fn(),
  })),
}));

jest.mock('../../src/services/quota', () => ({
  checkQuota: jest.fn(() => ({ allowed: true })),
  recordUsage: jest.fn(),
  checkKeyQuota: jest.fn(() => ({ allowed: true })),
}));

jest.mock('../../src/services/token-ratelimit', () => ({
  getTokenRateLimit: jest.fn(() => null),
}));

jest.mock('../../src/services/metrics', () => ({
  recordMetric: jest.fn(),
  getTenantUsage: jest.fn(() => ({})),
  getUsageByTimeRange: jest.fn(() => []),
  getTimeSeriesMetrics: jest.fn(() => []),
  getProviderStats: jest.fn(() => []),
  getAllTenantsStats: jest.fn(() => []),
  getDashboardOverview: jest.fn(() => ({})),
  getStatusCodeStats: jest.fn(() => []),
  getKeyUsage: jest.fn(() => ({})),
}));

jest.mock('../../src/middleware/metrics', () => ({
  metricsMiddleware: jest.fn((_c, next) => next()),
  metricsHandler: jest.fn(() => new Response('')),
  recordAiTtfb: jest.fn(),
  recordAiTpot: jest.fn(),
  recordAiCost: jest.fn(),
  recordAiTokens: jest.fn(),
  resetMetrics: jest.fn(),
}));

jest.mock('../../src/services/request-log', () => ({
  getRequestLogStore: jest.fn(() => ({
    shouldSample: jest.fn(() => false),
    add: jest.fn(),
    getLogs: jest.fn(() => []),
    getTotalCount: jest.fn(() => 0),
  })),
}));

describe('Conversation Logging Integration', () => {
  let app: ReturnType<typeof createApp>;

  beforeAll(() => {
    app = createApp();
  });

  beforeEach(() => {
    resetConversationLogService();
  });

  afterEach(async () => {
    const service = getConversationLogService();
    await service.clearAll();
  });

  const authHeader = { Authorization: 'Bearer test-api-key-123' };
  const adminAuth = { Authorization: 'Bearer admin-dashboard-key-456' };

  describe('POST /v1/chat/completions', () => {
    it('should return X-Session-Id header', async () => {
      const res = await app.request('/v1/chat/completions', {
        method: 'POST',
        headers: { ...authHeader, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: 'Hi' }] }),
      });

      expect(res.status).toBe(200);
      expect(res.headers.get('x-session-id')).toBeDefined();
      expect(res.headers.get('x-session-id')).toMatch(/^sess_\d+_/);
    });

    it('should accept and return custom X-Session-Id header', async () => {
      const res = await app.request('/v1/chat/completions', {
        method: 'POST',
        headers: { ...authHeader, 'Content-Type': 'application/json', 'X-Session-Id': 'my-test-session' },
        body: JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: 'Hi' }] }),
      });

      expect(res.status).toBe(200);
      expect(res.headers.get('x-session-id')).toBe('my-test-session');
    });
  });

  describe('Admin API /v1/conversations', () => {
    it('should reject non-admin access', async () => {
      const res = await app.request('/v1/conversations', {
        headers: authHeader,
      });

      expect(res.status).toBe(403);
    });

    it('should list sessions with admin key', async () => {
      // First make a chat request to generate a session
      await app.request('/v1/chat/completions', {
        method: 'POST',
        headers: { ...authHeader, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: 'Hello' }] }),
      });

      // Small delay for fire-and-forget saveTurn
      await new Promise((r) => setTimeout(r, 100));

      const res = await app.request('/v1/conversations', {
        headers: adminAuth,
      });

      expect(res.status).toBe(200);
      const body = await res.json() as { sessions: unknown[]; total: number };
      expect(body.sessions).toBeDefined();
      expect(typeof body.total).toBe('number');
    });

    it('should return 404 for unknown session', async () => {
      const res = await app.request('/v1/conversations/nonexistent-session', {
        headers: adminAuth,
      });

      expect(res.status).toBe(404);
      const body = await res.json() as { error: { message: string } };
      expect(body.error).toBeDefined();
    });

    it('should delete a session', async () => {
      // Create a session first
      const chatRes = await app.request('/v1/chat/completions', {
        method: 'POST',
        headers: { ...authHeader, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: 'Hello' }] }),
      });

      const sessionId = chatRes.headers.get('x-session-id');
      expect(sessionId).toBeDefined();

      // Small delay for fire-and-forget saveTurn
      await new Promise((r) => setTimeout(r, 100));

      const delRes = await app.request(`/v1/conversations/${sessionId}`, {
        method: 'DELETE',
        headers: adminAuth,
      });

      expect(delRes.status).toBe(200);
      const delBody = await delRes.json() as { success: boolean };
      expect(delBody.success).toBe(true);

      // Verify it's gone
      const getRes = await app.request(`/v1/conversations/${sessionId}`, {
        headers: adminAuth,
      });

      expect(getRes.status).toBe(404);
    });
  });
});
