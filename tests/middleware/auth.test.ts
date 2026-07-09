/**
 * 认证中间件测试
 */
import { Hono } from 'hono';
import { authMiddleware } from '../../src/../src/middleware/auth';
import {
  createTenant,
  createTenantApiKey,
  resetTenantStore,
  findApiKeyByPrefix,
} from '../../src/../src/services/tenant';

let app: Hono;

beforeEach(() => {
  app = new Hono();
  app.use('*', authMiddleware);
  app.get('/test', (c) => c.json({ ok: true }));
});

// Mock config — keys are always hashed
// Note: hash computation is inside the factory to avoid jest.mock hoisting issues
jest.mock('../../src/config', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { hashApiKey } = require('../../src/utils');
  const testKeyHash = hashApiKey('sk-test-12345678');
  const anotherKeyHash = hashApiKey('sk-another-12345678');
  const expiredKeyHash = hashApiKey('sk-expired-key');
  return {
    getConfig: () => ({
      auth: {
        enabled: true,
        api_keys: [
          { key: testKeyHash, tenant_id: 'test-tenant', name: 'test-key' },
          { key: anotherKeyHash, tenant_id: 'another-tenant', name: 'another-key' },
          { key: expiredKeyHash, tenant_id: 'expired-tenant', name: 'expired-key', expires_at: 1 },
        ],
      },
    }),
    resolveModelAlias: jest.fn((alias: string) => alias),
    isModelPool: jest.fn(() => false),
    getModelPool: jest.fn(() => undefined),
  };
});

describe('Auth Middleware', () => {
  describe('authMiddleware with Hono app', () => {
    it('should return 401 when no API key provided', async () => {
      const res = await app.request('/test');
      expect(res.status).toBe(401);
      const body = await res.json() as { error: { message: string; code: string } };
      expect(body.error.code).toBe('missing_api_key');
    });

    it('should return 401 when invalid API key provided', async () => {
      const res = await app.request('/test', {
        headers: { 'x-api-key': 'sk-invalid-key' },
      });
      expect(res.status).toBe(401);
      const body = await res.json() as { error: { code: string } };
      expect(body.error.code).toBe('invalid_api_key');
    });

    it('should return 401 when expired API key provided', async () => {
      const res = await app.request('/test', {
        headers: { 'x-api-key': 'sk-expired-key' },
      });
      expect(res.status).toBe(401);
      const body = await res.json() as { error: { code: string } };
      expect(body.error.code).toBe('invalid_api_key');
    });

    it('should pass with valid API key via x-api-key header', async () => {
      const res = await app.request('/test', {
        headers: { 'x-api-key': 'sk-test-12345678' },
      });
      expect(res.status).toBe(200);
    });

    it('should pass with valid API key via Authorization Bearer header', async () => {
      const res = await app.request('/test', {
        headers: { Authorization: 'Bearer sk-test-12345678' },
      });
      expect(res.status).toBe(200);
    });

    it('should handle multiple valid keys', async () => {
      const res1 = await app.request('/test', {
        headers: { 'x-api-key': 'sk-test-12345678' },
      });
      const res2 = await app.request('/test', {
        headers: { 'x-api-key': 'sk-another-12345678' },
      });
      expect(res1.status).toBe(200);
      expect(res2.status).toBe(200);
    });
  });
});

describe('authMiddleware with tenant keys', () => {
  beforeEach(() => {
    resetTenantStore();
  });

  it('should authenticate a tenant key using the prefix index', async () => {
    const tenant = await createTenant({
      name: 'Prefix Tenant',
      status: 'active',
      plan: 'free',
      settings: {},
      limits: {
        daily_requests: 1000,
        daily_tokens: 100000,
        max_api_keys: 10,
        concurrent_requests: 10,
      },
    });
    const key = await createTenantApiKey(tenant.tenant_id, 'prefix-key');
    expect(key).toBeDefined();

    const res = await app.request('/test', {
      headers: { 'x-api-key': key!.key },
    });
    expect(res.status).toBe(200);
  });

  it('should reject an invalid tenant key', async () => {
    const res = await app.request('/test', {
      headers: { 'x-api-key': 'sk-tenant-invalid' },
    });
    expect(res.status).toBe(401);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe('invalid_api_key');
  });

  it('should find candidate keys by prefix', async () => {
    const tenant = await createTenant({
      name: 'Prefix Tenant 2',
      status: 'active',
      plan: 'free',
      settings: {},
      limits: {
        daily_requests: 1000,
        daily_tokens: 100000,
        max_api_keys: 200,
        concurrent_requests: 100,
      },
    });
    const key = await createTenantApiKey(tenant.tenant_id, 'prefix-key');
    const prefix = key!.key.slice(0, 10);
    const candidates = findApiKeyByPrefix(prefix);
    expect(candidates.length).toBeGreaterThanOrEqual(1);
  });

  it('should authenticate quickly with 100 tenant keys', async () => {
    const tenant = await createTenant({
      name: 'Perf Tenant',
      status: 'active',
      plan: 'free',
      settings: {},
      limits: {
        daily_requests: 100000,
        daily_tokens: 10000000,
        max_api_keys: 200,
        concurrent_requests: 100,
      },
    });

    const keys: string[] = [];
    for (let i = 0; i < 100; i++) {
      const k = await createTenantApiKey(tenant.tenant_id, `perf-key-${i}`);
      keys.push(k!.key);
    }

    const start = Date.now();
    const res = await app.request('/test', {
      headers: { 'x-api-key': keys[50] },
    });
    const elapsed = Date.now() - start;

    expect(res.status).toBe(200);
    expect(elapsed).toBeLessThan(500);
  });
});
