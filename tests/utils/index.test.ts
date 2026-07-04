/**
 * 工具函数测试
 */
import {
  generateRequestId,
  getTimestamp,
  maskApiKey,
  getEnv,
  parseBearerToken,
  deepMerge,
  getRetryDelay,
  safeJsonParse,
  delay,
  formatBytes,
  contentToString,
  parseImageDataUrl,
  shouldUseRedis,
  hashApiKey,
  verifyApiKey,
  ensureKeyHashed,
} from '../../src/utils';

describe('Utils', () => {
  describe('generateRequestId', () => {
    it('should generate request ID with req_ prefix', () => {
      const id = generateRequestId();
      expect(id).toMatch(/^req_[a-f0-9]+$/);
    });

    it('should generate unique IDs', () => {
      const id1 = generateRequestId();
      const id2 = generateRequestId();
      expect(id1).not.toBe(id2);
    });
  });

  describe('getTimestamp', () => {
    it('should return current timestamp', () => {
      const before = Date.now();
      const timestamp = getTimestamp();
      const after = Date.now();
      expect(timestamp).toBeGreaterThanOrEqual(before);
      expect(timestamp).toBeLessThanOrEqual(after);
    });
  });

  describe('maskApiKey', () => {
    it('should mask short keys completely', () => {
      const key = 'abc';
      expect(maskApiKey(key)).toBe('***');
    });

    it('should show first 4 and last 4 characters', () => {
      const key = 'sk-12345678901234567890';
      const masked = maskApiKey(key);
      expect(masked.startsWith('sk-1')).toBe(true);
      expect(masked.endsWith('7890')).toBe(true);
      expect(masked).not.toContain('2345678901234');
    });

    it('should handle 8-char key', () => {
      const key = '12345678';
      const masked = maskApiKey(key);
      expect(masked).toBe('********');
    });
  });

  describe('getEnv', () => {
    beforeEach(() => {
      delete process.env.TEST_VAR;
    });

    it('should return value from process.env', () => {
      process.env.TEST_VAR = 'test-value';
      expect(getEnv('TEST_VAR')).toBe('test-value');
    });

    it('should return default value when not set', () => {
      expect(getEnv('TEST_VAR', 'default')).toBe('default');
    });

    it('should return empty string for missing without default', () => {
      expect(getEnv('MISSING_VAR')).toBe('');
    });
  });

  describe('parseBearerToken', () => {
    it('should parse valid Bearer token', () => {
      const token = parseBearerToken('Bearer abc123');
      expect(token).toBe('abc123');
    });

    it('should return null for invalid format', () => {
      expect(parseBearerToken('Basic abc123')).toBe(null);
      expect(parseBearerToken('')).toBe(null);
      expect(parseBearerToken(null)).toBe(null);
    });
  });

  describe('deepMerge', () => {
    it('should merge objects deeply', () => {
      const target = { a: 1, b: { c: 2 } as Record<string, unknown> };
      const source = { b: { d: 3 }, e: 4 } as Partial<typeof target>;
      const result = deepMerge(target, source as typeof target);
      expect(result).toEqual({ a: 1, b: { c: 2, d: 3 }, e: 4 });
    });

    it('should not mutate source', () => {
      const target = { a: 1 } as Record<string, unknown>;
      const source = { b: 2 } as Partial<typeof target>;
      deepMerge(target, source);
      expect(source).toEqual({ b: 2 });
    });
  });

  describe('getRetryDelay', () => {
    it('should calculate exponential backoff', () => {
      expect(getRetryDelay(0)).toBe(1000);
      expect(getRetryDelay(1)).toBe(2000);
      expect(getRetryDelay(2)).toBe(4000);
    });

    it('should cap at 30 seconds', () => {
      expect(getRetryDelay(10)).toBe(30000);
    });

    it('should respect custom base delay', () => {
      expect(getRetryDelay(0, 500)).toBe(500);
      expect(getRetryDelay(1, 500)).toBe(1000);
    });
  });

  describe('safeJsonParse', () => {
    it('should parse valid JSON', () => {
      const result = safeJsonParse('{"a": 1}', { b: 2 });
      expect(result).toEqual({ a: 1 });
    });

    it('should return fallback for invalid JSON', () => {
      const result = safeJsonParse('invalid', { default: true });
      expect(result).toEqual({ default: true });
    });
  });

  describe('delay', () => {
    it('should resolve after specified ms', async () => {
      const start = Date.now();
      await delay(50);
      const elapsed = Date.now() - start;
      expect(elapsed).toBeGreaterThanOrEqual(40);
      expect(elapsed).toBeLessThan(100);
    });
  });

  describe('formatBytes', () => {
    it('should format zero bytes', () => {
      expect(formatBytes(0)).toBe('0 B');
    });

    it('should format bytes to KB/MB/GB', () => {
      expect(formatBytes(1024)).toBe('1 KB');
      expect(formatBytes(1024 * 1024)).toBe('1 MB');
      expect(formatBytes(1024 * 1024 * 1024)).toBe('1 GB');
    });
  });

  describe('contentToString', () => {
    it('should return empty string for undefined', () => {
      expect(contentToString(undefined)).toBe('');
    });

    it('should return string as-is', () => {
      expect(contentToString('hello')).toBe('hello');
    });

    it('should join text parts', () => {
      expect(contentToString([{ type: 'text', text: 'hello' }, { type: 'text', text: 'world' }])).toBe('hello\nworld');
    });
  });

  describe('parseImageDataUrl', () => {
    it('should parse valid data URL', () => {
      const result = parseImageDataUrl('data:image/png;base64,abc123');
      expect(result).toEqual({ mimeType: 'image/png', data: 'abc123' });
    });

    it('should return null for invalid URL', () => {
      expect(parseImageDataUrl('not-a-data-url')).toBeNull();
    });
  });

  describe('shouldUseRedis', () => {
    const originalEnv = process.env;

    beforeEach(() => {
      jest.resetModules();
      process.env = { ...originalEnv };
      delete process.env.TEST_MODULE_STORAGE;
      delete process.env.STORAGE_TYPE;
      delete process.env.REDIS_URL;
      delete process.env.REDIS_HOST;
    });

    afterAll(() => {
      process.env = originalEnv;
    });

    it('should respect module env var', () => {
      process.env.TEST_MODULE_STORAGE = 'redis';
      expect(shouldUseRedis('TEST_MODULE_STORAGE')).toBe(true);
      process.env.TEST_MODULE_STORAGE = 'memory';
      expect(shouldUseRedis('TEST_MODULE_STORAGE')).toBe(false);
    });

    it('should follow global STORAGE_TYPE', () => {
      process.env.STORAGE_TYPE = 'redis';
      expect(shouldUseRedis()).toBe(true);
    });

    it('should detect REDIS_URL or REDIS_HOST', () => {
      process.env.REDIS_URL = 'redis://localhost';
      expect(shouldUseRedis()).toBe(true);
      delete process.env.REDIS_URL;
      process.env.REDIS_HOST = 'localhost';
      expect(shouldUseRedis()).toBe(true);
    });
  });

  describe('API Key hashing', () => {
    it('should hash and verify API key', () => {
      const key = 'sk-test-12345678';
      const hashed = hashApiKey(key);
      expect(hashed).toMatch(/^\$scrypt\$/);
      expect(verifyApiKey(key, hashed)).toBe(true);
      expect(verifyApiKey('wrong-key', hashed)).toBe(false);
    });

    it('should verify ensureKeyHashed idempotency', () => {
      const key = 'sk-test-12345678';
      const hashed = hashApiKey(key);
      expect(ensureKeyHashed(hashed)).toBe(hashed);
      expect(ensureKeyHashed(key)).not.toBe(key);
      expect(ensureKeyHashed(key)).toMatch(/^\$scrypt\$/);
    });

    it('should reject invalid hash format', () => {
      expect(verifyApiKey('key', 'not-a-hash')).toBe(false);
      expect(verifyApiKey('key', '$scrypt$missing-colon')).toBe(false);
    });
  });
});