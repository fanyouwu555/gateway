/**
 * 配额管理服务测试
 * QuotaService 只负责日请求/日Token限制；月度成本由 BillingService 负责
 */
import {
  checkQuota,
  setTenantLimits,
  getQuotaStatus,
  resetQuotaStore,
  recordUsage,
  resetTenantQuota,
} from '../../src/../src/services/quota';
import { getTenant } from '../../src/../src/services/tenant';
import { getTenantUsage } from '../../src/../src/services/metrics';

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
    (getTenant as jest.Mock).mockReturnValue(null);
    (getTenantUsage as jest.Mock).mockReturnValue({
      total_requests: 0,
      total_tokens: 0,
      total_cost: 0,
    });
  });

  describe('checkQuota', () => {
    it('should allow request when no limits configured', () => {
      const result = checkQuota('test-tenant');
      expect(result.allowed).toBe(true);
    });

    it('should not return remaining fields when no limits configured', () => {
      const result = checkQuota('test-tenant');
      expect(result.allowed).toBe(true);
      expect(result.remaining_requests).toBeUndefined();
      expect(result.remaining_tokens).toBeUndefined();
    });

    it('should use tenant daily limits when available', () => {
      (getTenant as jest.Mock).mockReturnValue({
        tenant_id: 'test-tenant',
        limits: {
          daily_requests: 10,
          daily_tokens: 1000,
        },
      });
      const result = checkQuota('test-tenant');
      expect(result.allowed).toBe(true);
      expect(result.remaining_requests).toBe(10);
      expect(result.remaining_tokens).toBe(1000);
    });

    it('should allow when tenant limits have no daily caps', () => {
      (getTenant as jest.Mock).mockReturnValue({
        tenant_id: 'test-tenant',
        limits: {},
      });
      const result = checkQuota('test-tenant');
      expect(result.allowed).toBe(true);
    });

    it('should deny when daily request limit exceeded', () => {
      setTenantLimits('test-tenant', { daily_requests: 5 });
      recordUsage('test-tenant', 100);
      recordUsage('test-tenant', 100);
      recordUsage('test-tenant', 100);
      recordUsage('test-tenant', 100);
      recordUsage('test-tenant', 100);
      recordUsage('test-tenant', 100); // 6th request over 5 limit
      const result = checkQuota('test-tenant');
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('Daily request limit exceeded');
    });

    it('should deny when daily token limit exceeded', () => {
      setTenantLimits('test-tenant', { daily_tokens: 100 });
      recordUsage('test-tenant', 200);
      const result = checkQuota('test-tenant');
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('Daily token limit exceeded');
    });

    it('should return remaining requests when limit set', () => {
      setTenantLimits('test-tenant', { daily_requests: 10 });
      recordUsage('test-tenant', 100);
      recordUsage('test-tenant', 100);
      recordUsage('test-tenant', 100);
      const result = checkQuota('test-tenant');
      expect(result.allowed).toBe(true);
      expect(result.remaining_requests).toBe(7);
    });

    it('should return remaining tokens when limit set', () => {
      setTenantLimits('test-tenant', { daily_tokens: 1000 });
      recordUsage('test-tenant', 100);
      const result = checkQuota('test-tenant');
      expect(result.allowed).toBe(true);
      expect(result.remaining_tokens).toBe(900);
    });

    it('should prefer tenant limits over custom limits', () => {
      setTenantLimits('test-tenant', { daily_requests: 100 });
      (getTenant as jest.Mock).mockReturnValue({
        tenant_id: 'test-tenant',
        limits: {
          daily_requests: 5,
        },
      });
      const result = checkQuota('test-tenant');
      expect(result.allowed).toBe(true);
      expect(result.remaining_requests).toBe(5);
    });
  });

  describe('recordUsage', () => {
    it('should accumulate daily requests and tokens', () => {
      recordUsage('tenant-1', 50);
      recordUsage('tenant-1', 30);
      setTenantLimits('tenant-1', { daily_requests: 3, daily_tokens: 100 });
      const result = checkQuota('tenant-1');
      expect(result.allowed).toBe(true);
      expect(result.remaining_requests).toBe(1);
      expect(result.remaining_tokens).toBe(20);
    });
  });

  describe('setTenantLimits', () => {
    it('should set custom daily limits for tenant', () => {
      setTenantLimits('custom-tenant', {
        daily_requests: 1000,
        daily_tokens: 100000,
      });

      const status = getQuotaStatus('custom-tenant');
      expect(status.limits?.daily_requests).toBe(1000);
      expect(status.limits?.daily_tokens).toBe(100000);
    });
  });

  describe('resetTenantQuota', () => {
    it('should reset daily quota counters', () => {
      setTenantLimits('tenant-1', { daily_requests: 10, daily_tokens: 1000 });
      recordUsage('tenant-1', 100);
      resetTenantQuota('tenant-1');
      const result = checkQuota('tenant-1');
      expect(result.allowed).toBe(true);
      expect(result.remaining_requests).toBe(10);
      expect(result.remaining_tokens).toBe(1000);
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
      recordUsage('tenant-1', 200);

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

    it('should not reset when within same day', () => {
      jest.useFakeTimers();
      const now = new Date('2026-06-11T10:00:00Z').getTime();
      jest.setSystemTime(now);

      setTenantLimits('tenant-1', { daily_tokens: 100 });
      recordUsage('tenant-1', 200);

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
      expect(status.limits).toBeDefined();
      expect(status.check).toBeDefined();
    });
  });
});
