/**
 * Admin API Route Tests
 */
import { createApp } from '../../src/app';

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
}));

jest.mock('../../src/providers', () => ({
  getProviderNames: jest.fn(() => ['openai']),
  chatComplete: jest.fn(),
  chatCompleteStream: jest.fn(),
}));

jest.mock('../../src/services/cache', () => ({
  getCacheStats: jest.fn(() => ({ size: 0, hit_rate: 0 })),
  cleanCache: jest.fn(() => 0),
}));

jest.mock('../../src/services/history', () => ({
  getSessionStats: jest.fn(() => ({ total_sessions: 0 })),
  cleanSessions: jest.fn(() => 0),
}));

jest.mock('../../src/services/metrics', () => ({
  getTenantUsage: jest.fn(() => ({})),
  getUsageByTimeRange: jest.fn(() => []),
  getTimeSeriesMetrics: jest.fn(() => []),
  getProviderStats: jest.fn(() => []),
  getAllTenantsStats: jest.fn(() => []),
  getDashboardOverview: jest.fn(() => ({})),
  getStatusCodeStats: jest.fn(() => []),
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

describe('Admin API Routes', () => {
  let app: ReturnType<typeof createApp>;

  beforeAll(() => {
    app = createApp();
  });

  const adminAuth = { Authorization: 'Bearer admin-dashboard-key-456' };

  it('GET /v1/usage should return usage stats', async () => {
    const res = await app.request('/v1/usage?tenant_id=default', { headers: adminAuth });
    expect(res.status).toBe(200);
  });

  it('GET /v1/cache should return cache stats', async () => {
    const res = await app.request('/v1/cache', { headers: adminAuth });
    expect(res.status).toBe(200);
    const body = await res.json() as { size: number };
    expect(body).toHaveProperty('size');
  });

  it('GET /v1/plugins should return plugin list', async () => {
    const res = await app.request('/v1/plugins', { headers: adminAuth });
    expect(res.status).toBe(200);
    const body = await res.json() as { plugins: unknown[] };
    expect(body).toHaveProperty('plugins');
  });

  it('POST /v1/plugins/register should reject invalid code', async () => {
    const res = await app.request('/v1/plugins/register', {
      method: 'POST',
      headers: { ...adminAuth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: '' }),
    });
    expect(res.status).toBe(400);
  });

  it('DELETE /v1/plugins/:id should return 404 for unknown plugin', async () => {
    const res = await app.request('/v1/plugins/unknown-id', {
      method: 'DELETE',
      headers: adminAuth,
    });
    expect(res.status).toBe(404);
  });

  it('GET /v1/prompts should return templates', async () => {
    const res = await app.request('/v1/prompts', { headers: adminAuth });
    expect(res.status).toBe(200);
    const body = await res.json() as { templates: unknown[] };
    expect(body).toHaveProperty('templates');
  });

  it('POST /v1/prompts should create template', async () => {
    const { createTemplate } = require('../../src/services/prompt');
    createTemplate.mockReturnValue({ id: 'test-tpl', name: 'Test' });
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

  it('DELETE /v1/prompts/:id should delete template', async () => {
    const res = await app.request('/v1/prompts/test-tpl', {
      method: 'DELETE',
      headers: adminAuth,
    });
    expect(res.status).toBe(200);
  });

  it('POST /v1/prompts/:id/render should render template', async () => {
    const { renderTemplate } = require('../../src/services/prompt');
    renderTemplate.mockReturnValue('Hello World');
    const res = await app.request('/v1/prompts/test-tpl/render', {
      method: 'POST',
      headers: { ...adminAuth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ variables: { name: 'World' } }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { rendered: string };
    expect(body.rendered).toBe('Hello World');
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
});