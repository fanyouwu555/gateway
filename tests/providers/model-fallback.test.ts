/**
 * Model-level Fallback Tests
 * When primary model returns 429/503, try fallback models on same provider
 */
import { chatComplete, resetProviderDeps, resetProviders, registerProvider } from '../../src/providers';
import type { IProvider, ChatCompletionRequest, ChatCompletionResponse } from '../../src/types';

jest.mock('../../src/config', () => {
  const actual = jest.requireActual('../../src/config');
  return {
    ...actual,
    getConfig: jest.fn(() => ({
      providers: {
        openai: { provider: 'openai', base_url: 'https://api.openai.com/v1', api_key: 'sk-test' },
      },
      model_fallbacks: {
        'gpt-4o': ['gpt-4o-mini', 'gpt-3.5-turbo'],
      },
      model_equivalents: {},
      failover: { enabled: true, failureThreshold: 3, successThreshold: 2 },
      routing: { rules: [{ model: 'gpt-4o', provider: 'openai' }] },
    })),
    getProviderConfig: jest.fn((name: string) => ({
      openai: { provider: 'openai', base_url: 'https://api.openai.com/v1', api_key: 'sk-test' },
    }[name])),
    getProviderForModel: jest.fn(() => 'openai'),
    getProviderNames: jest.fn(() => ['openai']),
    getRoutingStrategy: jest.fn(() => undefined),
    getModelPool: jest.fn(() => undefined),
    resolveModelAlias: jest.fn((m: string) => m),
  };
});

jest.mock('../../src/services/failover', () => ({
  failoverManager: {
    getHealthyKeys: jest.fn(() => ['sk-test']),
    getFailoverChain: jest.fn(() => []),
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

describe('Model-level Fallback', () => {
  beforeEach(() => {
    resetProviders();
    resetProviderDeps();
  });

  it('should fallback to next model when primary returns 429', async () => {
    const mockProvider: IProvider = {
      name: 'openai',
      capabilities: { chat: true, streaming: true, embed: false, vision: false, function_call: false, reasoning: false },
      chat: jest.fn()
        .mockRejectedValueOnce(Object.assign(new Error('Rate limit exceeded'), { status: 429 }))
        .mockResolvedValueOnce({
          id: 'chatcmpl-123',
          object: 'chat.completion',
          created: Date.now(),
          model: 'gpt-4o-mini',
          choices: [{ index: 0, message: { role: 'assistant', content: 'Hello from fallback' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        } as ChatCompletionResponse),
      chatStream: jest.fn(),
      embed: jest.fn(),
    };

    registerProvider('openai', mockProvider);

    const request: ChatCompletionRequest = {
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'Hello' }],
    };

    const result = await chatComplete('openai', request);

    expect(result.model).toBe('gpt-4o-mini');
    expect(mockProvider.chat).toHaveBeenCalledTimes(2);
    const chatMock = mockProvider.chat as jest.Mock;
    expect(chatMock.mock.calls[0][0].model).toBe('gpt-4o');
    expect(chatMock.mock.calls[1][0].model).toBe('gpt-4o-mini');
  });

  it('should try all fallback models before giving up', async () => {
    const mockProvider: IProvider = {
      name: 'openai',
      capabilities: { chat: true, streaming: true, embed: false, vision: false, function_call: false, reasoning: false },
      chat: jest.fn().mockRejectedValue(Object.assign(new Error('Rate limit'), { status: 429 })),
      chatStream: jest.fn(),
      embed: jest.fn(),
    };

    registerProvider('openai', mockProvider);

    const request: ChatCompletionRequest = {
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'Hello' }],
    };

    await expect(chatComplete('openai', request)).rejects.toThrow('All providers failed');
    // withRetry will attempt each model multiple times (3 retries)
    expect(mockProvider.chat).toHaveBeenCalled();
  });

  it('should not fallback on non-retryable errors (like 400)', async () => {
    const mockProvider: IProvider = {
      name: 'openai',
      capabilities: { chat: true, streaming: true, embed: false, vision: false, function_call: false, reasoning: false },
      chat: jest.fn().mockRejectedValue(Object.assign(new Error('Bad request'), { status: 400 })),
      chatStream: jest.fn(),
      embed: jest.fn(),
    };

    registerProvider('openai', mockProvider);

    const request: ChatCompletionRequest = {
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'Hello' }],
    };

    await expect(chatComplete('openai', request)).rejects.toThrow('Bad request');
    expect(mockProvider.chat).toHaveBeenCalledTimes(1);
  });
});
