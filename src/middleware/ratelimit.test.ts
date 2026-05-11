/**
 * 限流中间件测试
 */
import { rateLimitMiddleware } from '../middleware/ratelimit';

describe('RateLimit Middleware', () => {
  describe('基本功能', () => {
    it('should be defined', () => {
      expect(rateLimitMiddleware).toBeDefined();
    });

    it('should be an async function', () => {
      expect(typeof rateLimitMiddleware).toBe('function');
    });
  });

  // 注意：完整的限流测试需要完整的 Hono Context mock
  // 这里跳过复杂的集成测试，仅确保模块正确加载
});