/**
 * TokenRateLimitStore 测试
 */
import { TokenRateLimitStore, resetTokenRateLimit, getTokenRateLimit } from '../../src/services/token-ratelimit';
import { reloadConfig } from '../../src/config';

describe('TokenRateLimitStore', () => {
  let store: TokenRateLimitStore;

  beforeEach(() => {
    // 设置测试用的限流配置
    reloadConfig();
    const config = require('../../src/config').getConfig();
    config.model_rate_limits = {
      'test-model': { tokens_per_minute: 600 }, // 10 tokens/s
      'slow-model': { tokens_per_minute: 60 },  // 1 token/s
    };
    store = new TokenRateLimitStore();
  });

  afterEach(() => {
    resetTokenRateLimit();
    jest.restoreAllMocks();
  });

  describe('consume', () => {
    it('should allow consumption within limit', () => {
      const allowed = store.consume('test-model', 5);
      expect(allowed).toBe(true);
    });

    it('should return false when exceeding limit', () => {
      // 600 tokens/min, burst = 600
      const allowed = store.consume('test-model', 700);
      expect(allowed).toBe(false);
    });

    it('should refill tokens over time', async () => {
      // 消耗全部 600 tokens
      store.consume('test-model', 600);
      expect(store.getRemaining('test-model')).toBe(0);

      // 等待 1.5 秒，应补充 ~15 tokens (10 tokens/s)
      await new Promise((r) => setTimeout(r, 1500));

      // 现在应该能消耗 10 tokens
      const allowed = store.consume('test-model', 10);
      expect(allowed).toBe(true);
    });

    it('should allow unlimited consumption when model has no config', () => {
      const allowed = store.consume('unconfigured-model', 999999);
      expect(allowed).toBe(true);
    });

    it('should be no-op for zero token count', () => {
      const allowed = store.consume('test-model', 0);
      expect(allowed).toBe(true);
      expect(store.getRemaining('test-model')).toBe(600);
    });

    it('should handle multiple models independently', () => {
      store.consume('test-model', 500);
      store.consume('slow-model', 30);

      // test-model 还剩 100，slow-model 还剩 30
      expect(store.getRemaining('test-model')).toBe(100);
      expect(store.getRemaining('slow-model')).toBe(30);

      // test-model 还能消费 100
      expect(store.consume('test-model', 100)).toBe(true);
      // slow-model 还能消费 30
      expect(store.consume('slow-model', 30)).toBe(true);

      // 都已耗尽
      expect(store.consume('test-model', 1)).toBe(false);
      expect(store.consume('slow-model', 1)).toBe(false);
    });
  });

  describe('getRemaining', () => {
    it('should return burst tokens initially', () => {
      expect(store.getRemaining('test-model')).toBe(600);
    });

    it('should reflect consumed tokens', () => {
      store.consume('test-model', 100);
      expect(store.getRemaining('test-model')).toBe(500);
    });

    it('should return Infinity for unconfigured model', () => {
      expect(store.getRemaining('no-config')).toBe(Infinity);
    });
  });

  describe('clean', () => {
    it('should remove stale buckets', async () => {
      store.consume('test-model', 10);

      // 模拟时间推进 > 60s
      jest.useFakeTimers();
      jest.advanceTimersByTime(61000);
      store.clean(60000);

      // 再次获取时应该重建 bucket
      expect(store.getRemaining('test-model')).toBe(600);
      jest.useRealTimers();
    });
  });

  describe('disabled config', () => {
    it('should return null when model_rate_limits is empty', () => {
      const config = require('../../src/config').getConfig();
      config.model_rate_limits = {};
      expect(getTokenRateLimit()).toBeNull();
    });

    it('should return null when model_rate_limits is undefined', () => {
      const config = require('../../src/config').getConfig();
      delete config.model_rate_limits;
      expect(getTokenRateLimit()).toBeNull();
    });
  });
});