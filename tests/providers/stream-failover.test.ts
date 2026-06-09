/**
 * Stream Connection-level Failover Tests
 * When primary provider stream connection fails, try fallback providers
 */
import { chatCompleteStream, resetProviders, registerProvider, resetProviderDeps } from '../../src/providers';
import type { IProvider, ChatCompletionRequest } from '../../src/types';

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
        { model: 'gpt-4o', provider: 'openai' },
        { model: 'deepseek-chat', provider: 'deepseek' },
      ] },
    })),
    getProviderConfig: jest.fn((name: string) => ({
      openai: { provider: 'openai', base_url: 'https://api.openai.com/v1', api_key: 'sk-test' },
      deepseek: { provider: 'deepseek', base_url: 'https://api.deepseek.com/v1', api_key: 'sk-test' },
    }[name])),
    getProviderForModel: jest.fn((model: string) => model === 'gpt-4o' ? 'openai' : 'deepseek'),
    getProviderNames: jest.fn(() => ['openai', 'deepseek']),
    getRoutingStrategy: jest.fn(() => undefined),
    getModelPool: jest.fn(() => undefined),
    resolveModelAlias: jest.fn((m: string) => m),
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

describe('Stream Failover', () => {
  beforeEach(() => {
    resetProviders();
    resetProviderDeps();
  });

  it('should failover to fallback provider when primary stream connection fails', async () => {
    const openaiProvider: IProvider = {
      name: 'openai',
      capabilities: { chat: true, streaming: true, embed: false, vision: false, function_call: false },
      chat: jest.fn(),
      chatStream: jest.fn().mockRejectedValue(new Error('Connection timeout')),
      embed: jest.fn(),
    };

    const deepseekProvider: IProvider = {
      name: 'deepseek',
      capabilities: { chat: true, streaming: true, embed: false, vision: false, function_call: false },
      chat: jest.fn(),
      chatStream: jest.fn().mockResolvedValue(new ReadableStream()),
      embed: jest.fn(),
    };

    registerProvider('openai', openaiProvider);
    registerProvider('deepseek', deepseekProvider);

    const request: ChatCompletionRequest = {
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'Hello' }],
    };

    const result = await chatCompleteStream('openai', request);
    expect(result).toBeInstanceOf(ReadableStream);
    expect(openaiProvider.chatStream).toHaveBeenCalledTimes(1);
    expect(deepseekProvider.chatStream).toHaveBeenCalledTimes(1);
  });

  it('should throw when all providers fail for stream', async () => {
    const openaiProvider: IProvider = {
      name: 'openai',
      capabilities: { chat: true, streaming: true, embed: false, vision: false, function_call: false },
      chat: jest.fn(),
      chatStream: jest.fn().mockRejectedValue(new Error('Connection timeout')),
      embed: jest.fn(),
    };

    const deepseekProvider: IProvider = {
      name: 'deepseek',
      capabilities: { chat: true, streaming: true, embed: false, vision: false, function_call: false },
      chat: jest.fn(),
      chatStream: jest.fn().mockRejectedValue(new Error('Connection timeout')),
      embed: jest.fn(),
    };

    registerProvider('openai', openaiProvider);
    registerProvider('deepseek', deepseekProvider);

    const request: ChatCompletionRequest = {
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'Hello' }],
    };

    await expect(chatCompleteStream('openai', request)).rejects.toThrow('All providers failed');
  });
});
