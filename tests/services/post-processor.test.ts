/**
 * Post Processor Tests
 */
import { runPostProcessing } from '../../src/services/post-processor';
import { recordMetric } from '../../src/services/metrics';
import { recordUsage } from '../../src/services/quota';
import { recordKeyCost } from '../../src/services/billing';
import { deductBalance } from '../../src/services/wallet';
import { getConversationLogService } from '../../src/services/conversation-log';
import { recordAiTokens } from '../../src/middleware/metrics';

jest.mock('../../src/services/metrics', () => ({
  recordMetric: jest.fn(),
}));

jest.mock('../../src/services/quota', () => ({
  recordUsage: jest.fn(),
}));

jest.mock('../../src/services/billing', () => ({
  recordKeyCost: jest.fn(),
}));

jest.mock('../../src/services/wallet', () => ({
  deductBalance: jest.fn().mockResolvedValue({ success: true, newBalance: 500 }),
}));

jest.mock('../../src/services/request-log', () => ({
  getRequestLogStore: jest.fn().mockReturnValue({ shouldSample: () => false, add: jest.fn() }),
}));

jest.mock('../../src/services/conversation-log', () => ({
  getConversationLogService: jest.fn().mockReturnValue({ saveTurn: jest.fn().mockResolvedValue(undefined) }),
}));

jest.mock('../../src/services/pricing', () => ({
  getPricingService: jest.fn().mockReturnValue({
    calculateCost: jest.fn().mockReturnValue(0.001),
  }),
}));

jest.mock('../../src/services/token-ratelimit', () => ({
  getTokenRateLimit: jest.fn().mockReturnValue({ consume: jest.fn() }),
}));

jest.mock('../../src/middleware/metrics', () => ({
  recordAiTokens: jest.fn(),
  recordAiCost: jest.fn(),
}));

function createMockContext(overrides?: Record<string, unknown>): import('hono').Context {
  const store = new Map<string, unknown>();
  return {
    get: (key: string) => store.get(key) || overrides?.[key],
    set: (key: string, value: unknown) => store.set(key, value),
    header: jest.fn(),
    req: { header: () => undefined },
  } as unknown as import('hono').Context;
}

describe('runPostProcessing', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should record metrics and return cost', async () => {
    const c = createMockContext({ request_id: 'req-1', tenant_id: 't1', key_hash: 'kh1' });
    const result = await runPostProcessing({
      c,
      tenantId: 't1',
      keyHash: 'kh1',
      model: 'gpt-4o',
      provider: 'openai',
      latencyMs: 100,
      statusCode: 200,
      tokens: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      content: 'Hello',
      requestBody: { messages: [{ role: 'user', content: 'Hi' }] },
      isStream: false,
      sessionId: 'sess-1',
    });

    expect(result.cost).toBe(0.001);
    expect(recordMetric).toHaveBeenCalled();
    expect(recordAiTokens).toHaveBeenCalledWith(10, 5, 'openai', 'gpt-4o');
    expect(recordUsage).toHaveBeenCalledWith('t1', 15);
    expect(recordKeyCost).toHaveBeenCalledWith('kh1', 0.001);
  });

  it('should deduct prepaid balance', async () => {
    const c = createMockContext({ request_id: 'req-2', key_billing_mode: 'prepaid', key_hash: 'kh2' });
    const result = await runPostProcessing({
      c,
      tenantId: 't1',
      keyHash: 'kh2',
      model: 'gpt-4o',
      provider: 'openai',
      latencyMs: 100,
      statusCode: 200,
      tokens: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      content: 'Hello',
      requestBody: {},
      isStream: false,
      sessionId: 'sess-1',
    });

    expect(deductBalance).toHaveBeenCalled();
    expect(result.remainingBalanceMicroYuan).toBe(500);
  });

  it('should skip billing on non-200 status', async () => {
    const c = createMockContext({ request_id: 'req-3' });
    const result = await runPostProcessing({
      c,
      tenantId: 't1',
      keyHash: 'kh1',
      model: 'gpt-4o',
      provider: 'openai',
      latencyMs: 100,
      statusCode: 500,
      tokens: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      content: '',
      requestBody: {},
      isStream: false,
      sessionId: 'sess-1',
    });

    expect(recordKeyCost).not.toHaveBeenCalled();
    expect(deductBalance).not.toHaveBeenCalled();
    expect(result.remainingBalanceMicroYuan).toBeUndefined();
  });

  it('should save conversation log when content is provided', async () => {
    const c = createMockContext({ request_id: 'req-4' });
    const saveTurn = jest.fn().mockResolvedValue(undefined);
    (getConversationLogService as jest.Mock).mockReturnValue({ saveTurn });

    await runPostProcessing({
      c,
      model: 'gpt-4o',
      provider: 'openai',
      latencyMs: 100,
      statusCode: 200,
      tokens: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      content: 'Hello',
      reasoningContent: 'Think',
      requestBody: {},
      isStream: true,
      sessionId: 'sess-1',
    });

    expect(saveTurn).toHaveBeenCalled();
    const turn = saveTurn.mock.calls[0][0];
    expect(turn.response.content).toBe('Hello');
    expect(turn.response.reasoning_content).toBe('Think');
  });
});
