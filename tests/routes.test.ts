/**
 * 路由集成测试
 * 测试 chat/embed/model 三个核心路由的 HTTP 行为
 */
import { Hono } from 'hono';
import chatRouter from '../src/routes/chat';
import embedRouter from '../src/routes/embed';
import modelRouter from '../src/routes/model';

// Mock config
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
          { model: 'deepseek-chat', provider: 'deepseek' },
        ],
      },
    ],
    auth: { enabled: false, api_keys: [] },
    rate_limit: { enabled: false, qps: 1000, burst: 1000 },
    cost_control: { monthly_budget: 100, warn_threshold: 0.8 },
  })),
  getProviderConfig: jest.fn((name: string) => {
    if (name === 'openai') {
      return { provider: 'openai', base_url: 'https://api.openai.com/v1', api_key: 'sk-test' };
    }
    return undefined;
  }),
  getProviderForModel: jest.fn((model: string) => {
    const map: Record<string, string> = {
      'gpt-4o': 'openai',
      'gpt-4o-mini': 'openai',
      'deepseek-chat': 'deepseek',
    };
    return map[model];
  }),
  getRoutingStrategy: jest.fn(() => ({
    name: 'default',
    rules: [
      { model: 'gpt-4o', provider: 'openai' },
      { model: 'gpt-4o-mini', provider: 'openai' },
      { model: 'deepseek-chat', provider: 'deepseek' },
    ],
  })),
  resolveModelAlias: jest.fn((alias: string) => alias),
}));

// Mock providers
jest.mock('../src/providers', () => ({
  chatComplete: jest.fn().mockResolvedValue({
    id: 'chat-test-123',
    object: 'chat.completion',
    created: 1234567890,
    model: 'gpt-4o',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: 'Hello!' },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  }),
  chatCompleteStream: jest.fn().mockResolvedValue(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"test":"ok"}\n\n'));
        controller.close();
      },
    })
  ),
  createEmbedding: jest.fn().mockResolvedValue({
    object: 'list',
    data: [{ object: 'embedding', embedding: [0.1, 0.2, 0.3], index: 0 }],
    model: 'text-embedding-3-small',
    usage: { prompt_tokens: 5, total_tokens: 5 },
  }),
  registerProvider: jest.fn(),
  getProvider: jest.fn(),
  hasProvider: jest.fn(),
  getProviderNames: jest.fn(() => ['openai', 'deepseek']),
}));

describe('Routes Integration', () => {
  let app: Hono;

  beforeEach(() => {
    app = new Hono();
    app.route('/', chatRouter);
    app.route('/', embedRouter);
    app.route('/', modelRouter);
  });

  describe('GET /v1/models', () => {
    it('should return model list', async () => {
      const res = await app.request('/v1/models');
      expect(res.status).toBe(200);
      const body = await res.json() as { object: string; data: Array<{ id: string }> };
      expect(body.object).toBe('list');
      expect(body.data.length).toBeGreaterThan(0);
      expect(body.data.some((m) => m.id === 'gpt-4o')).toBe(true);
    });

    it('should deduplicate models', async () => {
      const res = await app.request('/v1/models');
      const body = await res.json() as { data: Array<{ id: string }> };
      const ids = body.data.map((m) => m.id);
      expect(new Set(ids).size).toBe(ids.length);
    });
  });

  describe('POST /v1/chat/completions', () => {
    it('should return 400 when model is missing', async () => {
      const res = await app.request('/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'Hi' }] }),
      });
      expect(res.status).toBe(400);
      const body = await res.json() as { error: { code: string } };
      expect(body.error.code).toBe('invalid_request');
    });

    it('should return 400 when messages is missing', async () => {
      const res = await app.request('/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-4o' }),
      });
      expect(res.status).toBe(400);
    });

    it('should return 400 for unknown model', async () => {
      const res = await app.request('/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'unknown-model',
          messages: [{ role: 'user', content: 'Hi' }],
        }),
      });
      expect(res.status).toBe(400);
      const body = await res.json() as { error: { code: string } };
      expect(body.error.code).toBe('unknown_model');
    });

    it('should handle valid non-streaming request', async () => {
      const res = await app.request('/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'gpt-4o',
          messages: [{ role: 'user', content: 'Hello' }],
        }),
      });
      expect(res.status).toBe(200);
      const body = await res.json() as { id: string; choices: Array<{ message: { content: string } }> };
      expect(body.id).toBe('chat-test-123');
      expect(body.choices[0].message.content).toBe('Hello!');
    });

    it('should handle streaming request', async () => {
      const res = await app.request('/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'gpt-4o',
          messages: [{ role: 'user', content: 'Stream test' }],
          stream: true,
        }),
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toBe('text/event-stream');
      const text = await res.text();
      expect(text).toContain('data:');
    });

    it('should reject empty messages array', async () => {
      const res = await app.request('/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-4o', messages: [] }),
      });
      expect(res.status).toBe(400);
    });
  });

  describe('POST /v1/embeddings', () => {
    it('should return 400 when model is missing', async () => {
      const res = await app.request('/v1/embeddings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: 'test text' }),
      });
      expect(res.status).toBe(400);
      const body = await res.json() as { error: { code: string } };
      expect(body.error.code).toBe('invalid_request');
    });

    it('should handle valid embedding request', async () => {
      const res = await app.request('/v1/embeddings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'text-embedding-3-small',
          input: 'Hello world',
        }),
      });
      expect(res.status).toBe(200);
      const body = await res.json() as { object: string; data: Array<unknown> };
      expect(body.object).toBe('list');
      expect(body.data).toHaveLength(1);
    });

    it('should handle array input', async () => {
      const res = await app.request('/v1/embeddings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'text-embedding-3-small',
          input: ['text1', 'text2'],
        }),
      });
      expect(res.status).toBe(200);
    });

    it('should reject empty input', async () => {
      const res = await app.request('/v1/embeddings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'text-embedding-3-small', input: '' }),
      });
      expect(res.status).toBe(400);
    });
  });

  describe('error handling', () => {
    it('should return 404 for unknown route', async () => {
      const res = await app.request('/v1/nonexistent');
      expect(res.status).toBe(404);
    });

    it('should return 400 for malformed JSON body', async () => {
      const res = await app.request('/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'not-json',
      });
      expect(res.status).toBe(400);
    });
  });
});
