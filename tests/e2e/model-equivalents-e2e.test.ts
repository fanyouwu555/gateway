/**
 * Model Equivalents E2E Tests
 * 验证完整 HTTP 请求链路下模型名自动重映�? */
import { createApp } from '../../src/app';
import type { Hono } from 'hono';
import { registerProvider, resetProviders, resetProviderDeps } from '../../src/providers';
import { resetCache } from '../../src/services/cache';
import { resetMetricsStore } from '../../src/services/metrics';
import { resetRateLimitStore } from '../../src/middleware/ratelimit';
import { failoverManager } from '../../src/services/failover';
import { resetWebSocketConnections } from '../../src/middleware/websocket';
import { resetTenantStore } from '../../src/services/tenant';

jest.mock('../../src/utils', () => {
  const actual = jest.requireActual('../../src/utils');
  return {
    ...actual,
    verifyApiKey: (plaintext: string, hashed: string) => plaintext === hashed,
    ensureKeyHashed: (key: string) => key,
  };
});

jest.mock('../../src/config', () => ({
  getConfig: () => ({
    port: 3000,
    host: '0.0.0.0',
    log_level: 'info',
    providers: {
      openai: { provider: 'openai', base_url: 'https://api.openai.com/v1', api_key: 'sk-openai' },
      deepseek: { provider: 'deepseek', base_url: 'https://api.deepseek.com/v1', api_key: 'sk-deepseek' },
      anthropic: { provider: 'anthropic', base_url: 'https://api.anthropic.com', api_key: 'sk-anthropic' },
      mistral: { provider: 'mistral', base_url: 'https://api.mistral.ai/v1', api_key: 'sk-mistral' },
    },
    routing: [
      {
        name: 'default',
        rules: [
          { model: 'gpt-4o', provider: 'openai' },
          { model: 'deepseek-chat', provider: 'deepseek' },
          { model: 'claude-3-5-sonnet-20241022', provider: 'anthropic' },
        ],
        fallback: 'deepseek',
      },
    ],
    auth: {
      enabled: true,
      api_keys: [
        { key: 'gateway-test-key-123', tenant_id: 'default', name: 'test', created_at: Date.now() },
        { key: 'admin-dashboard-key-456', tenant_id: 'admin', name: 'admin', created_at: Date.now(), is_admin: true },
      ],
    },
    rate_limit: { enabled: true, qps: 100, burst: 200 },
    failover: {
      enabled: true,
      failureThreshold: 1,
      successThreshold: 1,
      healthCheckInterval: 60000,
      healthCheckTimeout: 5000,
      healthCheckModel: 'gpt-4o-mini',
      chains: { openai: ['deepseek', 'anthropic'] },
      errorRateThreshold: 0.5,
      latencyThresholdMs: 30000,
    },
    loadBalance: { strategy: 'roundRobin', providers: {} },
    cache: { enabled: true, ttl: 3600000, max_size: 1000 },
    rate_limit_clean_interval: 60000,
    pricing: {},
    default_model: 'gpt-4o-mini',
    model_equivalents: {
      'gpt-4o': {
        deepseek: 'deepseek-chat',
        anthropic: 'claude-3-5-sonnet-20241022',
      },
      'gpt-4o-mini': {
        deepseek: 'deepseek-chat',
        anthropic: 'claude-3-haiku-20240307',
      },
    },
  }),
  getProviderConfig: (name: string) => {
    const configs: Record<string, { provider: string; base_url: string; api_key: string }> = {
      openai: { provider: 'openai', base_url: 'https://api.openai.com/v1', api_key: 'sk-openai' },
      deepseek: { provider: 'deepseek', base_url: 'https://api.deepseek.com/v1', api_key: 'sk-deepseek' },
      anthropic: { provider: 'anthropic', base_url: 'https://api.anthropic.com', api_key: 'sk-anthropic' },
      mistral: { provider: 'mistral', base_url: 'https://api.mistral.ai/v1', api_key: 'sk-mistral' },
    };
    return configs[name];
  },
  getProviderForModel: (model: string) => {
    const map: Record<string, string> = { 'gpt-4o': 'openai', 'deepseek-chat': 'deepseek', 'claude-3-5-sonnet-20241022': 'anthropic' };
    return map[model];
  },
  getRoutingStrategy: () => ({
    name: 'default',
    rules: [
      { model: 'gpt-4o', provider: 'openai' },
      { model: 'deepseek-chat', provider: 'deepseek' },
      { model: 'claude-3-5-sonnet-20241022', provider: 'anthropic' },
    ],
    fallback: 'deepseek',
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
  capabilities: { chat: true, embed: false, streaming: false, vision: false, function_call: false, reasoning: false },
  chat: jest.fn(),
  chatStream: jest.fn(),
  embed: jest.fn(),
};

const mockDeepSeek = {
  name: 'deepseek',
  capabilities: { chat: true, embed: false, streaming: false, vision: false, function_call: false, reasoning: false },
  chat: jest.fn(),
  chatStream: jest.fn(),
  embed: jest.fn(),
};

const mockAnthropic = {
  name: 'anthropic',
  capabilities: { chat: true, embed: false, streaming: false, vision: false, function_call: false, reasoning: false },
  chat: jest.fn(),
  chatStream: jest.fn(),
  embed: jest.fn(),
};

const userHeaders = {
  'Content-Type': 'application/json',
  Authorization: 'Bearer gateway-test-key-123',
};

describe('Model Equivalents E2E', () => {
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
    registerProvider('deepseek', mockDeepSeek);
    registerProvider('anthropic', mockAnthropic);

    app = createApp();

    jest.clearAllMocks();
  });

  // ============================================================
  // 1. 正常请求路径（无 failover）�?模型名不�?  // ============================================================
  describe('Normal path (no failover)', () => {
    it('should NOT remap model for primary provider on success', async () => {
      mockOpenAI.chat.mockImplementation(async (req: { model: string }) => ({
        id: 'oa-1',
        object: 'chat.completion',
        created: 1,
        model: req.model,
        choices: [{ index: 0, message: { role: 'assistant', content: 'Hello from OpenAI' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }));

      const res = await app.request('/v1/chat/completions', {
        method: 'POST',
        headers: userHeaders,
        body: JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: 'Hi' }] }),
      });

      expect(res.status).toBe(200);
      // Primary provider receives original model name
      expect(mockOpenAI.chat.mock.calls[0][0].model).toBe('gpt-4o');
    });
  });

  // ============================================================
  // 2. Failover 路径 �?模型�?remap
  // ============================================================
  describe('Failover with model_equivalents', () => {
    it('should remap model when failing over to deepseek', async () => {
      mockOpenAI.chat.mockRejectedValue(new Error('OpenAI down'));
      mockDeepSeek.chat.mockImplementation(async (req: { model: string }) => ({
        id: 'ds-1',
        object: 'chat.completion',
        created: 1,
        model: req.model,
        choices: [{ index: 0, message: { role: 'assistant', content: 'Hello from DeepSeek' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }));

      const res = await app.request('/v1/chat/completions', {
        method: 'POST',
        headers: userHeaders,
        body: JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: 'Hi' }] }),
      });

      expect(res.status).toBe(200);
      // Verify DeepSeek received the remapped model name
      const deepseekArgs = mockDeepSeek.chat.mock.calls[0][0];
      expect(deepseekArgs.model).toBe('deepseek-chat');
    });

    it('should remap model through multi-level failover chain', async () => {
      mockOpenAI.chat.mockRejectedValue(new Error('OpenAI down'));
      mockDeepSeek.chat.mockRejectedValue(new Error('DeepSeek down'));
      mockAnthropic.chat.mockImplementation(async (req: { model: string }) => ({
        id: 'an-1',
        object: 'chat.completion',
        created: 1,
        model: req.model,
        choices: [{ index: 0, message: { role: 'assistant', content: 'Hello from Anthropic' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }));

      const res = await app.request('/v1/chat/completions', {
        method: 'POST',
        headers: userHeaders,
        body: JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: 'Hi' }] }),
      });

      expect(res.status).toBe(200);
      // DeepSeek got remapped
      expect(mockDeepSeek.chat.mock.calls[0][0].model).toBe('deepseek-chat');
      // Anthropic got its own remapping
      expect(mockAnthropic.chat.mock.calls[0][0].model).toBe('claude-3-5-sonnet-20241022');
    });
  });

  // ============================================================
  // 3. �?model_equivalent 时的兜底行为
  // ============================================================
  describe('No equivalent configured', () => {
    it('should keep original model when no equivalent for fallback provider', async () => {
      // Add a 4th provider with no model_equivalent mapping
      const mockMistral = {
        name: 'mistral',
        capabilities: { chat: true, embed: false, streaming: false, vision: false, function_call: false, reasoning: false },
        chat: jest.fn().mockImplementation(async (req: { model: string }) => ({
          id: 'ms-1',
          object: 'chat.completion',
          created: 1,
          model: req.model,
          choices: [{ index: 0, message: { role: 'assistant', content: 'Hello from Mistral' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        })),
        chatStream: jest.fn(),
        embed: jest.fn(),
      };
      registerProvider('mistral', mockMistral);

      // Override the failover chain to include mistral (which has no equivalent)
      failoverManager['config'].chains = { openai: ['mistral'] };

      mockOpenAI.chat.mockRejectedValue(new Error('OpenAI down'));

      const res = await app.request('/v1/chat/completions', {
        method: 'POST',
        headers: userHeaders,
        body: JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: 'Hi' }] }),
      });

      expect(res.status).toBe(200);
      // No equivalent for openai→mistral, so model name stays as-is
      expect(mockMistral.chat.mock.calls[0][0].model).toBe('gpt-4o');
    });
  });

  // ============================================================
  // 4. 所�?Provider 全面崩溃
  // ============================================================
  describe('All providers fail', () => {
    it('should return 500 when all providers in chain fail', async () => {
      mockOpenAI.chat.mockRejectedValue(new Error('OpenAI down'));
      mockDeepSeek.chat.mockRejectedValue(new Error('DeepSeek down'));
      mockAnthropic.chat.mockRejectedValue(new Error('Anthropic down'));

      const res = await app.request('/v1/chat/completions', {
        method: 'POST',
        headers: userHeaders,
        body: JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: 'Hi' }] }),
      });

      expect(res.status).toBe(500);
      const body = await res.json() as { error?: { message?: string } };
      expect(body.error).toBeDefined();
    });
  });
});