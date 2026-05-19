/**
 * Cross-Provider Failover Chain Integration Tests
 */
import {
  chatComplete,
  registerProvider,
  resetProviders,
  setProviderDeps,
  resetProviderDeps,
} from '../../src/providers';

jest.mock('../../src/config', () => ({
  getConfig: () => ({
    providers: {
      openai: { provider: 'openai', base_url: 'https://api.openai.com/v1', api_key: 'sk-openai' },
      deepseek: { provider: 'deepseek', base_url: 'https://api.deepseek.com/v1', api_key: 'sk-deepseek' },
    },
    failover: {
      enabled: true,
      failureThreshold: 2,
      successThreshold: 1,
      healthCheckInterval: 1000,
      healthCheckTimeout: 500,
      healthCheckModel: 'gpt-4o-mini',
      chains: { openai: ['deepseek'] },
      errorRateThreshold: 0.5,
      latencyThresholdMs: 30000,
    },
    routing: [{ name: 'default', rules: [{ model: 'gpt-4o', provider: 'openai' }], fallback: 'deepseek' }],
  }),
  getProviderConfig: (name: string) => {
    const configs: Record<string, unknown> = {
      openai: { provider: 'openai', base_url: 'https://api.openai.com/v1', api_key: 'sk-openai' },
      deepseek: { provider: 'deepseek', base_url: 'https://api.deepseek.com/v1', api_key: 'sk-deepseek' },
    };
    return configs[name] as { provider: string; base_url: string; api_key: string };
  },
  getProviderForModel: () => 'openai',
  getRoutingStrategy: () => ({ name: 'default', rules: [{ model: 'gpt-4o', provider: 'openai' }], fallback: 'deepseek' }),
}));

const mockOpenAI = {
  name: 'openai',
  capabilities: { chat: true, embed: false, streaming: false, vision: false, function_call: false },
  chat: jest.fn(),
  chatStream: jest.fn(),
  embed: jest.fn(),
};

const mockDeepSeek = {
  name: 'deepseek',
  capabilities: { chat: true, embed: false, streaming: false, vision: false, function_call: false },
  chat: jest.fn(),
  chatStream: jest.fn(),
  embed: jest.fn(),
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockFailover: any = {
  recordSuccess: jest.fn(),
  recordFailure: jest.fn(),
  getAvailableToken: jest.fn().mockReturnValue({ apiKey: 'key' }),
  isProviderHealthy: jest.fn().mockReturnValue(true),
  recordProviderRequest: jest.fn(),
  getProviderHealthStatus: jest.fn().mockReturnValue({}),
  getFailoverChain: jest.fn().mockReturnValue(['deepseek']),
  reset: jest.fn(),
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockLoadBalancer: any = {
  selectToken: jest.fn().mockReturnValue({ apiKey: 'key', weight: 1 }),
  recordSuccess: jest.fn(),
  recordFailure: jest.fn(),
};

describe('Cross-Provider Failover Chain', () => {
  beforeEach(() => {
    resetProviders();
    resetProviderDeps();
    registerProvider('openai', mockOpenAI);
    registerProvider('deepseek', mockDeepSeek);
    jest.clearAllMocks();
  });

  it('should fallback to deepseek when openai fails', async () => {
    mockOpenAI.chat.mockRejectedValue(new Error('OpenAI down'));
    mockDeepSeek.chat.mockResolvedValue({
      id: 'ds-1',
      object: 'chat.completion',
      created: 1,
      model: 'deepseek-chat',
      choices: [],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });

    setProviderDeps({ failoverManager: mockFailover, loadBalanceManager: mockLoadBalancer });

    const result = await chatComplete('openai', {
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'hello' }],
    });

    expect(mockOpenAI.chat).toHaveBeenCalled();
    expect(mockDeepSeek.chat).toHaveBeenCalled();
    expect(result.model).toBe('deepseek-chat');
  });

  it('should skip unhealthy primary provider and use fallback directly', async () => {
    mockFailover.isProviderHealthy.mockImplementation((p: string) => p !== 'openai');
    mockDeepSeek.chat.mockResolvedValue({
      id: 'ds-2',
      object: 'chat.completion',
      created: 1,
      model: 'deepseek-chat',
      choices: [],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });

    setProviderDeps({ failoverManager: mockFailover, loadBalanceManager: mockLoadBalancer });

    const result = await chatComplete('openai', {
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'hello' }],
    });

    expect(mockOpenAI.chat).not.toHaveBeenCalled();
    expect(mockDeepSeek.chat).toHaveBeenCalled();
    expect(result.model).toBe('deepseek-chat');
  });

  it('should throw when all providers in chain fail', async () => {
    mockOpenAI.chat.mockRejectedValue(new Error('OpenAI down'));
    mockDeepSeek.chat.mockRejectedValue(new Error('DeepSeek down'));

    setProviderDeps({ failoverManager: mockFailover, loadBalanceManager: mockLoadBalancer });

    await expect(
      chatComplete('openai', {
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'hello' }],
      })
    ).rejects.toThrow(/All providers failed/);
  });
});
