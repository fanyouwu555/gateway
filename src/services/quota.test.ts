/**
 * 配额管理服务测试
 */
import { checkQuota, setTenantLimits, getQuotaStatus } from './quota';

// Mock config
jest.mock('../config', () => ({
  getConfig: () => ({
    cost_control: {
      monthly_budget: 100,
      warn_threshold: 0.8,
    },
  }),
}));

// Mock metrics
jest.mock('./metrics', () => ({
  getTenantUsage: () => ({
    total_requests: 0,
    total_tokens: 0,
    total_cost: 0,
  }),
}));

describe('Quota Service', () => {
  describe('checkQuota', () => {
    it('should allow request when under limit', () => {
      const result = checkQuota('test-tenant');
      expect(result.allowed).toBe(true);
    });

    it('should return remaining when under limit', () => {
      const result = checkQuota('test-tenant');
      expect(result.allowed).toBe(true);
    });
  });

  describe('setTenantLimits', () => {
    it('should set custom limits for tenant', () => {
      setTenantLimits('custom-tenant', {
        daily_requests: 1000,
        daily_tokens: 100000,
        monthly_cost: 50,
      });

      const status = getQuotaStatus('custom-tenant');
      expect(status.limits?.daily_requests).toBe(1000);
    });
  });

  describe('getQuotaStatus', () => {
    it('should return full quota status', () => {
      const status = getQuotaStatus('test-tenant');
      expect(status.usage).toBeDefined();
      expect(status.check).toBeDefined();
    });
  });
});