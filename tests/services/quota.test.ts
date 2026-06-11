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
import { getTenant } from '../../src/../src/services/tenant';
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

// Mock tenant service
jest.mock('../../src/services/tenant', () => ({
  getTenant: jest.fn(() => null),
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
    (getTenant as jest.Mock).mockReturnValue(null);
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
      (getTenant as jest.Mock).mockReturnValue(null);
      const result = checkQuota('test-tenant');
      expect(result.allowed).toBe(true);
    });

    it('should use tenant limits when available', () => {
      (getTenant as jest.Mock).mockReturnValue({
        tenant_id: 'test-tenant',
        limits: {
          monthly_cost: 50,
          daily_requests: 10,
          daily_tokens: 1000,
        },
      });
      const result = checkQuota('test-tenant');
      expect(result.allowed).toBe(true);
      expect(result.remaining_cost).toBe(50);
      expect(result.remaining_requests).toBe(10);
      expect(result.remaining_tokens).toBe(1000);
    });

    it('should deny when tenant monthly cost limit exceeded', () => {
      (getTenant as jest.Mock).mockReturnValue({
        tenant_id: 'test-tenant',
        limits: {
          monthly_cost: 10,
        },
      });
      recordUsage('test-tenant', 100, 15);
      const result = checkQuota('test-tenant');
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('Monthly budget exceeded');
    });

    it('should deny when monthly budget exceeded', () => {
      // quotaStore is the data source — populate via recordUsage
      recordUsage('test-tenant', 1000, 150);
      const result = checkQuota('test-tenant');
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('Monthly budget exceeded');
    });

    it('should warn when usage exceeds threshold', () => {
      recordUsage('test-tenant', 1000, 85);
      const result = checkQuota('test-tenant');
      expect(result.allowed).toBe(true);
    });

    it('should deny when daily request limit exceeded', () => {
      setTenantLimits('test-tenant', { daily_requests: 5 });
      recordUsage('test-tenant', 100, 1);
      recordUsage('test-tenant', 100, 1);
      recordUsage('test-tenant', 100, 1);
      recordUsage('test-tenant', 100, 1);
      recordUsage('test-tenant', 100, 1);
      recordUsage('test-tenant', 100, 1); // 6th request over 5 limit
      const result = checkQuota('test-tenant');
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('Daily request limit exceeded');
    });

    it('should deny when daily token limit exceeded', () => {
      setTenantLimits('test-tenant', { daily_tokens: 100 });
      recordUsage('test-tenant', 200, 1);
      const result = checkQuota('test-tenant');
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('Daily token limit exceeded');
    });

    it('should deny when custom monthly cost limit exceeded', () => {
      setTenantLimits('test-tenant', { monthly_cost: 10 });
      recordUsage('test-tenant', 100, 15);
      const result = checkQuota('test-tenant');
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('Monthly budget exceeded');
    });

    it('should return remaining requests when limit set', () => {
      setTenantLimits('test-tenant', { daily_requests: 10 });
      recordUsage('test-tenant', 100, 5);
      recordUsage('test-tenant', 100, 5);
      recordUsage('test-tenant', 100, 5);
      const result = checkQuota('test-tenant');
      expect(result.allowed).toBe(true);
      expect(result.remaining_requests).toBe(7);
    });

    it('should return remaining tokens when limit set', () => {
      setTenantLimits('test-tenant', { daily_tokens: 1000 });
      recordUsage('test-tenant', 100, 5);
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

  describe('auto reset by date', () => {
    afterEach(() => {
      jest.useRealTimers();
    });

    it('should auto-reset daily quota when day changes', () => {
      jest.useFakeTimers();
      const now = new Date('2026-06-11T10:00:00Z').getTime();
      jest.setSystemTime(now);

      setTenantLimits('tenant-1', { daily_tokens: 100 });
      recordUsage('tenant-1', 200, 1);

      // 当天应被拒绝
      let result = checkQuota('tenant-1');
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('Daily token limit exceeded');

      // 推进到第二天
      jest.setSystemTime(now + 24 * 60 * 60 * 1000);

      // 应自动重置并允许通过
      result = checkQuota('tenant-1');
      expect(result.allowed).toBe(true);
      expect(result.remaining_tokens).toBe(100);
    });

    it('should auto-reset monthly cost when month changes', () => {
      jest.useFakeTimers();
      const now = new Date('2026-06-30T10:00:00Z').getTime();
      jest.setSystemTime(now);

      recordUsage('tenant-1', 1000, 150);

      // 当月应被拒绝（超过 global monthly_budget 100）
      let result = checkQuota('tenant-1');
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('Monthly budget exceeded');

      // 推进到下个月
      jest.setSystemTime(now + 24 * 60 * 60 * 1000);

      // 应自动重置并允许通过
      result = checkQuota('tenant-1');
      expect(result.allowed).toBe(true);
    });

    it('should not reset when within same day', () => {
      jest.useFakeTimers();
      const now = new Date('2026-06-11T10:00:00Z').getTime();
      jest.setSystemTime(now);

      setTenantLimits('tenant-1', { daily_tokens: 100 });
      recordUsage('tenant-1', 200, 1);

      // 推进 1 小时（同一天）
      jest.setSystemTime(now + 60 * 60 * 1000);

      // 仍应被拒绝
      const result = checkQuota('tenant-1');
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('Daily token limit exceeded');
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