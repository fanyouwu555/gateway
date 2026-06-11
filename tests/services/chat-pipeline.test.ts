/**
 * Chat Pipeline — resolveRequestModel 测试
 */
import { resolveRequestModel } from '../../src/services/chat-pipeline';

jest.mock('../../src/config', () => ({
  resolveModelAlias: jest.fn((alias: string) => alias),
  getConfig: jest.fn(() => ({
    loadBalance: { strategy: 'roundRobin' },
    providers: {},
    failover: { enabled: false },
  })),
  getProviderConfig: jest.fn(() => undefined),
  getProviderForModel: jest.fn(() => undefined),
  getRoutingStrategy: jest.fn(() => ({ name: 'default', rules: [] })),
  getModelPool: jest.fn(() => undefined),
  isModelPool: jest.fn(() => false),
}));

describe('resolveRequestModel()', () => {
  it('should use request model when explicitly provided', () => {
    const result = resolveRequestModel(
      { model: 'gpt-4o', messages: [] },
      { default_model: 'claude-3' },
      'fallback-model',
    );
    expect(result.model).toBe('gpt-4o');
  });

  it('should fallback to default_model when request has no model', () => {
    const result = resolveRequestModel(
      { messages: [] },
      { default_model: 'claude-3-sonnet' },
      'fallback-model',
    );
    expect(result.model).toBe('claude-3-sonnet');
  });

  it('should fallback to fallbackModel when no default_model and no request model', () => {
    const result = resolveRequestModel(
      { messages: [] },
      undefined,
      'gpt-4o-mini',
    );
    expect(result.model).toBe('gpt-4o-mini');
  });

  it('should leave model unset when nothing available', () => {
    const result = resolveRequestModel(
      { messages: [] },
      undefined,
      undefined,
    );
    expect(result.model).toBeUndefined();
  });

  describe('DefaultModel alias', () => {
    it('should replace "DefaultModel" with key default_model', () => {
      const result = resolveRequestModel(
        { model: 'DefaultModel', messages: [] },
        { default_model: 'gpt-4o' },
        'fallback-model',
      );
      expect(result.model).toBe('gpt-4o');
    });

    it('should fallback to fallbackModel when key has no default_model and request is "DefaultModel"', () => {
      const result = resolveRequestModel(
        { model: 'DefaultModel', messages: [] },
        undefined,
        'gpt-4o-mini',
      );
      expect(result.model).toBe('gpt-4o-mini');
    });

    it('should leave model unset when key has no default_model and no fallback', () => {
      const result = resolveRequestModel(
        { model: 'DefaultModel', messages: [] },
        undefined,
        undefined,
      );
      expect(result.model).toBeUndefined();
    });

    it('should NOT affect normal model names', () => {
      const result = resolveRequestModel(
        { model: 'deepseek-chat', messages: [] },
        { default_model: 'gpt-4o' },
        'fallback-model',
      );
      expect(result.model).toBe('deepseek-chat');
    });

    it('should match "DefaultModel" exactly (case-sensitive)', () => {
      const result = resolveRequestModel(
        { model: 'defaultmodel', messages: [] },
        { default_model: 'gpt-4o' },
        'fallback-model',
      );
      // case-sensitive: should NOT match, so falls through to normal model resolution
      expect(result.model).toBe('defaultmodel');
    });
  });
});
