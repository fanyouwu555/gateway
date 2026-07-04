/**
 * Embeddings 路由测试
 */
import { Hono } from 'hono';
import embedRouter from '../../src/routes/embed';

jest.mock('../../src/config', () => ({
  getConfig: () => ({
    providers: {},
    routing: [],
    model_pools: {},
    model_capabilities: {},
    auth: { enabled: false },
    request_logging: { enabled: false },
  }),
  getProviderForModel: jest.fn(),
  resolveModelAlias: (m: string) => m,
}));

jest.mock('../../src/providers', () => ({
  getProvider: jest.fn(),
  createEmbedding: jest.fn(),
  resetProviders: jest.fn(),
}));

jest.mock('../../src/services/quota', () => ({
  checkQuota: jest.fn(),
  checkKeyQuota: jest.fn(),
  recordUsage: jest.fn(),
}));

jest.mock('../../src/services/pricing', () => ({
  getPricingService: () => ({
    calculateCost: jest.fn().mockReturnValue(0.001),
  }),
}));

jest.mock('../../src/services/token-ratelimit', () => ({
  getTokenRateLimit: jest.fn().mockReturnValue(null),
}));

describe('Embeddings Router', () => {
  let app: Hono;

  beforeEach(() => {
    app = new Hono();
    app.use('*', async (c, next) => {
      c.set('tenant_id', 't1');
      c.set('request_id', 'req-test');
      await next();
    });
    app.route('/', embedRouter);
  });

  it('should return 400 for invalid request body', async () => {
    const res = await app.request('/v1/embeddings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe('invalid_request');
  });

  it('should return 400 when no provider configured for model', async () => {
    const { getProviderForModel } = require('../../src/config');
    (getProviderForModel as jest.Mock).mockReturnValue(null);

    const res = await app.request('/v1/embeddings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'unknown-model', input: 'hello' }),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe('model_not_found');
  });

  it('should return 400 when provider does not support embeddings', async () => {
    const { getProviderForModel } = require('../../src/config');
    const { getProvider } = require('../../src/providers');
    (getProviderForModel as jest.Mock).mockReturnValue('openai');
    (getProvider as jest.Mock).mockReturnValue({
      name: 'openai',
      capabilities: { embed: false, chat: true },
    });

    const res = await app.request('/v1/embeddings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4o', input: 'hello' }),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe('capability_mismatch');
  });

  it('should return 429 when tenant quota exceeded', async () => {
    const { getProviderForModel } = require('../../src/config');
    const { getProvider } = require('../../src/providers');
    const { checkQuota } = require('../../src/services/quota');
    (getProviderForModel as jest.Mock).mockReturnValue('openai');
    (getProvider as jest.Mock).mockReturnValue({
      name: 'openai',
      capabilities: { embed: true },
    });
    (checkQuota as jest.Mock).mockReturnValue({ allowed: false, reason: 'quota exceeded' });

    const res = await app.request('/v1/embeddings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-tenant-id': 't1' },
      body: JSON.stringify({ model: 'text-embedding-ada-002', input: 'hello' }),
    });
    expect(res.status).toBe(429);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe('quota_exceeded');
  });
});
