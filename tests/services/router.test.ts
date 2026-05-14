/**
 * 智能路由服务测试
 */
import {
  smartRoute,
  recordLatency,
  recordError,
  getRouterStatus,
  setRouterContext,
} from '../../src/services/router';
import type { ChatCompletionRequest } from '../../src/types';

describe('Router Service', () => {
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
  });

  describe('recordLatency', () => {
    it('should record latency for provider', () => {
      recordLatency('openai', 100);
      recordLatency('openai', 200);
      recordLatency('deepseek', 50);

      const status = getRouterStatus();
      expect(status.providers.openai?.avg_latency).toBeDefined();
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