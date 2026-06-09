/**
 * 路由认证隔离测试
 * 验证公共路由不受 auth 中间件影响，受保护路由需要认证
 */
import { createApp } from '../src/app';

// Mock config — 开启认证
jest.mock('../src/config', () => ({
  getConfig: jest.fn(() => ({
    port: 3000,
    host: '0.0.0.0',
    log_level: 'info',
    providers: {
      openai: { provider: 'openai', base_url: 'https://api.openai.com/v1', api_key: 'sk-test' },
    },
    routing: [
      {
        name: 'default',
        rules: [
          { model: 'gpt-4o', provider: 'openai' },
          { model: 'gpt-4o-mini', provider: 'openai' },
        ],
      },
    ],
    auth: { enabled: true, api_keys: [] },
    rate_limit: { enabled: false, qps: 1000, burst: 1000 },
    failure_threshold: 5,
    success_threshold: 2,
  })),
  getProviderConfig: jest.fn(() => undefined),
  getProviderForModel: jest.fn(() => undefined),
  getRoutingStrategy: jest.fn(() => ({
    name: 'default',
    rules: [{ model: 'gpt-4o', provider: 'openai' }],
  })),
  isModelPool: jest.fn(() => false),
  getModelPool: jest.fn(() => undefined),
}));

// Mock providers — 避免真正调用
jest.mock('../src/providers', () => ({
  getProviderNames: jest.fn(() => []),
  chatComplete: jest.fn(),
  chatCompleteStream: jest.fn(),
  createEmbedding: jest.fn(),
  setProviderDeps: jest.fn(),
  resetProviderDeps: jest.fn(),
}));

// Mock cache/session stats
jest.mock('../src/services/cache', () => ({
  getCacheStats: jest.fn(() => ({ size: 0, hit_rate: 0 })),
  initCache: jest.fn(),
}));

// Mock guardrail plugins
jest.mock('../src/plugins', () => ({
  processGuardrails: jest.fn(),
  processRequestPlugins: jest.fn(),
  processResponsePlugins: jest.fn(),
}));

describe('Public routes with auth enabled', () => {
  let app: ReturnType<typeof createApp>;

  beforeAll(() => {
    app = createApp();
  });

  it('GET /health 应不需要认证返回 200', async () => {
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    const body = await res.json() as { status: string };
    expect(body.status).toBe('ok');
  });

  it('GET / 应不需要认证返回 200', async () => {
    const res = await app.request('/');
    expect(res.status).toBe(200);
    const body = await res.json() as { name: string };
    expect(body.name).toBe('AI Gateway');
  });

  it('GET /metrics 应不需要认证返回 200', async () => {
    const res = await app.request('/metrics');
    expect(res.status).toBe(200);
  });
});

describe('Protected routes with auth enabled', () => {
  let app: ReturnType<typeof createApp>;

  beforeAll(() => {
    app = createApp();
  });

  it('GET /v1/models 无认证应返回 401', async () => {
    const res = await app.request('/v1/models');
    expect(res.status).toBe(401);
  });

  it('POST /v1/chat/completions 无认证应返回 401', async () => {
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4o' }),
    });
    expect(res.status).toBe(401);
  });

  it('POST /v1/embeddings 无认证应返回 401', async () => {
    const res = await app.request('/v1/embeddings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'text-embedding-3-small', input: 'test' }),
    });
    expect(res.status).toBe(401);
  });
});
