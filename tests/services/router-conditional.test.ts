/**
 * 条件路由规则测试
 */
import { evaluateConditionalRules, resetRouter } from '../../src/services/router';
import { reloadConfig, getConfig } from '../../src/config';

describe('Conditional Routing Rules', () => {
  beforeEach(() => {
    reloadConfig();
    resetRouter();
    const config = getConfig();
    // 设置条件路由规则
    config.routing = [
      {
        name: 'default',
        rules: [
          { model: 'gpt-4o', provider: 'openai' },
          { model: 'deepseek-chat', provider: 'deepseek' },
        ],
        fallback: 'openai',
        conditional_rules: [
          {
            name: 'tenant-route',
            priority: 100,
            condition: { field: 'tenant_id', operator: 'eq', value: 'tenant-alpha' },
            target: { provider: 'deepseek' },
          },
          {
            name: 'tool-route',
            priority: 90,
            condition: { field: 'has_tools', operator: 'eq', value: true },
            target: { provider: 'anthropic', model: 'claude-3-5-sonnet-20241022' },
          },
          {
            name: 'content-route',
            priority: 80,
            condition: { field: 'content_length', operator: 'gt', value: 10000 },
            target: { provider: 'anthropic' },
          },
          {
            name: 'model-route',
            priority: 70,
            condition: { field: 'model', operator: 'contains', value: 'gpt' },
            target: { provider: 'openai' },
          },
          {
            name: 'header-route',
            priority: 60,
            condition: { field: 'header.x-preference', operator: 'eq', value: 'deepseek' },
            target: { provider: 'deepseek' },
          },
          {
            name: 'neq-route',
            priority: 50,
            condition: { field: 'tenant_id', operator: 'neq', value: 'tenant-beta' },
            target: { provider: 'openai' },
          },
          {
            name: 'regex-route',
            priority: 40,
            condition: { field: 'model', operator: 'regex', value: '^claude' },
            target: { provider: 'anthropic' },
          },
        ],
      },
    ];
  });

  it('should match tenant_id condition', () => {
    const result = evaluateConditionalRules({
      model: 'gpt-4o',
      tenant_id: 'tenant-alpha',
    });
    expect(result).not.toBeNull();
    expect(result!.provider).toBe('deepseek');
    expect(result!.reason).toBe('conditional_rule:tenant-route');
  });

  it('should not match when tenant_id does not match', () => {
    const result = evaluateConditionalRules({
      model: 'deepseek-chat', // won't trigger model-route (no 'gpt')
      tenant_id: 'tenant-other',
    });
    // tenant-route should NOT be the match since tenant_id !== 'tenant-alpha'
    // neq-route says tenant_id !== 'tenant-beta' - tenant-other !== 'tenant-beta', so it matches
    expect(result).not.toBeNull();
    expect(result!.reason).toBe('conditional_rule:neq-route');
    expect(result!.provider).toBe('openai');
  });

  it('should match has_tools condition', () => {
    const result = evaluateConditionalRules({
      model: 'gpt-4o',
      has_tools: true,
    });
    expect(result).not.toBeNull();
    expect(result!.provider).toBe('anthropic');
    expect(result!.model).toBe('claude-3-5-sonnet-20241022');
  });

  it('should respect priority order', () => {
    // tenant-route has priority 100, tool-route has 90
    // Both conditions match, but tenant-route wins
    const result = evaluateConditionalRules({
      model: 'gpt-4o',
      tenant_id: 'tenant-alpha',
      has_tools: true,
    });
    expect(result).not.toBeNull();
    expect(result!.provider).toBe('deepseek');
    expect(result!.reason).toBe('conditional_rule:tenant-route');
  });

  it('should match content_length condition', () => {
    const result = evaluateConditionalRules({
      model: 'gpt-4o',
      content_length: 15000,
    });
    expect(result).not.toBeNull();
    expect(result!.provider).toBe('anthropic');
  });

  it('should not match content_length when below threshold', () => {
    const result = evaluateConditionalRules({
      model: 'gpt-4o',
      content_length: 500,
    });
    // neq-route may match since tenant_id is not 'tenant-beta'
    expect(result).not.toBeNull();
    expect(result!.provider).toBe('openai');
  });

  it('should match header field', () => {
    const result = evaluateConditionalRules({
      model: 'deepseek-chat', // won't trigger model-route (no 'gpt')
      headers: { 'x-preference': 'deepseek' },
    });
    expect(result).not.toBeNull();
    expect(result!.provider).toBe('deepseek');
  });

  it('should return null when no rules match', () => {
    // Configure only rules that will NOT match
    const config = getConfig();
    config.routing[0].conditional_rules = [
      {
        name: 'strict-rule',
        priority: 100,
        condition: { field: 'tenant_id', operator: 'eq', value: 'nonexistent' },
        target: { provider: 'deepseek' },
      },
    ];

    const result = evaluateConditionalRules({
      model: 'gpt-4o',
      tenant_id: 'some-other',
    });
    expect(result).toBeNull();
  });

  it('should return null when no conditional_rules configured', () => {
    const config = getConfig();
    delete config.routing[0].conditional_rules;

    const result = evaluateConditionalRules({
      model: 'gpt-4o',
    });
    expect(result).toBeNull();
  });

  it('should match neq operator', () => {
    const result = evaluateConditionalRules({
      model: 'deepseek-chat', // won't trigger model-route (no 'gpt')
      tenant_id: 'tenant-gamma', // not 'tenant-beta', so neq matches
    });
    expect(result).not.toBeNull();
    expect(result!.reason).toBe('conditional_rule:neq-route');
    expect(result!.provider).toBe('openai');
  });

  it('should match regex operator', () => {
    const result = evaluateConditionalRules({
      model: 'claude-3-opus',
    });
    expect(result).not.toBeNull();
    expect(result!.provider).toBe('anthropic');
    expect(result!.reason).toBe('conditional_rule:regex-route');
  });

  it('should fallthrough to null when no rules match', () => {
    const config = getConfig();
    config.routing[0].conditional_rules = [];

    const result = evaluateConditionalRules({
      model: 'gpt-4o',
    });
    expect(result).toBeNull();
  });
});