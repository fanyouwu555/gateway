/**
 * Alert Engine Tests
 */
import {
  addAlertRule,
  removeAlertRule,
  listAlertRules,
  setAlertEnabled,
  evaluateAlerts,
  resetAlertEngine,
} from '../../src/services/alert';

jest.mock('../../src/services/metrics', () => ({
  getDashboardOverview: jest.fn(() => ({
    total_requests: 100,
    total_tokens: 1000,
    total_cost: 0.1,
    avg_duration_ms: 200,
    success_rate: 0.95,
    error_rate: 0.05,
    total_providers: 2,
    total_models: 3,
    total_tenants: 1,
  })),
}));

jest.mock('../../src/utils/http-client', () => ({
  fetchWithAgent: jest.fn().mockResolvedValue({ ok: true }),
}));

describe('Alert Engine', () => {
  beforeEach(() => {
    resetAlertEngine();
    jest.clearAllMocks();
  });

  describe('rule management', () => {
    it('should add and list rules', () => {
      addAlertRule({
        id: 'rule-1',
        name: 'Error Rate Alert',
        metric: 'error_rate',
        threshold: 0.1,
        condition: 'gt',
        webhook_url: 'http://example.com/webhook',
        enabled: true,
        cooldown_seconds: 60,
      });

      const rules = listAlertRules();
      expect(rules).toHaveLength(1);
      expect(rules[0].id).toBe('rule-1');
    });

    it('should remove a rule', () => {
      addAlertRule({
        id: 'rule-1',
        name: 'Test',
        metric: 'error_rate',
        threshold: 0.1,
        condition: 'gt',
        webhook_url: 'http://example.com/webhook',
        enabled: true,
        cooldown_seconds: 60,
      });

      expect(removeAlertRule('rule-1')).toBe(true);
      expect(listAlertRules()).toHaveLength(0);
    });

    it('should enable/disable rules', () => {
      addAlertRule({
        id: 'rule-1',
        name: 'Test',
        metric: 'error_rate',
        threshold: 0.1,
        condition: 'gt',
        webhook_url: 'http://example.com/webhook',
        enabled: true,
        cooldown_seconds: 60,
      });

      setAlertEnabled('rule-1', false);
      expect(listAlertRules()[0].enabled).toBe(false);

      setAlertEnabled('rule-1', true);
      expect(listAlertRules()[0].enabled).toBe(true);
    });
  });

  describe('evaluation', () => {
    it('should not trigger when below threshold', () => {
      const { fetchWithAgent } = require('../../src/utils/http-client');
      fetchWithAgent.mockClear();

      addAlertRule({
        id: 'rule-1',
        name: 'High Error Rate',
        metric: 'error_rate',
        threshold: 0.1, // 10%
        condition: 'gt',
        webhook_url: 'http://example.com/webhook',
        enabled: true,
        cooldown_seconds: 60,
      });

      evaluateAlerts();
      expect(fetchWithAgent).not.toHaveBeenCalled();
    });

    it('should trigger webhook when threshold exceeded', () => {
      const { getDashboardOverview } = require('../../src/services/metrics');
      getDashboardOverview.mockReturnValue({
        total_requests: 100,
        total_tokens: 1000,
        total_cost: 0.1,
        avg_duration_ms: 200,
        success_rate: 0.85,
        error_rate: 0.15, // 15% > 10%
        total_providers: 2,
        total_models: 3,
        total_tenants: 1,
      });

      const { fetchWithAgent } = require('../../src/utils/http-client');
      fetchWithAgent.mockClear();

      addAlertRule({
        id: 'rule-1',
        name: 'High Error Rate',
        metric: 'error_rate',
        threshold: 0.1,
        condition: 'gt',
        webhook_url: 'http://example.com/webhook',
        enabled: true,
        cooldown_seconds: 0,
      });

      evaluateAlerts();

      // fetch is async, wait for next tick
      return new Promise((resolve) => setTimeout(resolve, 10)).then(() => {
        expect(fetchWithAgent).toHaveBeenCalledWith(
          'http://example.com/webhook',
          expect.objectContaining({
            method: 'POST',
            body: expect.stringContaining('firing'),
          })
        );
      });
    });

    it('should respect cooldown period', () => {
      const { getDashboardOverview } = require('../../src/services/metrics');
      getDashboardOverview.mockReturnValue({
        total_requests: 100,
        total_tokens: 1000,
        total_cost: 0.1,
        avg_duration_ms: 200,
        success_rate: 0.85,
        error_rate: 0.15,
        total_providers: 2,
        total_models: 3,
        total_tenants: 1,
      });

      const { fetchWithAgent } = require('../../src/utils/http-client');
      fetchWithAgent.mockClear();

      addAlertRule({
        id: 'rule-1',
        name: 'High Error Rate',
        metric: 'error_rate',
        threshold: 0.1,
        condition: 'gt',
        webhook_url: 'http://example.com/webhook',
        enabled: true,
        cooldown_seconds: 60,
      });

      evaluateAlerts();
      evaluateAlerts(); // second call within cooldown

      return new Promise((resolve) => setTimeout(resolve, 10)).then(() => {
        expect(fetchWithAgent).toHaveBeenCalledTimes(1);
      });
    });
  });
});
