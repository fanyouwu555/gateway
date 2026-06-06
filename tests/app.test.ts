/**
 * App factory tests
 */
import { Hono } from 'hono';

const mockGetProviderNames = jest.fn(() => ['openai', 'deepseek']);
const mockGetCacheStats = jest.fn(() => ({ size: 10, hit_rate: 0.5 }));
const mockGetProviderHealthStatus = jest.fn(() => ({
  openai: { isHealthy: true, totalRequests: 100, errorRate: 0.01, avgLatencyMs: 120 },
  deepseek: { isHealthy: false, totalRequests: 50, errorRate: 0.2, avgLatencyMs: 300 },
}));
const mockWriteLog = jest.fn();

jest.mock('../src/providers', () => ({
  getProviderNames: () => mockGetProviderNames(),
}));

jest.mock('../src/services/cache', () => ({
  getCacheStats: () => mockGetCacheStats(),
}));

jest.mock('../src/services/failover', () => ({
  failoverManager: {
    getProviderHealthStatus: () => mockGetProviderHealthStatus(),
  },
}));

jest.mock('../src/utils/logger', () => ({
  writeLog: (...args: unknown[]) => mockWriteLog(...args),
}));

jest.mock('../src/middleware/logger', () => ({
  loggerMiddleware: async (_c: unknown, next: () => Promise<void>) => { await next(); },
}));

jest.mock('../src/middleware/auth', () => ({
  authMiddleware: async (_c: unknown, next: () => Promise<void>) => { await next(); },
}));

jest.mock('../src/middleware/virtual-key', () => ({
  virtualKeyMiddleware: async (_c: unknown, next: () => Promise<void>) => { await next(); },
}));

jest.mock('../src/middleware/ratelimit', () => ({
  rateLimitMiddleware: async (_c: unknown, next: () => Promise<void>) => { await next(); },
}));

jest.mock('../src/middleware/metrics', () => ({
  metricsMiddleware: async (_c: unknown, next: () => Promise<void>) => { await next(); },
  metricsHandler: (c: { text: (s: string) => unknown }) => c.text('# metrics'),
}));

jest.mock('../src/middleware/error', () => ({
  GatewayError: class GatewayError extends Error {
    statusCode = 400;
    code = 'test_error';
    errorType = 'invalid_request_error';
    toResponse() {
      return { error: { message: this.message, type: this.errorType, code: this.code } };
    }
  },
}));

jest.mock('../src/routes/chat', () => ({
  __esModule: true,
  default: new Hono().get('/trigger-error', () => { throw new Error('plain error'); }),
}));

jest.mock('../src/routes/embed', () => ({
  __esModule: true,
  default: new Hono(),
}));

jest.mock('../src/routes/model', () => ({
  __esModule: true,
  default: new Hono(),
}));

jest.mock('../src/routes/admin', () => ({
  __esModule: true,
  default: new Hono().get('/trigger-gateway-error', () => {
    const { GatewayError } = require('../src/middleware/error');
    throw new GatewayError('gateway err');
  }),
}));

jest.mock('../src/config', () => ({
  getConfig: jest.fn(() => ({
    providers: {
      openai: { provider: 'openai', base_url: 'https://api.openai.com/v1', api_key: 'sk-test' },
      deepseek: { provider: 'deepseek', base_url: 'https://api.deepseek.com/v1', api_key: 'sk-deepseek' },
    },
  })),
}));

import { createApp } from '../src/app';

describe('createApp', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.CORS_ORIGIN;
  });

  it('GET / should return gateway info', async () => {
    const app = createApp();
    const res = await app.request('/');
    expect(res.status).toBe(200);
    const body = await res.json() as { name: string; version: string };
    expect(body.name).toBe('AI Gateway');
    expect(body.version).toBe('1.0.0');
  });

  it('GET /health should return provider statuses', async () => {
    const app = createApp();
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    const body = await res.json() as {
      status: string;
      services: {
        providers: Array<{ name: string; status: string; has_api_key: boolean }>;
        cache: { size: number };
      };
    };
    expect(body.status).toBe('ok');
    expect(body.services.providers).toHaveLength(2);

    const openai = body.services.providers.find((p) => p.name === 'openai');
    expect(openai?.status).toBe('active');
    expect(openai?.has_api_key).toBe(true);

    const deepseek = body.services.providers.find((p) => p.name === 'deepseek');
    expect(deepseek?.status).toBe('degraded');
    expect(deepseek?.has_api_key).toBe(true);
  });

  it('GET /health should mark provider inactive when no api key', async () => {
    mockGetProviderNames.mockReturnValueOnce(['unknown']);
    mockGetProviderHealthStatus.mockReturnValueOnce({} as unknown as { openai: { isHealthy: boolean; totalRequests: number; errorRate: number; avgLatencyMs: number }; deepseek: { isHealthy: boolean; totalRequests: number; errorRate: number; avgLatencyMs: number } });
    const app = createApp();
    const res = await app.request('/health');
    const body = await res.json() as { services: { providers: Array<{ status: string }> } };
    expect(body.services.providers[0].status).toBe('inactive');
  });

  it('GET /metrics should return metrics text', async () => {
    const app = createApp();
    const res = await app.request('/metrics');
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('metrics');
  });

  it('should handle GatewayError in global error handler', async () => {
    const app = createApp();
    const res = await app.request('/trigger-gateway-error');
    expect(res.status).toBe(400);
    const body = await res.json() as { error: { message: string; type: string } };
    expect(body.error.message).toBe('gateway err');
    expect(mockWriteLog).toHaveBeenCalled();
  });

  it('should handle plain Error in global error handler', async () => {
    const app = createApp();
    const res = await app.request('/trigger-error');
    expect(res.status).toBe(500);
    const body = await res.json() as { error: { message: string; type: string } };
    expect(body.error.message).toBe('An internal error occurred');
    expect(body.error.type).toBe('internal_error');
  });

  it('should return 404 for unknown routes', async () => {
    const app = createApp();
    const res = await app.request('/unknown-path');
    expect(res.status).toBe(404);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe('not_found');
  });

  it('should use CORS_ORIGIN env var when set', async () => {
    process.env.CORS_ORIGIN = 'https://example.com';
    const app = createApp();
    const res = await app.request('/', { method: 'OPTIONS', headers: { Origin: 'https://example.com' } });
    // OPTIONS request handled by cors middleware
    expect(res.status).toBe(204);
  });
});
