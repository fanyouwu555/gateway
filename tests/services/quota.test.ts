/**
 * 配额管理服务测试
 */
import {
  checkQuota,
  setTenantLimits,
  getQuotaStatus,
  resetQuotaStore,
  recordUsage,
  checkKeyQuota,
  getKeyCost,
  resetTenantQuota,
} from '../../src/../src/services/quota';
import { getConfig } from '../../src/../src/config';
import { getTenantUsage } from '../../src/../src/services/metrics';

// Mock config
jest.mock('../../src/config', () => ({
  getConfig: jest.fn(() => ({
    cost_control: {
      monthly_budget: 100,
      warn_threshold: 0.8,
    },
  })),
  resolveModelAlias: jest.fn((alias: string) => alias),
}));

// Mock metrics
jest.mock('../../src/../src/services/metrics', () => ({
  getTenantUsage: jest.fn(() => ({
    total_requests: 0,
    total_tokens: 0,
    total_cost: 0,
  })),
}));

describe('Quota Service', () => {
  beforeEach(() => {
    resetQuotaStore();
    jest.clearAllMocks();
    (getConfig as jest.Mock).mockReturnValue({
      cost_control: {
        monthly_budget: 100,
        warn_threshold: 0.8,
      },
    });
    (getTenantUsage as jest.Mock).mockReturnValue({
      total_requests: 0,
      total_tokens: 0,
      total_cost: 0,
    });
  });

  describe('checkQuota', () => {
    it('should allow request when under limit', () => {
      const result = checkQuota('test-tenant');
      expect(result.allowed).toBe(true);
    });

    it('should return remaining when under limit', () => {
      const result = checkQuota('test-tenant');
      expect(result.allowed).toBe(true);
      expect(result.remaining_cost).toBe(100);
    });

    it('should allow when no monthly_budget configured', () => {
      (getConfig as jest.Mock).mockReturnValue({ cost_control: {} });
      const result = checkQuota('test-tenant');
      expect(result.allowed).toBe(true);
    });

    it('should deny when monthly budget exceeded', () => {
      (getTenantUsage as jest.Mock).mockReturnValue({
        total_requests: 10,
        total_tokens: 1000,
        total_cost: 150,
      });
      const result = checkQuota('test-tenant');
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('Monthly budget exceeded');
    });

    it('should warn when usage exceeds threshold', () => {
      (getTenantUsage as jest.Mock).mockReturnValue({
        total_requests: 10,
        total_tokens: 1000,
        total_cost: 85,
      });
      const result = checkQuota('test-tenant');
      expect(result.allowed).toBe(true);
    });

    it('should deny when daily request limit exceeded', () => {
      setTenantLimits('test-tenant', { daily_requests: 5 });
      (getTenantUsage as jest.Mock).mockReturnValue({
        total_requests: 10,
        total_tokens: 1000,
        total_cost: 10,
      });
      const result = checkQuota('test-tenant');
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('Daily request limit exceeded');
    });

    it('should deny when daily token limit exceeded', () => {
      setTenantLimits('test-tenant', { daily_tokens: 100 });
      (getTenantUsage as jest.Mock).mockReturnValue({
        total_requests: 1,
        total_tokens: 200,
        total_cost: 1,
      });
      const result = checkQuota('test-tenant');
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('Daily token limit exceeded');
    });

    it('should deny when monthly cost limit exceeded', () => {
      setTenantLimits('test-tenant', { monthly_cost: 10 });
      (getTenantUsage as jest.Mock).mockReturnValue({
        total_requests: 1,
        total_tokens: 100,
        total_cost: 15,
      });
      const result = checkQuota('test-tenant');
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('Monthly cost limit exceeded');
    });

    it('should return remaining requests when limit set', () => {
      setTenantLimits('test-tenant', { daily_requests: 10 });
      (getTenantUsage as jest.Mock).mockReturnValue({
        total_requests: 3,
        total_tokens: 100,
        total_cost: 5,
      });
      const result = checkQuota('test-tenant');
      expect(result.allowed).toBe(true);
      expect(result.remaining_requests).toBe(7);
    });

    it('should return remaining tokens when limit set', () => {
      setTenantLimits('test-tenant', { daily_tokens: 1000 });
      (getTenantUsage as jest.Mock).mockReturnValue({
        total_requests: 1,
        total_tokens: 100,
        total_cost: 5,
      });
      const result = checkQuota('test-tenant');
      expect(result.allowed).toBe(true);
      expect(result.remaining_tokens).toBe(900);
    });
  });

  describe('recordUsage', () => {
    it('should record usage with key hash', () => {
      recordUsage('tenant-1', 100, 0.5, 'key-hash-1');
      const result = checkKeyQuota('key-hash-1', 1);
      expect(result.allowed).toBe(true);
      expect(result.current_cost).toBe(0.5);
    });

    it('should record usage without key hash', () => {
      recordUsage('tenant-1', 100, 0.5);
      const result = checkKeyQuota('missing-key', 1);
      expect(result.allowed).toBe(true);
      expect(result.current_cost).toBe(0);
    });
  });

  describe('checkKeyQuota', () => {
    it('should allow when under budget', () => {
      const result = checkKeyQuota('key-1', 100);
      expect(result.allowed).toBe(true);
    });

    it('should deny when budget exceeded', () => {
      recordUsage('tenant-1', 100, 50, 'key-1');
      const result = checkKeyQuota('key-1', 10);
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('Key monthly budget exceeded');
    });
  });

  describe('getKeyCost', () => {
    it('should return cost for key', () => {
      recordUsage('tenant-1', 100, 2.5, 'key-1');
      expect(getKeyCost('key-1')).toBe(2.5);
    });

    it('should return 0 for unknown key', () => {
      expect(getKeyCost('unknown')).toBe(0);
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

  describe('resetTenantQuota', () => {
    it('should reset daily and monthly quota', () => {
      recordUsage('tenant-1', 100, 5);
      resetTenantQuota('tenant-1');
      const status = getQuotaStatus('tenant-1');
      expect(status.usage.total_cost).toBe(0);
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