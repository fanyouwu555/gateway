/**
 * Chat Route Tests
 */
import { createApp } from '../../src/app';

jest.mock('../../src/config', () => ({
  getConfig: jest.fn(() => ({
    port: 3000,
    host: '0.0.0.0',
    log_level: 'info',
    providers: {
      openai: { provider: 'openai', base_url: 'https://api.openai.com/v1', api_key: 'sk-test' },
    },
    routing: [{ name: 'default', rules: [{ model: 'gpt-4o', provider: 'openai' }] }],
    auth: {
      enabled: true,
      api_keys: [
        {
          key: 'test-api-key-123',
          tenant_id: 'default',
          name: 'Test Key',
          created_at: Date.now(),
        },
        {
          key: 'test-api-key-with-default-model',
          tenant_id: 'default',
          name: 'Test Key With Default Model',
          created_at: Date.now(),
          default_model: 'custom-default-model',
        },
      ],
    },
    rate_limit: { enabled: false, qps: 1000, burst: 1000 },
    cache: { enabled: false, ttl: 60000, max_size: 1000 },
    model_aliases: { fast: 'gpt-4o-mini' },
    model_pools: {},
  })),
  getProviderConfig: jest.fn(() => ({ provider: 'openai', base_url: 'https://api.openai.com/v1', api_key: 'sk-test' })),
  getProviderForModel: jest.fn(() => 'openai'),
  getRoutingStrategy: jest.fn(() => ({ name: 'default', rules: [{ model: 'gpt-4o', provider: 'openai' }] })),
  resolveModelAlias: jest.fn((alias: string) => {
    const aliases: Record<string, string> = { fast: 'gpt-4o-mini' };
    return aliases[alias] || alias;
  }),
  isModelPool: jest.fn(() => false),
  getModelPool: jest.fn(() => undefined),
}));

jest.mock('../../src/providers', () => ({
  chatComplete: jest.fn(() => Promise.resolve({
    id: 'resp-1',
    object: 'chat.completion',
    created: Date.now(),
    model: 'gpt-4o',
    choices: [{ index: 0, message: { role: 'assistant', content: 'Hello' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  })),
  chatCompleteStream: jest.fn(() => Promise.resolve(new ReadableStream())),
}));

jest.mock('../../src/services/prompt', () => ({
  templateToMessages: jest.fn((id: string) => {
    if (id === 'translate') {
      return [{ role: 'user', content: 'Translate to Japanese: Hello' }];
    }
    return null;
  }),
}));

jest.mock('../../src/services/cache', () => ({
  getCache: jest.fn(() => Promise.resolve(null)),
  setCache: jest.fn(() => Promise.resolve()),
}));

jest.mock('../../src/services/semantic-cache', () => ({
  getSemanticCache: jest.fn(() => null),
  initSemanticCache: jest.fn(),
}));

jest.mock('../../src/plugins', () => ({
  runGuardrailPlugins: jest.fn(() => Promise.resolve({ allowed: true })),
  runRequestPlugins: jest.fn((_c, req) => Promise.resolve(req)),
  runResponsePlugins: jest.fn((_c, res) => Promise.resolve(res)),
  runTransformPlugins: jest.fn((_c, req) => Promise.resolve(req)),
}));

jest.mock('../../src/services/router', () => ({
  smartRoute: jest.fn(() => ({ provider: 'openai', reason: 'default' })),
  evaluateConditionalRules: jest.fn(() => null),
  recordLatency: jest.fn(),
  recordError: jest.fn(),
}));

jest.mock('../../src/utils', () => ({
  ...jest.requireActual('../../src/utils'),
  verifyApiKey: jest.fn((apiKey: string, hashed: string) => apiKey === hashed),
}));

describe('Chat Routes', () => {
  let app: ReturnType<typeof createApp>;

  beforeAll(() => {
    app = createApp();
  });

  const authHeader = { Authorization: 'Bearer test-api-key-123' };

  it('POST /v1/chat/completions with template_id should render and complete', async () => {
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { ...authHeader, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4o',
        template_id: 'translate',
        template_variables: { target_language: 'Japanese', content: 'Hello' },
      }),
    });
    expect(res.status).toBe(200);
  });

  it('POST /v1/chat/completions with unknown template_id should return 400', async () => {
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { ...authHeader, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4o',
        template_id: 'unknown-template',
      }),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe('unknown_template');
  });

  it('POST /v1/chat/completions without messages or template_id should return 400', async () => {
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { ...authHeader, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4o' }),
    });
    expect(res.status).toBe(400);
  });

  it('POST /v1/chat/completions should resolve model alias', async () => {
    const { chatComplete } = require('../../src/providers');
    chatComplete.mockClear();

    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { ...authHeader, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'fast',
        messages: [{ role: 'user', content: 'Hello' }],
      }),
    });
    expect(res.status).toBe(200);
    expect(chatComplete).toHaveBeenCalled();
    // 第一个参数是 provider 名，第二个参数是请求体
    const call = chatComplete.mock.calls[0];
    expect(call[1].model).toBe('gpt-4o-mini');
  });

  // ============================================================
  // 默认模型 fallback 测试
  // ============================================================

  it('should fallback to routing rule model when API key has no default_model and request omits model', async () => {
    const { chatComplete } = require('../../src/providers');
    chatComplete.mockClear();

    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: 'Bearer test-api-key-123', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'Hello' }],
      }),
    });
    expect(res.status).toBe(200);
    expect(chatComplete).toHaveBeenCalled();
    const call = chatComplete.mock.calls[0];
    expect(call[1].model).toBe('gpt-4o');
  });

  it('should use API key default_model when request omits model', async () => {
    const { chatComplete } = require('../../src/providers');
    chatComplete.mockClear();

    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: 'Bearer test-api-key-with-default-model', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'Hello' }],
      }),
    });
    expect(res.status).toBe(200);
    expect(chatComplete).toHaveBeenCalled();
    const call = chatComplete.mock.calls[0];
    expect(call[1].model).toBe('custom-default-model');
  });

  it('should use request model over API key default_model when both present', async () => {
    const { chatComplete } = require('../../src/providers');
    chatComplete.mockClear();

    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: 'Bearer test-api-key-with-default-model', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'Hello' }],
      }),
    });
    expect(res.status).toBe(200);
    expect(chatComplete).toHaveBeenCalled();
    const call = chatComplete.mock.calls[0];
    expect(call[1].model).toBe('gpt-4o');
  });
});
