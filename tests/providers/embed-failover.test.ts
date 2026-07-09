/**
 * Embedding Failover Tests
 */
import { createEmbedding, resetProviderDeps, resetProviders, registerProvider } from '../../src/providers';
import type { IProvider, EmbeddingRequest, EmbeddingResponse } from '../../src/types';

jest.mock('../../src/config', () => {
  const actual = jest.requireActual('../../src/config');
  return {
    ...actual,
    getConfig: jest.fn(() => ({
      providers: {
        openai: { provider: 'openai', base_url: 'https://api.openai.com/v1', api_key: 'sk-test' },
        deepseek: { provider: 'deepseek', base_url: 'https://api.deepseek.com/v1', api_key: 'sk-test' },
      },
      model_equivalents: {},
      failover: { enabled: true, failureThreshold: 3, successThreshold: 2 },
      routing: { rules: [
        { model: 'text-embedding-ada-002', provider: 'openai' },
        { model: 'deepseek-embed', provider: 'deepseek' },
      ] },
    })),
    getProviderConfig: jest.fn((name: string) => ({
      openai: { provider: 'openai', base_url: 'https://api.openai.com/v1', api_key: 'sk-test' },
      deepseek: { provider: 'deepseek', base_url: 'https://api.deepseek.com/v1', api_key: 'sk-test' },
    }[name])),
    getProviderNames: jest.fn(() => ['openai', 'deepseek']),
    getRoutingStrategy: jest.fn(() => undefined),
    getModelPool: jest.fn(() => undefined),
    resolveModelAlias: jest.fn((m: string) => m),
    getProviderApiKeys: jest.fn(() => ['sk-test']),
  };
});

jest.mock('../../src/services/failover', () => ({
  failoverManager: {
    getHealthyKeys: jest.fn(() => ['sk-test']),
    getFailoverChain: jest.fn((provider: string) => provider === 'openai' ? ['deepseek'] : []),
    isProviderHealthy: jest.fn(() => true),
    recordProviderRequest: jest.fn(),
    recordSuccess: jest.fn(),
    recordFailure: jest.fn(),
  },
}));

jest.mock('../../src/services/loadbalancer', () => ({
  loadBalanceManager: {
    selectToken: jest.fn(() => ({ apiKey: 'sk-test' })),
  },
}));

jest.mock('../../src/services/retry', () => ({
  withRetry: jest.fn((fn: () => Promise<unknown>) => fn()),
  isRetryableError: jest.fn(() => false),
}));

describe('Embedding Failover', () => {
  beforeEach(() => {
    resetProviders();
    resetProviderDeps();
  });

  it('should failover to fallback provider when primary fails with retryable error', async () => {
    const openaiProvider: IProvider = {
      name: 'openai',
      capabilities: { chat: true, streaming: true, embed: true, vision: false, function_call: false, reasoning: false },
      chat: jest.fn(),
      chatStream: jest.fn(),
      embed: jest.fn().mockRejectedValue(Object.assign(new Error('Server error'), { status: 500 })),
    };

    const deepseekProvider: IProvider = {
      name: 'deepseek',
      capabilities: { chat: true, streaming: true, embed: true, vision: false, function_call: false, reasoning: false },
      chat: jest.fn(),
      chatStream: jest.fn(),
      embed: jest.fn().mockResolvedValue({
        object: 'list',
        data: [{ object: 'embedding', embedding: [0.1, 0.2], index: 0 }],
        model: 'deepseek-embed',
        usage: { prompt_tokens: 2, total_tokens: 2 },
      } as EmbeddingResponse),
    };

    registerProvider('openai', openaiProvider);
    registerProvider('deepseek', deepseekProvider);

    const request: EmbeddingRequest = {
      model: 'text-embedding-ada-002',
      input: 'hello',
    };

    const result = await createEmbedding('openai', request);
    expect(result.model).toBe('deepseek-embed');
    expect(openaiProvider.embed).toHaveBeenCalledTimes(1);
    expect(deepseekProvider.embed).toHaveBeenCalledTimes(1);
  });

  it('should throw on non-retryable errors without failover', async () => {
    const openaiProvider: IProvider = {
      name: 'openai',
      capabilities: { chat: true, streaming: true, embed: true, vision: false, function_call: false, reasoning: false },
      chat: jest.fn(),
      chatStream: jest.fn(),
      embed: jest.fn().mockRejectedValue(Object.assign(new Error('Bad request'), { status: 400 })),
    };

    registerProvider('openai', openaiProvider);

    const request: EmbeddingRequest = {
      model: 'text-embedding-ada-002',
      input: 'hello',
    };

    await expect(createEmbedding('openai', request)).rejects.toThrow('Bad request');
    expect(openaiProvider.embed).toHaveBeenCalledTimes(1);
  });

  it('should throw when all providers fail', async () => {
    const openaiProvider: IProvider = {
      name: 'openai',
      capabilities: { chat: true, streaming: true, embed: true, vision: false, function_call: false, reasoning: false },
      chat: jest.fn(),
      chatStream: jest.fn(),
      embed: jest.fn().mockRejectedValue(Object.assign(new Error('OpenAI down'), { status: 503 })),
    };

    const deepseekProvider: IProvider = {
      name: 'deepseek',
      capabilities: { chat: true, streaming: true, embed: true, vision: false, function_call: false, reasoning: false },
      chat: jest.fn(),
      chatStream: jest.fn(),
      embed: jest.fn().mockRejectedValue(Object.assign(new Error('DeepSeek down'), { status: 503 })),
    };

    registerProvider('openai', openaiProvider);
    registerProvider('deepseek', deepseekProvider);

    const request: EmbeddingRequest = {
      model: 'text-embedding-ada-002',
      input: 'hello',
    };

    await expect(createEmbedding('openai', request)).rejects.toThrow('All providers failed');
  });
});
