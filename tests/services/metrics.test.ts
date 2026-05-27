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
  getTimeSeriesMetrics,
  getProviderStats,
  getAllTenantsStats,
  getDashboardOverview,
  getStatusCodeStats,
  getKeyUsage,
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

    it('should return default cost for unknown models', () => {
      const cost = calculateCost('unknown-model', {
        prompt_tokens: 1000,
        completion_tokens: 500,
        total_tokens: 1500,
      });
      expect(cost).toBeDefined();
      expect(cost).toBeGreaterThan(0);
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

  describe('getTimeSeriesMetrics', () => {
    it('should return aggregated time series data', () => {
      const now = Date.now();

      // 记录一些请求，时间分布在不同的小时
      recordMetric('req-1', 'tenant-1', 'openai', 'gpt-4o', 100, 200, {
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15,
      });
      recordMetric('req-2', 'tenant-1', 'openai', 'gpt-4o', 200, 200, {
        prompt_tokens: 20,
        completion_tokens: 10,
        total_tokens: 30,
      });

      const series = getTimeSeriesMetrics(now - 100000, now + 100000, 'hour');
      expect(Array.isArray(series)).toBe(true);
      expect(series.length).toBeGreaterThan(0);
      expect(series[0]).toHaveProperty('total_requests');
      expect(series[0]).toHaveProperty('total_tokens');
      expect(series[0]).toHaveProperty('success_rate');
    });
  });

  describe('getProviderStats', () => {
    it('should return provider level statistics', () => {
      recordMetric('req-1', 'tenant-1', 'openai', 'gpt-4o', 100, 200, {
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15,
      });
      recordMetric('req-2', 'tenant-1', 'deepseek', 'deepseek-chat', 150, 200, {
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15,
      });

      const stats = getProviderStats(0, Date.now() + 10000);
      expect(Array.isArray(stats)).toBe(true);
      expect(stats.length).toBe(2);
      expect(stats[0]).toHaveProperty('provider');
      expect(stats[0]).toHaveProperty('total_requests');
      expect(stats[0]).toHaveProperty('by_model');
    });
  });

  describe('getAllTenantsStats', () => {
    it('should return all tenant statistics', () => {
      recordMetric('req-1', 'tenant-1', 'openai', 'gpt-4o', 100, 200, {
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15,
      });
      recordMetric('req-2', 'tenant-2', 'openai', 'gpt-4o', 100, 200, {
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15,
      });

      const stats = getAllTenantsStats(0, Date.now() + 10000);
      expect(stats.length).toBe(2);
      expect(stats[0]).toHaveProperty('tenant_id');
      expect(stats[0]).toHaveProperty('by_provider');
      expect(stats[0]).toHaveProperty('by_model');
    });
  });

  describe('getDashboardOverview', () => {
    it('should return comprehensive dashboard statistics', () => {
      recordMetric('req-1', 'tenant-1', 'openai', 'gpt-4o', 100, 200, {
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15,
      });
      recordMetric('req-2', 'tenant-1', 'deepseek', 'deepseek-chat', 100, 500, {
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15,
      });

      const overview = getDashboardOverview(0, Date.now() + 10000);
      expect(overview).toHaveProperty('total_requests', 2);
      expect(overview).toHaveProperty('total_tokens', 30);
      expect(overview).toHaveProperty('total_cost');
      expect(overview).toHaveProperty('success_rate');
      expect(overview).toHaveProperty('total_providers', 2);
      expect(overview).toHaveProperty('total_models', 2);
      expect(overview).toHaveProperty('total_tenants', 1);
    });
  });

  describe('getStatusCodeStats', () => {
    it('should return status code distribution', () => {
      recordMetric('req-1', 'tenant-1', 'openai', 'gpt-4o', 100, 200, {
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15,
      });
      recordMetric('req-2', 'tenant-1', 'openai', 'gpt-4o', 100, 200, {
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15,
      });
      recordMetric('req-3', 'tenant-1', 'openai', 'gpt-4o', 100, 500, {
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15,
      });

      const stats = getStatusCodeStats(0, Date.now() + 10000);
      expect(stats['200']).toBe(2);
      expect(stats['500']).toBe(1);
    });
  });

  describe('recordMetric edge cases', () => {
    it('should set default cost for unknown model', () => {
      const metric = recordMetric(
        'req-1',
        'tenant-1',
        'openai',
        'unknown-model',
        100,
        200,
        { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
      );
      expect(metric.cost).toBeDefined();
      expect(metric.cost).toBeGreaterThan(0);
    });

    it('should handle undefined tenant_id', () => {
      const metric = recordMetric(
        'req-1',
        undefined,
        'openai',
        'gpt-4o',
        100,
        200,
        { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
      );
      expect(metric.tenant_id).toBe('unknown');
    });
  });

  describe('empty result edge cases', () => {
    it('should return empty time series when no metrics', () => {
      const series = getTimeSeriesMetrics(0, Date.now(), 'hour');
      expect(series).toEqual([]);
    });

    it('should return empty provider stats when no metrics', () => {
      const stats = getProviderStats(0, Date.now());
      expect(stats).toEqual([]);
    });

    it('should return empty tenant stats when no metrics', () => {
      const stats = getAllTenantsStats(0, Date.now());
      expect(stats).toEqual([]);
    });

    it('should return empty dashboard overview when no metrics', () => {
      const overview = getDashboardOverview(0, Date.now());
      expect(overview.total_requests).toBe(0);
      expect(overview.success_rate).toBe(0);
      expect(overview.total_providers).toBe(0);
    });

    it('should return empty usage by time range when no metrics', () => {
      const usage = getUsageByTimeRange(0, Date.now());
      expect(usage.total_requests).toBe(0);
      expect(usage.by_provider).toEqual({});
    });
  });

  describe('getKeyUsage', () => {
    it('should return key usage statistics', () => {
      recordMetric('req-1', 'tenant-1', 'openai', 'gpt-4o', 100, 200, {
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15,
      }, 'key-hash-1');
      recordMetric('req-2', 'tenant-1', 'openai', 'gpt-4o', 150, 200, {
        prompt_tokens: 20,
        completion_tokens: 10,
        total_tokens: 30,
      }, 'key-hash-1');

      const usage = getKeyUsage('key-hash-1');
      expect(usage.total_requests).toBe(2);
      expect(usage.total_tokens).toBe(45);
      expect(usage.last_used).toBeGreaterThan(0);
    });

    it('should return empty stats for unknown key', () => {
      const usage = getKeyUsage('unknown-key');
      expect(usage.total_requests).toBe(0);
      expect(usage.last_used).toBeNull();
    });
  });

  describe('getTimeSeriesMetrics granularities', () => {
    it('should aggregate by day', () => {
      const now = Date.now();
      recordMetric('req-1', 'tenant-1', 'openai', 'gpt-4o', 100, 200, {
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15,
      });

      const series = getTimeSeriesMetrics(now - 86400000, now + 86400000, 'day');
      expect(series.length).toBeGreaterThan(0);
      expect(series[0]).toHaveProperty('time_label');
    });

    it('should aggregate by all granularity', () => {
      const now = Date.now();
      recordMetric('req-1', 'tenant-1', 'openai', 'gpt-4o', 100, 200, {
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15,
      });
      recordMetric('req-2', 'tenant-1', 'openai', 'gpt-4o', 200, 200, {
        prompt_tokens: 20,
        completion_tokens: 10,
        total_tokens: 30,
      });

      const series = getTimeSeriesMetrics(now - 100000, now + 100000, 'all');
      expect(series.length).toBe(1);
    });
  });
});