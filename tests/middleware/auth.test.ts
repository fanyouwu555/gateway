/**
 * 认证中间件测试
 */
import { Hono } from 'hono';
import { authMiddleware, generateTestApiKey } from '../../src/../src/middleware/auth';

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
  describe('generateTestApiKey', () => {
    it('should generate test API key with hash', () => {
      const key = generateTestApiKey('test-key');
      expect(key).toBeDefined();
      expect(key.key).toMatch(/^\$scrypt\$/); // key 已被哈希
      expect(key.tenant_id).toBe('default');
      expect(key.name).toBe('test-key');
    });

    it('should use default name if not provided', () => {
      const key = generateTestApiKey();
      expect(key.name).toBe('test-key');
    });
  });

  describe('authMiddleware with Hono app', () => {
    let app: Hono;

    beforeEach(() => {
      app = new Hono();
      app.use('*', authMiddleware);
      app.get('/test', (c) => c.json({ ok: true }));
    });

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
