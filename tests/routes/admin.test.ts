/**
 * Admin API Route Tests
 */
import { createApp } from '../../src/app';

// Enable dynamic plugin registration for route tests
process.env.ENABLE_DYNAMIC_PLUGINS = 'true';

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
      api_keys: [{
        key: 'admin-dashboard-key-456',
        tenant_id: 'default',
        name: 'Admin Key',
        created_at: Date.now(),
        is_admin: true,
      }],
    },
    rate_limit: { enabled: false, qps: 1000, burst: 1000 },
  })),
  getProviderConfig: jest.fn(() => ({ provider: 'openai', base_url: 'https://api.openai.com/v1', api_key: 'sk-test' })),
  getProviderForModel: jest.fn(() => 'openai'),
  getRoutingStrategy: jest.fn(() => ({ name: 'default', rules: [{ model: 'gpt-4o', provider: 'openai' }] })),
  setConfig: jest.fn(),
  isModelPool: jest.fn(() => false),
  getModelPool: jest.fn(() => undefined),
}));

jest.mock('../../src/providers', () => ({
  getProviderNames: jest.fn(() => ['openai']),
  getProvider: jest.fn((name: string) => {
    if (name === 'openai') {
      return {
        name: 'openai',
        capabilities: { chat: true, embed: true, streaming: true, vision: true, function_call: true, reasoning: false },
        listModels: jest.fn(() => Promise.resolve([
          { id: 'gpt-4o', owned_by: 'openai', context_window: 128000 },
          { id: 'gpt-4o-mini', owned_by: 'openai', context_window: 128000 },
        ])),
      };
    }
    return undefined;
  }),
  chatComplete: jest.fn(),
  chatCompleteStream: jest.fn(),
}));

jest.mock('../../src/services/cache', () => ({
  getCacheStats: jest.fn(() => ({ size: 0, hit_rate: 0 })),
  flushCache: jest.fn(() => Promise.resolve(0)),
}));

jest.mock('../../src/services/metrics', () => ({
  getTenantUsage: jest.fn(() => ({})),
  getUsageByTimeRange: jest.fn(() => []),
  getTimeSeriesMetrics: jest.fn(() => []),
  getProviderStats: jest.fn(() => []),
  getAllTenantsStats: jest.fn(() => []),
  getDashboardOverview: jest.fn(() => ({})),
  getStatusCodeStats: jest.fn(() => []),
  getKeyUsage: jest.fn(() => ({})),
}));

jest.mock('../../src/services/quota', () => ({
  getQuotaStatus: jest.fn(() => ({})),
}));

jest.mock('../../src/services/router', () => ({
  getRouterStatus: jest.fn(() => ({})),
}));

jest.mock('../../src/middleware/websocket', () => ({
  getWebSocketStats: jest.fn(() => ({ total: 0, by_tenant: {} })),
  cleanWebSocketConnections: jest.fn(() => 0),
}));

jest.mock('../../src/services/tenant', () => ({
  listTenants: jest.fn(() => []),
  getTenant: jest.fn(() => null),
  createTenant: jest.fn(() => ({})),
  updateTenant: jest.fn(() => true),
  deleteTenant: jest.fn(() => true),
  getTenantStats: jest.fn(() => ({})),
  getTenantApiKeys: jest.fn(() => []),
  createTenantApiKey: jest.fn(() => ({ key: 'test-key' })),
  deleteTenantApiKey: jest.fn(() => true),
  findTenantApiKeyByHash: jest.fn(() => null),
  updateTenantApiKeyPolicy: jest.fn(() => null),
  getAllTenantApiKeys: jest.fn(() => []),
}));

jest.mock('../../src/services/prompt', () => ({
  listTemplates: jest.fn(() => []),
  getTemplate: jest.fn(() => null),
  createTemplate: jest.fn((t) => t),
  updateTemplate: jest.fn(() => null),
  deleteTemplate: jest.fn(() => true),
  renderTemplate: jest.fn(() => null),
  parseTemplate: jest.fn(() => []),
}));

jest.mock('../../src/utils', () => ({
  ...jest.requireActual('../../src/utils'),
  verifyApiKey: jest.fn((apiKey: string, hashed: string) => apiKey === hashed),
}));

jest.mock('../../src/services/failover', () => ({
  failoverManager: {
    getProviderHealthStatus: jest.fn(() => ({ openai: { isHealthy: true, totalRequests: 0, errorRate: 0, avgLatencyMs: 0 } })),
  },
}));

jest.mock('../../src/services/alert', () => ({
  listAlertRules: jest.fn(() => []),
  addAlertRule: jest.fn(),
  removeAlertRule: jest.fn(() => true),
  setAlertEnabled: jest.fn(() => true),
  evaluateAlerts: jest.fn(),
}));

jest.mock('../../src/plugins', () => ({
  listPlugins: jest.fn(() => []),
  registerPlugin: jest.fn(),
  unregisterPlugin: jest.fn(() => true),
  setPluginEnabled: jest.fn(() => true),
  resetPluginManager: jest.fn(),
  runRequestPlugins: jest.fn((_, req) => Promise.resolve(req)),
  runResponsePlugins: jest.fn((_, res) => Promise.resolve(res)),
  runGuardrailPlugins: jest.fn(() => Promise.resolve({ allowed: true, reasons: [] })),
  runTransformPlugins: jest.fn((_, data) => Promise.resolve(data)),
  createSensitiveWordFilterPlugin: jest.fn(),
  createLoggingPlugin: jest.fn(),
}));

jest.mock('../../src/plugins/loader', () => ({
  loadPluginInSandbox: jest.fn(),
}));

jest.mock('../../src/utils/audit', () => ({
  auditAdmin: jest.fn(),
}));

describe('Admin API Routes', () => {
  let app: ReturnType<typeof createApp>;

  beforeAll(() => {
    app = createApp();
  });

  const adminAuth = { Authorization: 'Bearer admin-dashboard-key-456' };

  describe('Auth verification', () => {
    it('GET /v1/auth/verify should return admin status', async () => {
      const res = await app.request('/v1/auth/verify', { headers: adminAuth });
      expect(res.status).toBe(200);
      const body = await res.json() as { valid: boolean; is_admin: boolean };
      expect(body.valid).toBe(true);
      expect(body.is_admin).toBe(true);
    });
  });

  describe('Usage stats', () => {
    it('GET /v1/usage should return usage stats', async () => {
      const res = await app.request('/v1/usage?tenant_id=default', { headers: adminAuth });
      expect(res.status).toBe(200);
    });

    it('GET /v1/usage/range should return range stats with default times', async () => {
      const res = await app.request('/v1/usage/range', { headers: adminAuth });
      expect(res.status).toBe(200);
    });

    it('GET /v1/usage/range should accept start and end', async () => {
      const res = await app.request('/v1/usage/range?start=0&end=1000', { headers: adminAuth });
      expect(res.status).toBe(200);
    });

    it('GET /v1/usage/timeseries should return time series', async () => {
      const res = await app.request('/v1/usage/timeseries', { headers: adminAuth });
      expect(res.status).toBe(200);
    });

    it('GET /v1/usage/timeseries should accept granularity', async () => {
      const res = await app.request('/v1/usage/timeseries?granularity=day', { headers: adminAuth });
      expect(res.status).toBe(200);
    });

    it('GET /v1/usage/overview should return dashboard overview', async () => {
      const res = await app.request('/v1/usage/overview', { headers: adminAuth });
      expect(res.status).toBe(200);
    });

    it('GET /v1/usage/providers should return provider stats', async () => {
      const res = await app.request('/v1/usage/providers', { headers: adminAuth });
      expect(res.status).toBe(200);
    });

    it('GET /v1/usage/tenants should return all tenant stats', async () => {
      const res = await app.request('/v1/usage/tenants', { headers: adminAuth });
      expect(res.status).toBe(200);
    });

    it('GET /v1/usage/status-codes should return status code stats', async () => {
      const res = await app.request('/v1/usage/status-codes', { headers: adminAuth });
      expect(res.status).toBe(200);
    });
  });

  describe('Quota', () => {
    it('GET /v1/quota should return quota status', async () => {
      const res = await app.request('/v1/quota', { headers: adminAuth });
      expect(res.status).toBe(200);
    });
  });

  describe('Cache management', () => {
    it('GET /v1/cache should return cache stats', async () => {
      const res = await app.request('/v1/cache', { headers: adminAuth });
      expect(res.status).toBe(200);
      const body = await res.json() as { size: number };
      expect(body).toHaveProperty('size');
    });

    it('POST /v1/cache/clean should clean cache', async () => {
      const res = await app.request('/v1/cache/clean', { method: 'POST', headers: adminAuth });
      expect(res.status).toBe(200);
      const body = await res.json() as { cleaned: boolean };
      expect(body.cleaned).toBe(true);
    });
  });

  describe('Router status', () => {
    it('GET /v1/router/status should return router status', async () => {
      const res = await app.request('/v1/router/status', { headers: adminAuth });
      expect(res.status).toBe(200);
    });
  });

  describe('Prompt templates', () => {
    it('GET /v1/prompts should return templates', async () => {
      const res = await app.request('/v1/prompts', { headers: adminAuth });
      expect(res.status).toBe(200);
      const body = await res.json() as { templates: unknown[] };
      expect(body).toHaveProperty('templates');
    });

    it('GET /v1/prompts/:id should return template', async () => {
      const { getTemplate } = require('../../src/services/prompt');
      getTemplate.mockReturnValueOnce({ id: 'test-tpl', name: 'Test', template: 'Hello' });
      const res = await app.request('/v1/prompts/test-tpl', { headers: adminAuth });
      expect(res.status).toBe(200);
      const body = await res.json() as { id: string };
      expect(body.id).toBe('test-tpl');
    });

    it('GET /v1/prompts/:id should return 404 for missing template', async () => {
      const { getTemplate } = require('../../src/services/prompt');
      getTemplate.mockReturnValueOnce(null);
      const res = await app.request('/v1/prompts/missing', { headers: adminAuth });
      expect(res.status).toBe(404);
    });

    it('POST /v1/prompts should create template', async () => {
      const { createTemplate } = require('../../src/services/prompt');
      createTemplate.mockReturnValueOnce({ id: 'test-tpl', name: 'Test' });
      const res = await app.request('/v1/prompts', {
        method: 'POST',
        headers: { ...adminAuth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 'test-tpl', name: 'Test', template: 'Hello {{name}}' }),
      });
      expect(res.status).toBe(201);
    });

    it('POST /v1/prompts should reject missing fields', async () => {
      const res = await app.request('/v1/prompts', {
        method: 'POST',
        headers: { ...adminAuth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 'test' }),
      });
      expect(res.status).toBe(400);
    });

    it('PUT /v1/prompts/:id should update template', async () => {
      const { updateTemplate } = require('../../src/services/prompt');
      updateTemplate.mockReturnValueOnce({ id: 'test-tpl', name: 'Updated' });
      const res = await app.request('/v1/prompts/test-tpl', {
        method: 'PUT',
        headers: { ...adminAuth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Updated' }),
      });
      expect(res.status).toBe(200);
    });

    it('PUT /v1/prompts/:id should return 404 for missing template', async () => {
      const { updateTemplate } = require('../../src/services/prompt');
      updateTemplate.mockReturnValueOnce(null);
      const res = await app.request('/v1/prompts/missing', {
        method: 'PUT',
        headers: { ...adminAuth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Updated' }),
      });
      expect(res.status).toBe(404);
    });

    it('DELETE /v1/prompts/:id should delete template', async () => {
      const res = await app.request('/v1/prompts/test-tpl', {
        method: 'DELETE',
        headers: adminAuth,
      });
      expect(res.status).toBe(200);
    });

    it('DELETE /v1/prompts/:id should return 404 for missing template', async () => {
      const { deleteTemplate } = require('../../src/services/prompt');
      deleteTemplate.mockReturnValueOnce(false);
      const res = await app.request('/v1/prompts/missing', {
        method: 'DELETE',
        headers: adminAuth,
      });
      expect(res.status).toBe(404);
    });

    it('POST /v1/prompts/:id/render should render template', async () => {
      const { renderTemplate } = require('../../src/services/prompt');
      renderTemplate.mockReturnValueOnce('Hello World');
      const res = await app.request('/v1/prompts/test-tpl/render', {
        method: 'POST',
        headers: { ...adminAuth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ variables: { name: 'World' } }),
      });
      expect(res.status).toBe(200);
      const body = await res.json() as { rendered: string };
      expect(body.rendered).toBe('Hello World');
    });

    it('POST /v1/prompts/:id/render should return 404 for missing template', async () => {
      const { renderTemplate } = require('../../src/services/prompt');
      renderTemplate.mockReturnValueOnce(null);
      const res = await app.request('/v1/prompts/missing/render', {
        method: 'POST',
        headers: { ...adminAuth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ variables: {} }),
      });
      expect(res.status).toBe(404);
    });
  });

  describe('Tenant management', () => {
    it('GET /v1/tenants should return tenants', async () => {
      const res = await app.request('/v1/tenants', { headers: adminAuth });
      expect(res.status).toBe(200);
      const body = await res.json() as { tenants: unknown[] };
      expect(body).toHaveProperty('tenants');
    });

    it('POST /v1/tenants should create tenant', async () => {
      const { createTenant } = require('../../src/services/tenant');
      createTenant.mockReturnValueOnce({ id: 't1', name: 'Test Tenant' });
      const res = await app.request('/v1/tenants', {
        method: 'POST',
        headers: { ...adminAuth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Test Tenant', status: 'active', plan: 'free' }),
      });
      expect(res.status).toBe(201);
    });

    it('POST /v1/tenants should reject invalid data', async () => {
      const res = await app.request('/v1/tenants', {
        method: 'POST',
        headers: { ...adminAuth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: '' }),
      });
      expect(res.status).toBe(400);
    });

    it('POST /v1/tenants should return 400 when create fails', async () => {
      const { createTenant } = require('../../src/services/tenant');
      createTenant.mockReturnValueOnce(null);
      const res = await app.request('/v1/tenants', {
        method: 'POST',
        headers: { ...adminAuth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Test', status: 'active', plan: 'free' }),
      });
      expect(res.status).toBe(400);
    });

    it('GET /v1/tenants/:id should return tenant', async () => {
      const { getTenant } = require('../../src/services/tenant');
      // Auth middleware calls getTenant('default') first (for the admin key's tenant_id),
      // then the route handler calls getTenant('t1'). We need to queue two return values.
      getTenant.mockReturnValueOnce(null); // for auth middleware check on 'default'
      getTenant.mockReturnValueOnce({ id: 't1', name: 'Test', status: 'active' }); // for route handler
      const res = await app.request('/v1/tenants/t1', { headers: adminAuth });
      expect(res.status).toBe(200);
    });

    it('GET /v1/tenants/:id should return 404 for missing tenant', async () => {
      const res = await app.request('/v1/tenants/missing', { headers: adminAuth });
      expect(res.status).toBe(404);
    });

    it('GET /v1/tenants/:id/stats should return stats', async () => {
      const res = await app.request('/v1/tenants/t1/stats', { headers: adminAuth });
      expect(res.status).toBe(200);
    });

    it('GET /v1/tenants/:id/keys should return keys', async () => {
      const res = await app.request('/v1/tenants/t1/keys', { headers: adminAuth });
      expect(res.status).toBe(200);
      const body = await res.json() as { keys: unknown[] };
      expect(body).toHaveProperty('keys');
    });

    it('POST /v1/tenants/:id/keys should create key', async () => {
      const { createTenantApiKey } = require('../../src/services/tenant');
      createTenantApiKey.mockReturnValueOnce({ key: 'new-key', name: 'test' });
      const res = await app.request('/v1/tenants/t1/keys', {
        method: 'POST',
        headers: { ...adminAuth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'test' }),
      });
      expect(res.status).toBe(201);
    });

    it('POST /v1/tenants/:id/keys should reject invalid data', async () => {
      const res = await app.request('/v1/tenants/t1/keys', {
        method: 'POST',
        headers: { ...adminAuth, 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
    });

    it('POST /v1/tenants/:id/keys should return 400 when creation fails', async () => {
      const { createTenantApiKey } = require('../../src/services/tenant');
      createTenantApiKey.mockReturnValueOnce(null);
      const res = await app.request('/v1/tenants/t1/keys', {
        method: 'POST',
        headers: { ...adminAuth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'test' }),
      });
      expect(res.status).toBe(400);
    });

    it('DELETE /v1/keys/:key should delete key', async () => {
      const res = await app.request('/v1/keys/test-key', {
        method: 'DELETE',
        headers: adminAuth,
      });
      expect(res.status).toBe(200);
      const body = await res.json() as { deleted: boolean };
      expect(body.deleted).toBe(true);
    });

    it('DELETE /v1/keys/:key should return 404 for missing key', async () => {
      const { deleteTenantApiKey } = require('../../src/services/tenant');
      deleteTenantApiKey.mockReturnValueOnce(false);
      const res = await app.request('/v1/keys/missing', {
        method: 'DELETE',
        headers: adminAuth,
      });
      expect(res.status).toBe(404);
    });

    it('PUT /v1/tenants/:id/keys/:keyHash should update key policy', async () => {
      const { updateTenantApiKeyPolicy } = require('../../src/services/tenant');
      updateTenantApiKeyPolicy.mockReturnValueOnce({ name: 'updated' });
      const res = await app.request('/v1/tenants/t1/keys/hash123', {
        method: 'PUT',
        headers: { ...adminAuth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'updated' }),
      });
      expect(res.status).toBe(200);
    });

    it('PUT /v1/tenants/:id/keys/:keyHash should reject invalid data', async () => {
      const res = await app.request('/v1/tenants/t1/keys/hash123', {
        method: 'PUT',
        headers: { ...adminAuth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: '' }),
      });
      expect(res.status).toBe(400);
    });

    it('PUT /v1/tenants/:id/keys/:keyHash should return 404 for missing key', async () => {
      const { updateTenantApiKeyPolicy } = require('../../src/services/tenant');
      updateTenantApiKeyPolicy.mockReturnValueOnce(null);
      const res = await app.request('/v1/tenants/t1/keys/missing', {
        method: 'PUT',
        headers: { ...adminAuth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'updated' }),
      });
      expect(res.status).toBe(404);
    });

    it('GET /v1/tenants/:id/keys/:keyHash/usage should return usage', async () => {
      const { findTenantApiKeyByHash } = require('../../src/services/tenant');
      findTenantApiKeyByHash.mockReturnValueOnce({ name: 'test' });
      const res = await app.request('/v1/tenants/t1/keys/hash123/usage', { headers: adminAuth });
      expect(res.status).toBe(200);
      const body = await res.json() as { key: { name: string } };
      expect(body.key.name).toBe('test');
    });

    it('GET /v1/tenants/:id/keys/:keyHash/usage should return 404 for missing key', async () => {
      const res = await app.request('/v1/tenants/t1/keys/missing/usage', { headers: adminAuth });
      expect(res.status).toBe(404);
    });

    it('PUT /v1/tenants/:id should update tenant', async () => {
      const { updateTenant } = require('../../src/services/tenant');
      updateTenant.mockReturnValueOnce({ id: 't1', name: 'Updated', status: 'active' });
      const res = await app.request('/v1/tenants/t1', {
        method: 'PUT',
        headers: { ...adminAuth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Updated' }),
      });
      expect(res.status).toBe(200);
    });

    it('PUT /v1/tenants/:id should reject invalid data', async () => {
      const res = await app.request('/v1/tenants/t1', {
        method: 'PUT',
        headers: { ...adminAuth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: '' }),
      });
      expect(res.status).toBe(400);
    });

    it('PUT /v1/tenants/:id should return 404 for missing tenant', async () => {
      const { updateTenant } = require('../../src/services/tenant');
      updateTenant.mockReturnValueOnce(null);
      const res = await app.request('/v1/tenants/missing', {
        method: 'PUT',
        headers: { ...adminAuth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Updated' }),
      });
      expect(res.status).toBe(404);
    });

    it('DELETE /v1/tenants/:id should delete tenant', async () => {
      const res = await app.request('/v1/tenants/t1', {
        method: 'DELETE',
        headers: adminAuth,
      });
      expect(res.status).toBe(200);
      const body = await res.json() as { deleted: boolean };
      expect(body.deleted).toBe(true);
    });

    it('DELETE /v1/tenants/:id should return 400 when delete fails', async () => {
      const { deleteTenant } = require('../../src/services/tenant');
      deleteTenant.mockReturnValueOnce(false);
      const res = await app.request('/v1/tenants/t1', {
        method: 'DELETE',
        headers: adminAuth,
      });
      expect(res.status).toBe(400);
    });
  });

  describe('Config management', () => {
    it('GET /v1/config should return safe config', async () => {
      const res = await app.request('/v1/config', { headers: adminAuth });
      expect(res.status).toBe(200);
      const body = await res.json() as { port: number; providers: unknown };
      expect(body).toHaveProperty('port');
      // Safe config includes providers but strips api_key
      expect(body).toHaveProperty('providers');
      expect(body.providers).not.toHaveProperty('api_key');
    });

    it('PUT /v1/config should update config', async () => {
      const res = await app.request('/v1/config', {
        method: 'PUT',
        headers: { ...adminAuth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ port: 3001 }),
      });
      expect(res.status).toBe(200);
      const body = await res.json() as { updated: boolean };
      expect(body.updated).toBe(true);
    });

    it('PUT /v1/config should reject invalid data', async () => {
      const res = await app.request('/v1/config', {
        method: 'PUT',
        headers: { ...adminAuth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ port: -1 }),
      });
      expect(res.status).toBe(400);
    });

    it('GET /v1/config/aliases should return aliases', async () => {
      const res = await app.request('/v1/config/aliases', { headers: adminAuth });
      expect(res.status).toBe(200);
      const body = await res.json() as { aliases: Record<string, string> };
      expect(body).toHaveProperty('aliases');
    });

    it('PUT /v1/config/aliases should update aliases', async () => {
      const res = await app.request('/v1/config/aliases', {
        method: 'PUT',
        headers: { ...adminAuth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ fast: 'gpt-4o-mini' }),
      });
      expect(res.status).toBe(200);
      const body = await res.json() as { updated: boolean };
      expect(body.updated).toBe(true);
    });

    it('PUT /v1/config/aliases should reject non-object body', async () => {
      const res = await app.request('/v1/config/aliases', {
        method: 'PUT',
        headers: { ...adminAuth, 'Content-Type': 'application/json' },
        body: JSON.stringify([]),
      });
      expect(res.status).toBe(400);
    });
  });

  describe('WebSocket stats', () => {
    it('GET /v1/ws should return ws stats', async () => {
      const res = await app.request('/v1/ws', { headers: adminAuth });
      expect(res.status).toBe(200);
    });

    it('POST /v1/ws/clean should clean ws connections', async () => {
      const res = await app.request('/v1/ws/clean', { method: 'POST', headers: adminAuth });
      expect(res.status).toBe(200);
    });
  });

  describe('Plugins', () => {
    it('GET /v1/plugins should return plugin list', async () => {
      const res = await app.request('/v1/plugins', { headers: adminAuth });
      expect(res.status).toBe(200);
      const body = await res.json() as { plugins: unknown[] };
      expect(body).toHaveProperty('plugins');
    });

    it('POST /v1/plugins/register should register valid plugin', async () => {
      const { loadPluginInSandbox } = require('../../src/plugins/loader');
      loadPluginInSandbox.mockReturnValueOnce({
        success: true,
        plugin: { config: { id: 'p1', name: 'Test', type: 'custom', enabled: true, priority: 1 } },
      });
      const res = await app.request('/v1/plugins/register', {
        method: 'POST',
        headers: { ...adminAuth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: 'exports.config = { id: "p1", name: "Test", type: "custom", enabled: true, priority: 1 };' }),
      });
      expect(res.status).toBe(201);
    });

    it('POST /v1/plugins/register should reject invalid code', async () => {
      const res = await app.request('/v1/plugins/register', {
        method: 'POST',
        headers: { ...adminAuth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: '' }),
      });
      expect(res.status).toBe(400);
    });

    it('POST /v1/plugins/register should reject failed sandbox load', async () => {
      const { loadPluginInSandbox } = require('../../src/plugins/loader');
      loadPluginInSandbox.mockReturnValueOnce({ success: false, error: 'Syntax error' });
      const res = await app.request('/v1/plugins/register', {
        method: 'POST',
        headers: { ...adminAuth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: 'invalid' }),
      });
      expect(res.status).toBe(400);
    });

    it('DELETE /v1/plugins/:id should unregister plugin', async () => {
      const { unregisterPlugin } = require('../../src/plugins');
      unregisterPlugin.mockReturnValueOnce(true);
      const res = await app.request('/v1/plugins/p1', {
        method: 'DELETE',
        headers: adminAuth,
      });
      expect(res.status).toBe(200);
    });

    it('DELETE /v1/plugins/:id should reject empty id', async () => {
      const res = await app.request('/v1/plugins/', {
        method: 'DELETE',
        headers: adminAuth,
      });
      // Hono routes won't match trailing slash without param, so this hits a different route or 404
      expect([400, 404]).toContain(res.status);
    });

    it('DELETE /v1/plugins/:id should return 404 for unknown plugin', async () => {
      const { unregisterPlugin } = require('../../src/plugins');
      unregisterPlugin.mockReturnValueOnce(false);
      const res = await app.request('/v1/plugins/unknown-id', {
        method: 'DELETE',
        headers: adminAuth,
      });
      expect(res.status).toBe(404);
    });

    it('POST /v1/plugins/:id/enable should enable plugin', async () => {
      const { setPluginEnabled } = require('../../src/plugins');
      setPluginEnabled.mockReturnValueOnce(true);
      const res = await app.request('/v1/plugins/p1/enable', {
        method: 'POST',
        headers: adminAuth,
      });
      expect(res.status).toBe(200);
    });

    it('POST /v1/plugins/:id/enable should return 404 for unknown plugin', async () => {
      const { setPluginEnabled } = require('../../src/plugins');
      setPluginEnabled.mockReturnValueOnce(false);
      const res = await app.request('/v1/plugins/unknown/enable', {
        method: 'POST',
        headers: adminAuth,
      });
      expect(res.status).toBe(404);
    });

    it('POST /v1/plugins/:id/disable should disable plugin', async () => {
      const { setPluginEnabled } = require('../../src/plugins');
      setPluginEnabled.mockReturnValueOnce(true);
      const res = await app.request('/v1/plugins/p1/disable', {
        method: 'POST',
        headers: adminAuth,
      });
      expect(res.status).toBe(200);
    });

    it('POST /v1/plugins/:id/disable should return 404 for unknown plugin', async () => {
      const { setPluginEnabled } = require('../../src/plugins');
      setPluginEnabled.mockReturnValueOnce(false);
      const res = await app.request('/v1/plugins/unknown/disable', {
        method: 'POST',
        headers: adminAuth,
      });
      expect(res.status).toBe(404);
    });
  });

  describe('Alert rules', () => {
    it('GET /v1/alerts should return rules', async () => {
      const res = await app.request('/v1/alerts', { headers: adminAuth });
      expect(res.status).toBe(200);
      const body = await res.json() as { rules: unknown[] };
      expect(body).toHaveProperty('rules');
    });

    it('POST /v1/alerts should create rule', async () => {
      const res = await app.request('/v1/alerts', {
        method: 'POST',
        headers: { ...adminAuth, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: 'alert1',
          name: 'High Error Rate',
          metric: 'error_rate',
          threshold: 0.1,
          webhook_url: 'https://example.com/webhook',
        }),
      });
      expect(res.status).toBe(201);
    });

    it('POST /v1/alerts should reject missing fields', async () => {
      const res = await app.request('/v1/alerts', {
        method: 'POST',
        headers: { ...adminAuth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 'alert1' }),
      });
      expect(res.status).toBe(400);
    });

    it('DELETE /v1/alerts/:id should remove rule', async () => {
      const res = await app.request('/v1/alerts/alert1', {
        method: 'DELETE',
        headers: adminAuth,
      });
      expect(res.status).toBe(200);
    });

    it('DELETE /v1/alerts/:id should return 404 for unknown rule', async () => {
      const { removeAlertRule } = require('../../src/services/alert');
      removeAlertRule.mockReturnValueOnce(false);
      const res = await app.request('/v1/alerts/unknown', {
        method: 'DELETE',
        headers: adminAuth,
      });
      expect(res.status).toBe(404);
    });

    it('POST /v1/alerts/:id/enable should enable rule', async () => {
      const res = await app.request('/v1/alerts/alert1/enable', {
        method: 'POST',
        headers: adminAuth,
      });
      expect(res.status).toBe(200);
    });

    it('POST /v1/alerts/:id/enable should return 404 for unknown rule', async () => {
      const { setAlertEnabled } = require('../../src/services/alert');
      setAlertEnabled.mockReturnValueOnce(false);
      const res = await app.request('/v1/alerts/unknown/enable', {
        method: 'POST',
        headers: adminAuth,
      });
      expect(res.status).toBe(404);
    });

    it('POST /v1/alerts/:id/disable should disable rule', async () => {
      const res = await app.request('/v1/alerts/alert1/disable', {
        method: 'POST',
        headers: adminAuth,
      });
      expect(res.status).toBe(200);
    });

    it('POST /v1/alerts/:id/disable should return 404 for unknown rule', async () => {
      const { setAlertEnabled } = require('../../src/services/alert');
      setAlertEnabled.mockReturnValueOnce(false);
      const res = await app.request('/v1/alerts/unknown/disable', {
        method: 'POST',
        headers: adminAuth,
      });
      expect(res.status).toBe(404);
    });

    it('POST /v1/alerts/evaluate should trigger evaluation', async () => {
      const res = await app.request('/v1/alerts/evaluate', {
        method: 'POST',
        headers: adminAuth,
      });
      expect(res.status).toBe(200);
      const body = await res.json() as { evaluated: boolean };
      expect(body.evaluated).toBe(true);
    });
  });

  describe('Non-admin access', () => {
    it('should reject requests without admin key', async () => {
      const res = await app.request('/v1/usage', {
        headers: { Authorization: 'Bearer invalid-key' },
      });
      expect(res.status).toBe(401);
    });

    it('should reject requests with non-admin key', async () => {
      jest.resetModules();
      // Re-mock config with a non-admin key
      jest.doMock('../../src/config', () => ({
        getConfig: jest.fn(() => ({
          port: 3000,
          host: '0.0.0.0',
          log_level: 'info',
          providers: {},
          routing: [],
          auth: {
            enabled: true,
            api_keys: [{
              key: 'regular-key',
              tenant_id: 'default',
              name: 'Regular Key',
              created_at: Date.now(),
              is_admin: false,
            }],
          },
          rate_limit: { enabled: false },
        })),
      }));
      jest.doMock('../../src/utils', () => ({
        ...jest.requireActual('../../src/utils'),
        verifyApiKey: jest.fn((apiKey: string, hashed: string) => apiKey === hashed),
      }));

      const { createApp: createApp2 } = await import('../../src/app');
      const app2 = createApp2();
      const res = await app2.request('/v1/usage', {
        headers: { Authorization: 'Bearer regular-key' },
      });
      expect(res.status).toBe(403);
    });
  });

  describe('Model Discovery', () => {
    it('GET /v1/admin/discover-models should return models for all providers', async () => {
      const res = await app.request('/v1/admin/discover-models', { headers: adminAuth });
      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, { models?: Array<{ id: string }>; error?: string }>;
      expect(body.openai).toBeDefined();
      expect(body.openai.models).toBeDefined();
      expect(body.openai.models!.length).toBeGreaterThan(0);
      expect(body.openai.models!.some((m) => m.id === 'gpt-4o')).toBe(true);
    });

    it('GET /v1/admin/discover-models?provider=openai should return single provider', async () => {
      const res = await app.request('/v1/admin/discover-models?provider=openai', { headers: adminAuth });
      expect(res.status).toBe(200);
      const body = await res.json() as { provider: string; models: Array<{ id: string }> };
      expect(body.provider).toBe('openai');
      expect(body.models.length).toBeGreaterThan(0);
    });

    it('GET /v1/admin/discover-models?provider=unknown should return 404', async () => {
      const res = await app.request('/v1/admin/discover-models?provider=nonexistent', { headers: adminAuth });
      expect(res.status).toBe(404);
    });

    it('should require admin auth', async () => {
      const res = await app.request('/v1/admin/discover-models');
      expect(res.status).toBe(401);
    });
  });
});
