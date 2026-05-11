/**
 * 认证中间件测试
 */
import { authMiddleware, generateTestApiKey } from './auth';

// Mock config
jest.mock('../config', () => ({
  getConfig: () => ({
    auth: {
      enabled: true,
      api_keys: [
        { key: 'sk-test-12345678', tenant_id: 'test-tenant', name: 'test-key' },
        { key: 'sk-another-12345678', tenant_id: 'another-tenant', name: 'another-key' },
      ],
    },
  }),
}));

describe('Auth Middleware', () => {
  describe('generateTestApiKey', () => {
    it('should generate test API key', () => {
      const key = generateTestApiKey('test-key');
      expect(key).toBeDefined();
      expect(key.key).toMatch(/^sk-test-/);
      expect(key.tenant_id).toBe('default');
      expect(key.name).toBe('test-key');
    });

    it('should use default name if not provided', () => {
      const key = generateTestApiKey();
      expect(key.name).toBe('test-key');
    });
  });

  describe('authMiddleware', () => {
    it('should be a function', () => {
      expect(typeof authMiddleware).toBe('function');
    });
  });
});