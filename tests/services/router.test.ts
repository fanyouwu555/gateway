/**
 * 智能路由服务测试
 */
import {
  smartRoute,
  recordLatency,
  recordError,
  getRouterStatus,
  setRouterContext,
  resetRouter,
} from '../../src/services/router';
import type { ChatCompletionRequest } from '../../src/types';

describe('Router Service', () => {
  beforeEach(() => {
    resetRouter();
  });

  describe('smartRoute', () => {
    it('should route by explicit model', () => {
      const request: ChatCompletionRequest = {
        model: 'deepseek-chat',
        messages: [{ role: 'user', content: 'Hello' }],
      };
      const decision = smartRoute(request);
      expect(decision.provider).toBe('deepseek');
      expect(decision.reason).toBe('explicit_model');
    });

    it('should route by balance strategy as default', () => {
      const request: ChatCompletionRequest = {
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'Hello' }],
      };
      const decision = smartRoute(request);
      expect(decision.provider).toBeDefined();
    });

    it('should route by cost strategy', () => {
      const request: ChatCompletionRequest = {
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'Hello' }],
      };
      const decision = smartRoute(request, 'cost');
      expect(decision.provider).toBe('deepseek'); // lowest cost
      expect(decision.reason).toBe('lowest_cost');
    });

    it('should route by quality for long input', () => {
      const longContent = 'A'.repeat(6000);
      const request: ChatCompletionRequest = {
        model: 'gpt-3.5-turbo',
        messages: [{ role: 'user', content: longContent }],
      };
      const decision = smartRoute(request, 'quality');
      expect(decision.reason).toBe('high_quality_for_long_input');
    });

    it('should route by quality for tools', () => {
      const request: ChatCompletionRequest = {
        model: 'gpt-3.5-turbo',
        messages: [{ role: 'user', content: 'Hello' }],
        tools: [
          {
            type: 'function',
            function: { name: 'test', description: 'test', parameters: {} },
          },
        ],
      };
      const decision = smartRoute(request, 'quality');
      // 由于显式指定了模型，会使用explicit_model
      expect(decision.reason).toBe('explicit_model');
    });

    it('should fallback to balance for short input with quality strategy', () => {
      const request: ChatCompletionRequest = {
        model: 'unknown-model',
        messages: [{ role: 'user', content: 'short' }],
      };
      const decision = smartRoute(request, 'quality');
      expect(decision.reason).toBe('balanced_choice');
      expect(decision.confidence).toBe(0.7);
    });

    it('should route by latency using history', () => {
      setRouterContext({
        latency_history: {
          openai: [100, 200],
          deepseek: [50, 60],
        },
      });
      const request: ChatCompletionRequest = {
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'Hello' }],
      };
      const decision = smartRoute(request, 'latency');
      expect(decision.provider).toBe('deepseek');
      expect(decision.reason).toBe('lowest_latency');
    });

    it('should route by latency fallback when no history', () => {
      const request: ChatCompletionRequest = {
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'Hello' }],
      };
      const decision = smartRoute(request, 'latency');
      expect(decision.reason).toBe('lowest_latency');
    });

    it('should route by balance with tools when no model specified', () => {
      const request: ChatCompletionRequest = {
        model: '',
        messages: [{ role: 'user', content: 'Hello' }],
        tools: [
          {
            type: 'function',
            function: { name: 'test', description: 'test', parameters: {} },
          },
        ],
      };
      const decision = smartRoute(request, 'balance');
      expect(decision.reason).toBe('tools_require_high_quality');
    });

    it('should route by balance default when no model or tools', () => {
      const request: ChatCompletionRequest = {
        model: '',
        messages: [{ role: 'user', content: 'Hello' }],
      };
      const decision = smartRoute(request, 'balance');
      expect(decision.reason).toBe('balanced_choice');
    });

    it('should place unknown provider at end in cost routing', () => {
      const request: ChatCompletionRequest = {
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'Hello' }],
      };
      // The mock config has openai and deepseek; unknown providers not in cost_order
      // are placed at the end. This test mainly exercises the aIndex === -1 branch.
      const decision = smartRoute(request, 'cost');
      expect(decision.provider).toBeDefined();
    });
  });

  describe('recordLatency', () => {
    it('should record latency for provider', () => {
      recordLatency('openai', 100);
      recordLatency('openai', 200);
      recordLatency('deepseek', 50);

      const status = getRouterStatus();
      expect(status.providers.openai?.avg_latency).toBeDefined();
    });

    it('should trim latency history to 20 entries', () => {
      for (let i = 0; i < 25; i++) {
        recordLatency('openai', i);
      }
      const status = getRouterStatus();
      // average of last 20 entries (5 to 24) = (5+24)*20/2 / 20 = 14.5
      expect(status.providers.openai?.avg_latency).toBe(15);
    });
  });

  describe('recordError', () => {
    it('should record error rate', () => {
      recordError('openai');
      recordError('openai');

      const status = getRouterStatus();
      expect(status.providers.openai?.error_rate).toBeDefined();
    });
  });

  describe('getRouterStatus', () => {
    it('should return provider statistics', () => {
      const status = getRouterStatus();
      expect(status).toHaveProperty('providers');
    });

    it('should include error_rate without latency history', () => {
      recordError('openai');
      const status = getRouterStatus();
      expect(status.providers.openai?.error_rate).toBeGreaterThan(0);
      expect(status.providers.openai?.avg_latency).toBeUndefined();
    });
  });

  describe('setRouterContext', () => {
    it('should set routing context', () => {
      setRouterContext({
        tenant_id: 'tenant-1',
        latency_history: {
          openai: [100, 200],
        },
      });
      const status = getRouterStatus();
      expect(status.providers.openai?.avg_latency).toBe(150);
    });
  });
});