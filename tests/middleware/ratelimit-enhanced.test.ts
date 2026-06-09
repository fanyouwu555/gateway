/**
 * Enhanced Rate Limit Middleware Tests
 * Verify Retry-After header on 429 responses
 */
import { rateLimitMiddleware, resetRateLimitStore } from '../../src/middleware/ratelimit';
import { Hono } from 'hono';

jest.mock('../../src/config', () => ({
  getConfig: jest.fn(() => ({
    rate_limit: { enabled: true, qps: 10, burst: 20 },
    auth: { enabled: true },
  })),
}));

describe('Enhanced Rate Limiting', () => {
  let app: Hono;

  beforeEach(() => {
    resetRateLimitStore();
    app = new Hono();
    app.use('*', rateLimitMiddleware);
    app.get('/test', (c) => c.json({ ok: true }));
  });

  it('should add Retry-After header on 429', async () => {
    // Exhaust the rate limit (burst = 20, so 21 requests should trigger 429)
    for (let i = 0; i < 25; i++) {
      await app.request('/test', {
        headers: { Authorization: 'Bearer key-1' },
      });
    }

    const res = await app.request('/test', {
      headers: { Authorization: 'Bearer key-1' },
    });

    expect(res.status).toBe(429);
    const retryAfter = res.headers.get('Retry-After');
    expect(retryAfter).toBeTruthy();
    const retryAfterNum = parseInt(retryAfter!, 10);
    expect(retryAfterNum).toBeGreaterThanOrEqual(1);
  });

  it('should include rate limit error code', async () => {
    // Exhaust the rate limit
    for (let i = 0; i < 25; i++) {
      await app.request('/test', {
        headers: { Authorization: 'Bearer key-2' },
      });
    }

    const res = await app.request('/test', {
      headers: { Authorization: 'Bearer key-2' },
    });

    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe('rate_limit_exceeded');
  });
});
