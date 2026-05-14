/**
 * 用量统计服务测试
 */
import {
  recordMetric,
  getTenantUsage,
  getUsageByTimeRange,
  getAllMetrics,
  clearMetrics,
  calculateCost,
  initPricing,
} from '../../src/services/metrics';

describe('Metrics Service', () => {
  beforeAll(() => {
    // 初始化测试用定价
    initPricing({
      'gpt-4o': { input: 5.0, output: 15.0 },
      'deepseek-chat': { input: 0.27, output: 1.1 },
    });
  });

  beforeEach(() => {
    clearMetrics();
  });

  describe('recordMetric', () => {
    it('should record request metrics', () => {
      const metric = recordMetric(
        'req-123',
        'tenant-1',
        'openai',
        'gpt-4o',
        100,
        200,
        { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
      );
      expect(metric.request_id).toBe('req-123');
      expect(metric.tenant_id).toBe('tenant-1');
      expect(metric.duration_ms).toBe(100);
      expect(metric.status_code).toBe(200);
    });

    it('should calculate cost for known models', () => {
      const cost = calculateCost('gpt-4o', {
        prompt_tokens: 1000000,
        completion_tokens: 500000,
        total_tokens: 1500000,
      });
      expect(cost).toBeDefined();
      expect(cost).toBeGreaterThan(0);
    });

    it('should return undefined for unknown models', () => {
      const cost = calculateCost('unknown-model', {
        prompt_tokens: 1000,
        completion_tokens: 500,
        total_tokens: 1500,
      });
      expect(cost).toBeUndefined();
    });
  });

  describe('getTenantUsage', () => {
    it('should return empty stats for new tenant', () => {
      const usage = getTenantUsage('new-tenant');
      expect(usage.total_requests).toBe(0);
      expect(usage.total_tokens).toBe(0);
      expect(usage.total_cost).toBe(0);
    });

    it('should aggregate usage for tenant', () => {
      recordMetric('req-1', 'tenant-1', 'openai', 'gpt-4o', 100, 200, {
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15,
      });
      recordMetric('req-2', 'tenant-1', 'openai', 'gpt-4o', 100, 200, {
        prompt_tokens: 20,
        completion_tokens: 10,
        total_tokens: 30,
      });

      const usage = getTenantUsage('tenant-1');
      expect(usage.total_requests).toBe(2);
      expect(usage.total_tokens).toBe(45);
    });
  });

  describe('getUsageByTimeRange', () => {
    it('should filter by time range', () => {
      const now = Date.now();
      const startTime = now - 1000;
      const endTime = now + 1000;

      recordMetric('req-1', 'tenant-1', 'openai', 'gpt-4o', 100, 200, {
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15,
      });

      const usage = getUsageByTimeRange(startTime, endTime);
      expect(usage.total_requests).toBe(1);
    });

    it('should return by provider breakdown', () => {
      recordMetric('req-1', 'tenant-1', 'openai', 'gpt-4o', 100, 200, {
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15,
      });
      recordMetric('req-2', 'tenant-1', 'deepseek', 'deepseek-chat', 100, 200, {
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15,
      });

      const usage = getUsageByTimeRange(0, Date.now() + 10000);
      expect(usage.by_provider.openai).toBe(1);
      expect(usage.by_provider.deepseek).toBe(1);
    });
  });

  describe('clearMetrics', () => {
    it('should clear all metrics', () => {
      recordMetric('req-1', 'tenant-1', 'openai', 'gpt-4o', 100, 200, {
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15,
      });

      clearMetrics();
      const metrics = getAllMetrics();
      expect(metrics).toHaveLength(0);
    });
  });
});