/**
 * OpenCode 集成测试
 * 模拟 OpenCode 客户端调用网关的完整流程
 * 覆盖：模型列表获取、chat completions（带/不带 model）、streaming
 */
import { createApp } from '../src/app';
import type { Hono } from 'hono';
import { registerProvider, resetProviders, resetProviderDeps } from '../src/providers';
import { resetCache } from '../src/services/cache';
import { resetMetricsStore } from '../src/services/metrics';
import { resetRateLimitStore } from '../src/middleware/ratelimit';
import { failoverManager } from '../src/services/failover';
import { resetWebSocketConnections } from '../src/middleware/websocket';
import { resetTenantStore } from '../src/services/tenant';

// Mock utils to bypass scrypt hashing in tests (plaintext key == stored key)
jest.mock('../src/utils', () => {
  const actual = jest.requireActual('../src/utils');
  return {
    ...actual,
    verifyApiKey: (plaintext: string, hashed: string) => plaintext === hashed,
    ensureKeyHashed: (key: string) => key,
    hashApiKey: (key: string) => key,
  };
});

// Mock config with test settings
jest.mock('../src/config', () => ({
  getConfig: () => ({
    port: 3000,
    host: '0.0.0.0',
    log_level: 'info',
    providers: {
      openai: { provider: 'openai', base_url: 'https://api.openai.com/v1', api_key: 'sk-openai' },
    },
    routing: [
      {
        name: 'default',
        rules: [
          { model: 'gpt-4o', provider: 'openai' },
          { model: 'gpt-4o-mini', provider: 'openai' },
        ],
        fallback: 'openai',
      },
    ],
    auth: {
      enabled: true,
      api_keys: [
        {
          key: 'gateway-test-key-123',
          tenant_id: 'default',
          name: 'test',
          created_at: Date.now(),
        },
        {
          key: 'gateway-test-key-with-default',
          tenant_id: 'default',
          name: 'test-with-default',
          created_at: Date.now(),
          default_model: 'gpt-4o-mini',
          allowed_models: ['gpt-4o-mini'],
        },
      ],
    },
    rate_limit: { enabled: false, qps: 1000, burst: 1000 },
    failover: {
      enabled: false,
      failureThreshold: 1,
      successThreshold: 1,
      healthCheckInterval: 60000,
      healthCheckTimeout: 5000,
      healthCheckModel: 'gpt-4o-mini',
      chains: {},
      errorRateThreshold: 0.5,
      latencyThresholdMs: 30000,
    },
    loadBalance: { strategy: 'roundRobin', providers: {} },
    cache: { enabled: true, ttl: 3600000, max_size: 1000 },
    rate_limit_clean_interval: 60000,
    pricing: {
      'gpt-4o': { input: 2.5, output: 10.0 },
      'gpt-4o-mini': { input: 0.15, output: 0.6 },
    },
    default_model: 'gpt-4o-mini',
    model_aliases: {},
    model_equivalents: {},
  }),
  getProviderConfig: (name: string) => {
    const configs: Record<string, { provider: string; base_url: string; api_key: string }> = {
      openai: { provider: 'openai', base_url: 'https://api.openai.com/v1', api_key: 'sk-openai' },
    };
    return configs[name];
  },
  getProviderForModel: (model: string) => {
    const map: Record<string, string> = { 'gpt-4o': 'openai', 'gpt-4o-mini': 'openai' };
    return map[model];
  },
  getRoutingStrategy: () => ({
    name: 'default',
    rules: [
      { model: 'gpt-4o', provider: 'openai' },
      { model: 'gpt-4o-mini', provider: 'openai' },
    ],
    fallback: 'openai',
  }),
  resolveModelAlias: jest.fn((alias: string) => alias),
  getProviderApiKeys: (config: { api_key?: string; api_keys?: string[] }) => {
    if (config.api_keys && config.api_keys.length > 0) return config.api_keys;
    if (config.api_key) return [config.api_key];
    return [];
  },
  isModelPool: jest.fn(() => false),
  getModelPool: jest.fn(() => undefined),
}));

const mockOpenAI = {
  name: 'openai',
  capabilities: { chat: true, embed: false, streaming: true, vision: false, function_call: false },
  chat: jest.fn(),
  chatStream: jest.fn(),
  embed: jest.fn(),
};

describe('OpenCode Integration Tests', () => {
  let app: Hono;

  beforeEach(() => {
    resetProviders();
    resetProviderDeps();
    resetCache();
    resetMetricsStore();
    resetRateLimitStore();
    failoverManager.reset();
    resetWebSocketConnections();
    resetTenantStore();

    registerProvider('openai', mockOpenAI);

    app = createApp();

    jest.clearAllMocks();
  });

  // ============================================================
  // 1. 模拟 OpenCode 获取模型列表
  // ============================================================
  describe('GET /v1/models (OpenCode model discovery)', () => {
    it('should return all models for key without allowed_models restriction', async () => {
      const res = await app.request('/v1/models', {
        headers: { Authorization: 'Bearer gateway-test-key-123' },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: Array<{ id: string }>; default_model?: string };
      expect(body.data).toHaveLength(2);
      expect(body.data.map((m) => m.id)).toContain('gpt-4o');
      expect(body.data.map((m) => m.id)).toContain('gpt-4o-mini');
      expect(body.default_model).toBeUndefined();
    });

    it('should return only allowed models + default_model for restricted key', async () => {
      const res = await app.request('/v1/models', {
        headers: { Authorization: 'Bearer gateway-test-key-with-default' },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: Array<{ id: string }>; default_model?: string };
      expect(body.data).toHaveLength(1);
      expect(body.data[0].id).toBe('gpt-4o-mini');
      expect(body.default_model).toBe('gpt-4o-mini');
    });
  });

  // ============================================================
  // 2. 模拟 OpenCode 发�?chat completion（非流式�?  // ============================================================
  describe('POST /v1/chat/completions (OpenCode chat)', () => {
    it('should work with explicit model (OpenCode sends model)', async () => {
      mockOpenAI.chat.mockResolvedValue({
        id: 'test-1',
        object: 'chat.completion',
        created: 1,
        model: 'gpt-4o',
        choices: [
          { index: 0, message: { role: 'assistant', content: 'Hello from OpenCode' }, finish_reason: 'stop' },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      });

      const res = await app.request('/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer gateway-test-key-123',
        },
        body: JSON.stringify({
          model: 'gpt-4o',
          messages: [{ role: 'user', content: 'Hello' }],
        }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { choices: Array<{ message: { content: string } }> };
      expect(body.choices[0].message.content).toBe('Hello from OpenCode');
      expect(mockOpenAI.chat).toHaveBeenCalledTimes(1);
    });

    it('should fallback to default_model when request omits model (OpenCode without model)', async () => {
      mockOpenAI.chat.mockResolvedValue({
        id: 'test-2',
        object: 'chat.completion',
        created: 1,
        model: 'gpt-4o-mini',
        choices: [
          { index: 0, message: { role: 'assistant', content: 'Default model response' }, finish_reason: 'stop' },
        ],
        usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
      });

      const res = await app.request('/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer gateway-test-key-with-default',
        },
        body: JSON.stringify({
          messages: [{ role: 'user', content: 'Hello without model' }],
        }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { choices: Array<{ message: { content: string } }>; model: string };
      expect(body.choices[0].message.content).toBe('Default model response');
      expect(body.model).toBe('gpt-4o-mini');
    });

    it('should use key default_model over routing fallback when no model in request', async () => {
      mockOpenAI.chat.mockResolvedValue({
        id: 'test-3',
        object: 'chat.completion',
        created: 1,
        model: 'gpt-4o-mini',
        choices: [
          { index: 0, message: { role: 'assistant', content: 'Key default model' }, finish_reason: 'stop' },
        ],
        usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
      });

      const res = await app.request('/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer gateway-test-key-with-default',
        },
        body: JSON.stringify({
          messages: [{ role: 'user', content: 'Test key default' }],
        }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { model: string };
      expect(body.model).toBe('gpt-4o-mini');
    });

    it('should reject model not in allowed_models with 403', async () => {
      const res = await app.request('/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer gateway-test-key-with-default',
        },
        body: JSON.stringify({
          model: 'gpt-4o',
          messages: [{ role: 'user', content: 'Hello' }],
        }),
      });

      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('model_not_allowed');
    });
  });

  // ============================================================
  // 3. 模拟 OpenCode 发�?streaming chat completion
  // ============================================================
  describe('POST /v1/chat/completions with stream=true (OpenCode streaming)', () => {
    it('should return SSE stream for streaming request', async () => {
      const encoder = new TextEncoder();
      const chunks = [
        'data: {"id":"1","object":"chat.completion.chunk","created":1,"model":"gpt-4o","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}\n\n',
        'data: {"id":"1","object":"chat.completion.chunk","created":1,"model":"gpt-4o","choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}\n\n',
        'data: {"id":"1","object":"chat.completion.chunk","created":1,"model":"gpt-4o","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
        'data: [DONE]\n\n',
      ];

      let chunkIndex = 0;
      const stream = new ReadableStream({
        pull(controller) {
          if (chunkIndex < chunks.length) {
            controller.enqueue(encoder.encode(chunks[chunkIndex]));
            chunkIndex++;
          } else {
            controller.close();
          }
        },
      });

      mockOpenAI.chatStream.mockResolvedValue(stream);

      const res = await app.request('/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer gateway-test-key-123',
        },
        body: JSON.stringify({
          model: 'gpt-4o',
          messages: [{ role: 'user', content: 'Hello' }],
          stream: true,
        }),
      });

      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/event-stream');
    });
  });

  // ============================================================
  // 4. 模拟 OpenCode 无认证请�?  // ============================================================
  describe('Authentication', () => {
    it('should return 401 when no API key provided', async () => {
      const res = await app.request('/v1/models');
      expect(res.status).toBe(401);
    });

    it('should return 401 for chat without API key', async () => {
      const res = await app.request('/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'gpt-4o',
          messages: [{ role: 'user', content: 'Hello' }],
        }),
      });
      expect(res.status).toBe(401);
    });
  });
});
