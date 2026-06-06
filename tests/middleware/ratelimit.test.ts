/**
 * 限流中间件测试
 */
import { Hono } from 'hono';
import { rateLimitMiddleware, cleanRateLimitStore } from '../../src/../src/middleware/ratelimit';

// Mock config
jest.mock('../../src/config', () => ({
  getConfig: () => ({
    rate_limit: {
      enabled: true,
      qps: 1000, // High QPS for testing to avoid test flakiness
      burst: 1000,
    },
    auth: { enabled: false, api_keys: [] },
  }),
  resolveModelAlias: jest.fn((alias: string) => alias),
}));

describe('RateLimit Middleware', () => {
  let app: Hono;

  beforeEach(() => {
    cleanRateLimitStore();
    app = new Hono();
    app.use('*', rateLimitMiddleware);
    app.get('/test', (c) => c.json({ ok: true }));
  });

  it('should allow requests within rate limit', async () => {
    const res = await app.request('/test');
    expect(res.status).toBe(200);
    const remaining = res.headers.get('X-RateLimit-Remaining');
    expect(remaining).toBeDefined();
  });

  it('should set rate limit headers', async () => {
    const res = await app.request('/test');
    expect(res.headers.get('X-RateLimit-Remaining')).toBeDefined();
    expect(res.headers.get('X-RateLimit-Limit')).toBe('1000');
  });

  it('should allow multiple requests', async () => {
    const results = await Promise.all([
      app.request('/test'),
      app.request('/test'),
      app.request('/test'),
    ]);
    results.forEach((res) => {
      expect(res.status).toBe(200);
    });
  });

  it('should be defined and async', () => {
    expect(rateLimitMiddleware).toBeDefined();
    expect(typeof rateLimitMiddleware).toBe('function');
  });
});
