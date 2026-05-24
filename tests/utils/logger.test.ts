/**
 * Logger utility tests
 */
import { writeLog, getCurrentLogLevel, logError, sanitizeLogData } from '../../src/utils/logger';

describe('Logger', () => {
  const originalEnv = process.env.NODE_ENV;
  const originalLogLevel = process.env.LOG_LEVEL;

  beforeEach(() => {
    process.env.NODE_ENV = 'test';
    delete process.env.LOG_LEVEL;
  });

  afterAll(() => {
    process.env.NODE_ENV = originalEnv;
    process.env.LOG_LEVEL = originalLogLevel;
  });

  describe('getCurrentLogLevel', () => {
    it('should default to info', () => {
      expect(getCurrentLogLevel()).toBe('info');
    });

    it('should read from env', () => {
      process.env.LOG_LEVEL = 'debug';
      expect(getCurrentLogLevel()).toBe('debug');
    });

    it('should fallback for invalid level', () => {
      process.env.LOG_LEVEL = 'invalid';
      expect(getCurrentLogLevel()).toBe('info');
    });
  });

  describe('writeLog', () => {
    it('should log at info level', () => {
      expect(() => writeLog('info', 'test message')).not.toThrow();
    });

    it('should skip logs below current level', () => {
      process.env.LOG_LEVEL = 'error';
      expect(() => writeLog('debug', 'debug message')).not.toThrow();
    });

    it('should log in production mode', () => {
      process.env.NODE_ENV = 'production';
      expect(() => writeLog('info', 'prod message')).not.toThrow();
    });
  });

  describe('logError', () => {
    it('should log error with context', () => {
      const error = new Error('test error');
      expect(() => logError('req-1', error, { extra: 'data' })).not.toThrow();
    });
  });

  describe('sanitizeLogData', () => {
    it('should mask api_key', () => {
      const result = sanitizeLogData({ api_key: 'sk-secret-key', other: 'data' });
      expect(result.api_key).not.toBe('sk-secret-key');
      expect(result.other).toBe('data');
    });

    it('should mask authorization', () => {
      const result = sanitizeLogData({ authorization: 'Bearer token123' });
      expect(result.authorization).not.toBe('Bearer token123');
    });

    it('should leave non-sensitive data unchanged', () => {
      const result = sanitizeLogData({ name: 'test', count: 42 });
      expect(result.name).toBe('test');
      expect(result.count).toBe(42);
    });

    it('should skip non-string sensitive values', () => {
      const result = sanitizeLogData({ api_key: 12345 });
      expect(result.api_key).toBe(12345);
    });
  });
});
