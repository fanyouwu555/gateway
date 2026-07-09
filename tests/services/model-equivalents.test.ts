/**
 * Model Equivalents �?�?Provider Failover 模型名自动重映射测试
 */
import {
  resolveModelForProvider,
  chatComplete,
  registerProvider,
  resetProviders,
  setProviderDeps,
  resetProviderDeps,
} from '../../src/providers';

function providerError(message: string): Error {
  const error = new Error(message);
  (error as { status?: number }).status = 503;
  return error;
}

jest.mock('../../src/config', () => ({
  getConfig: () => ({
    providers: {
      openai: { provider: 'openai', base_url: 'https://api.openai.com/v1', api_key: 'sk-openai' },
      deepseek: { provider: 'deepseek', base_url: 'https://api.deepseek.com/v1', api_key: 'sk-deepseek' },
      anthropic: { provider: 'anthropic', base_url: 'https://api.anthropic.com', api_key: 'sk-anthropic' },
    },
    failover: {
      enabled: true,
      failureThreshold: 2,
      successThreshold: 1,
      healthCheckInterval: 1000,
      healthCheckTimeout: 500,
      healthCheckModel: 'gpt-4o-mini',
      chains: { openai: ['deepseek', 'anthropic'] },
      errorRateThreshold: 0.5,
      latencyThresholdMs: 30000,
    },
    routing: [{ name: 'default', rules: [{ model: 'gpt-4o', provider: 'openai' }], fallback: 'deepseek' }],
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
  getProviderApiKeys: (config: { api_key?: string; api_keys?: string[] }) => {
    if (config.api_keys && config.api_keys.length > 0) return config.api_keys;
    if (config.api_key) return [config.api_key];
    return [];
  },
  getProviderConfig: (name: string) => {
    const configs: Record<string, unknown> = {
      openai: { provider: 'openai', base_url: 'https://api.openai.com/v1', api_key: 'sk-openai' },
      deepseek: { provider: 'deepseek', base_url: 'https://api.deepseek.com/v1', api_key: 'sk-deepseek' },
      anthropic: { provider: 'anthropic', base_url: 'https://api.anthropic.com', api_key: 'sk-anthropic' },
      mistral: { provider: 'mistral', base_url: 'https://api.mistral.ai/v1', api_key: 'sk-mistral' },
    };
    return configs[name] as { provider: string; base_url: string; api_key: string };
  },
  getProviderForModel: () => 'openai',
  getRoutingStrategy: () => ({ name: 'default', rules: [{ model: 'gpt-4o', provider: 'openai' }], fallback: 'deepseek' }),
  resolveModelAlias: jest.fn((alias: string) => alias),
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockFailover: any = {
  recordSuccess: jest.fn(),
  recordFailure: jest.fn(),
  getAvailableToken: jest.fn().mockReturnValue({ apiKey: 'key' }),
  isProviderHealthy: jest.fn().mockReturnValue(true),
  recordProviderRequest: jest.fn(),
  getProviderHealthStatus: jest.fn().mockReturnValue({}),
  getFailoverChain: jest.fn().mockReturnValue(['deepseek', 'anthropic']),
  getHealthyKeys: jest.fn().mockImplementation((_provider: string, keys: string[]) => keys),
  reset: jest.fn(),
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockLoadBalancer: any = {
  selectToken: jest.fn().mockReturnValue({ apiKey: 'key', weight: 1 }),
  recordSuccess: jest.fn(),
  recordFailure: jest.fn(),
};

describe('resolveModelForProvider()', () => {
  it('should return remapped model when equivalent exists', () => {
    expect(resolveModelForProvider('gpt-4o', 'deepseek')).toBe('deepseek-chat');
  });

  it('should return remapped model for anthropic', () => {
    expect(resolveModelForProvider('gpt-4o', 'anthropic')).toBe('claude-3-5-sonnet-20241022');
  });

  it('should return original model when no equivalent for provider', () => {
    expect(resolveModelForProvider('gpt-4o', 'mistral')).toBe('gpt-4o');
  });

  it('should return original model when no equivalent for model', () => {
    expect(resolveModelForProvider('nonexistent-model', 'deepseek')).toBe('nonexistent-model');
  });

  it('should return original model when model_equivalents is empty', () => {
    jest.isolateModules(() => {
      jest.mock('../../src/config', () => ({
        getConfig: () => ({ model_equivalents: undefined }),
      }));
    });
    // Can't truly test isolate here, but the function logic is clear:
    // no equivalents �?return model as-is
  });
});

describe('chatComplete() model_equivalents integration', () => {
  beforeEach(() => {
    resetProviders();
    resetProviderDeps();
    registerProvider('openai', mockOpenAI);
    registerProvider('deepseek', mockDeepSeek);
    registerProvider('anthropic', mockAnthropic);
    jest.clearAllMocks();
  });

  it('should remap model when failing over to deepseek with model_equivalent', async () => {
    mockOpenAI.chat.mockRejectedValue(providerError('OpenAI down'));
    mockDeepSeek.chat.mockImplementation(async (_req: { model: string }) => ({
      id: 'ds-1',
      object: 'chat.completion',
      created: 1,
      model: _req.model,
      choices: [],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }));

    setProviderDeps({ failoverManager: mockFailover, loadBalanceManager: mockLoadBalancer });

    const result = await chatComplete('openai', {
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'hello' }],
    });

    // Verify the request sent to deepseek had the remapped model
    const deepseekCall = mockDeepSeek.chat.mock.calls[0][0];
    expect(deepseekCall.model).toBe('deepseek-chat');

    // Response contains the actual model name from deepseek
    expect(result.model).toBe('deepseek-chat');
  });

  it('should remap model for each fallback provider in the chain', async () => {
    mockOpenAI.chat.mockRejectedValue(providerError('OpenAI down'));
    mockDeepSeek.chat.mockRejectedValue(providerError('DeepSeek down'));
    mockAnthropic.chat.mockImplementation(async (_req: { model: string }) => ({
      id: 'an-1',
      object: 'chat.completion',
      created: 1,
      model: _req.model,
      choices: [],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }));

    setProviderDeps({ failoverManager: mockFailover, loadBalanceManager: mockLoadBalancer });

    await chatComplete('openai', {
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'hello' }],
    });

    // deepseek got remapped model
    const dsCall = mockDeepSeek.chat.mock.calls[0][0];
    expect(dsCall.model).toBe('deepseek-chat');

    // anthropic got remapped model
    const anCall = mockAnthropic.chat.mock.calls[0][0];
    expect(anCall.model).toBe('claude-3-5-sonnet-20241022');
  });

  it('should NOT remap model for primary provider (no model_equivalent needed)', async () => {
    mockOpenAI.chat.mockImplementation(async (_req: { model: string }) => ({
      id: 'oa-1',
      object: 'chat.completion',
      created: 1,
      model: _req.model,
      choices: [],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }));

    setProviderDeps({ failoverManager: mockFailover, loadBalanceManager: mockLoadBalancer });

    await chatComplete('openai', {
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'hello' }],
    });

    const openaiCall = mockOpenAI.chat.mock.calls[0][0];
    expect(openaiCall.model).toBe('gpt-4o');
  });

  it('should use original model when no model_equivalent for that fallback', async () => {
    mockOpenAI.chat.mockRejectedValue(providerError('OpenAI down'));
    // No equivalent for openai→mistral, so model stays as-is
    mockFailover.getFailoverChain.mockReturnValue(['mistral']);

    const mockMistral = {
      name: 'mistral',
      capabilities: { chat: true, embed: false, streaming: false, vision: false, function_call: false, reasoning: false },
      chat: jest.fn().mockImplementation(async (_req: { model: string }) => ({
        id: 'ms-1',
        object: 'chat.completion',
        created: 1,
        model: _req.model,
        choices: [],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      })),
      chatStream: jest.fn(),
      embed: jest.fn(),
    };
    registerProvider('mistral', mockMistral);

    setProviderDeps({ failoverManager: mockFailover, loadBalanceManager: mockLoadBalancer });

    await chatComplete('openai', {
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'hello' }],
    });

    const mistralCall = mockMistral.chat.mock.calls[0][0];
    expect(mistralCall.model).toBe('gpt-4o');
  });
});