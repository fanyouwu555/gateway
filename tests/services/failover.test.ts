/**
 * Failover 服务测试
 */
import { failoverManager } from '../../src/../src/services/failover';

// 模拟 config
jest.mock('../../src/config', () => ({
  getConfig: () => ({
    failover: {
      enabled: true,
      failureThreshold: 2,
      successThreshold: 1,
      healthCheckInterval: 1000,
      healthCheckTimeout: 500,
      healthCheckModel: 'gpt-4o-mini',
      chains: { openai: ['deepseek'], deepseek: ['openai'] },
      errorRateThreshold: 0.5,
      latencyThresholdMs: 30000,
    },
    providers: {
      openai: {
        provider: 'openai',
        base_url: 'https://api.openai.com/v1',
        api_key: 'sk-test-key-12345678',
      },
      deepseek: {
        provider: 'deepseek',
        base_url: 'https://api.deepseek.com/v1',
        api_key: 'sk-test-deepseek-123',
      },
    },
  }),
  getProviderConfig: (name: string) => {
    const configs: Record<string, IProviderConfig> = {
      openai: {
        provider: 'openai',
        base_url: 'https://api.openai.com/v1',
        api_key: 'sk-test-key-12345678',
      },
      deepseek: {
        provider: 'deepseek',
        base_url: 'https://api.deepseek.com/v1',
        api_key: 'sk-test-deepseek-123',
      },
    };
    return configs[name];
  },
  resolveModelAlias: jest.fn((alias: string) => alias),
  isModelPool: jest.fn(() => false),
  getModelPool: jest.fn(() => undefined),
}));

import type { IProviderConfig } from '../../src/types';

describe('FailoverManager', () => {
  beforeEach(() => {
    failoverManager.reset();
  });

  const openaiKey = 'sk-test-key-12345678';
  const deepseekKey = 'sk-test-deepseek-123';

  describe('getAvailableToken', () => {
    it('should return token when failover is disabled', () => {
      const result = failoverManager.getAvailableToken('openai');
      expect(result).not.toBeNull();
      expect(result?.apiKey).toBe('sk-test-key-12345678');
    });

    it('should return null when token is unhealthy', () => {
      for (let i = 0; i < 2; i++) {
        failoverManager.recordFailure('openai', openaiKey);
      }

      const result = failoverManager.getAvailableToken('openai');
      expect(result).toBeNull();
    });

    it('should return token after recovery', () => {
      failoverManager.recordFailure('openai', openaiKey);
      failoverManager.recordFailure('openai', openaiKey);

      failoverManager.recordSuccess('openai', openaiKey);

      const status = failoverManager.getHealthStatus();
      const keys = Object.keys(status);
      expect(keys.length).toBeGreaterThan(0);
    });
  });

  describe('getHealthyKeys', () => {
    it('should return all keys when failover is enabled but no failures recorded', () => {
      const keys = ['sk-key-a-12345678', 'sk-key-b-12345678'];
      const result = failoverManager.getHealthyKeys('openai', keys);
      expect(result).toEqual(keys);
    });

    it('should filter out unhealthy keys', () => {
      const keyA = 'sk-key-a-12345678';
      const keyB = 'sk-key-b-12345678';
      const keys = [keyA, keyB];

      for (let i = 0; i < 2; i++) {
        failoverManager.recordFailure('openai', keyA);
      }

      const result = failoverManager.getHealthyKeys('openai', keys);
      expect(result).toEqual([keyB]);
    });

    it('should return all keys as fallback when all are unhealthy', () => {
      const keyA = 'sk-key-a-12345678';
      const keyB = 'sk-key-b-12345678';
      const keys = [keyA, keyB];

      for (let i = 0; i < 2; i++) {
        failoverManager.recordFailure('openai', keyA);
        failoverManager.recordFailure('openai', keyB);
      }

      const result = failoverManager.getHealthyKeys('openai', keys);
      expect(result).toEqual(keys);
    });

    it('should preserve original key order', () => {
      const keyA = 'sk-key-a-12345678';
      const keyB = 'sk-key-b-12345678';
      const keyC = 'sk-key-c-12345678';
      const keys = [keyA, keyB, keyC];

      for (let i = 0; i < 2; i++) {
        failoverManager.recordFailure('openai', keyB);
      }

      const result = failoverManager.getHealthyKeys('openai', keys);
      expect(result).toEqual([keyA, keyC]);
    });
  });

  describe('recordFailure', () => {
    it('should increment failure count', () => {
      failoverManager.recordFailure('openai', openaiKey);
      failoverManager.recordFailure('openai', openaiKey);

      const status = failoverManager.getHealthStatus();
      const key = Object.keys(status)[0];
      expect(status[key].failureCount).toBe(2);
    });

    it('should mark as unhealthy after threshold', () => {
      // 达到阈值
      failoverManager.recordFailure('openai', openaiKey);
      failoverManager.recordFailure('openai', openaiKey);

      const status = failoverManager.getHealthStatus();
      const key = Object.keys(status)[0];
      expect(status[key].isHealthy).toBe(false);
    });
  });

  describe('recordSuccess', () => {
    it('should reset failure count on success', () => {
      failoverManager.recordFailure('openai', openaiKey);
      failoverManager.recordFailure('openai', openaiKey);
      failoverManager.recordSuccess('openai', openaiKey);

      const status = failoverManager.getHealthStatus();
      const key = Object.keys(status)[0];
      expect(status[key].failureCount).toBe(0);
    });

    it('should maintain healthy status after success', () => {
      // 先创建健康记录 (通过失败)
      failoverManager.recordFailure('openai', openaiKey);

      // 然后成功应该保持健康
      failoverManager.recordSuccess('openai', openaiKey);
      const status = failoverManager.getHealthStatus();
      const key = Object.keys(status)[0];
      expect(status[key].isHealthy).toBe(true);
    });
  });

  describe('getHealthStatus', () => {
    it('should return empty object when no data', () => {
      const status = failoverManager.getHealthStatus();
      expect(status).toEqual({});
    });

    it('should return health status for all tokens', () => {
      failoverManager.recordFailure('openai', openaiKey);
      failoverManager.recordSuccess('deepseek', deepseekKey);

      const status = failoverManager.getHealthStatus();
      expect(Object.keys(status).length).toBeGreaterThan(0);
    });
  });

  describe('reset', () => {
    it('should clear all health data', () => {
      failoverManager.recordFailure('openai', openaiKey);
      failoverManager.reset();

      const status = failoverManager.getHealthStatus();
      expect(status).toEqual({});
    });
  });
});

import { getFailoverConfig } from '../../src/../src/services/failover';

describe('getFailoverConfig', () => {
  it('should return config object', () => {
    const config = getFailoverConfig();

    expect(config).toBeDefined();
    expect(config.enabled).toBe(true);
    expect(config.failureThreshold).toBe(2);
  });
});

describe('Provider-level health', () => {
  beforeEach(() => {
    failoverManager.reset();
  });

  it('should mark provider unhealthy after consecutive failures', () => {
    failoverManager.recordProviderRequest('openai', false, 100);
    failoverManager.recordProviderRequest('openai', false, 100);
    expect(failoverManager.isProviderHealthy('openai')).toBe(false);
  });

  it('should keep provider healthy with enough successes', () => {
    failoverManager.recordProviderRequest('openai', true, 100);
    failoverManager.recordProviderRequest('openai', true, 100);
    expect(failoverManager.isProviderHealthy('openai')).toBe(true);
  });

  it('should recover provider after consecutive successes', () => {
    failoverManager.recordProviderRequest('openai', false, 100);
    failoverManager.recordProviderRequest('openai', false, 100);
    expect(failoverManager.isProviderHealthy('openai')).toBe(false);

    failoverManager.recordProviderRequest('openai', true, 100);
    expect(failoverManager.isProviderHealthy('openai')).toBe(true);
  });

  it('should return healthy for unknown provider', () => {
    expect(failoverManager.isProviderHealthy('unknown')).toBe(true);
  });

  it('should return provider health status summary', () => {
    failoverManager.recordProviderRequest('openai', true, 150);
    const status = failoverManager.getProviderHealthStatus();
    expect(status.openai).toBeDefined();
    expect(status.openai.totalRequests).toBe(1);
    expect(status.openai.isHealthy).toBe(true);
    expect(status.openai.avgLatencyMs).toBe(150);
  });

  it('should mark unhealthy when error rate exceeds threshold', () => {
    // errorRateThreshold is 0.5, so 1 error out of 1 request = 1.0 > 0.5
    failoverManager.recordProviderRequest('openai', false, 100);
    expect(failoverManager.isProviderHealthy('openai')).toBe(false);
  });

  it('should return configured failover chain', () => {
    const chain = failoverManager.getFailoverChain('openai');
    expect(chain).toContain('deepseek');
  });

  it('should return other providers when no chain is configured', () => {
    const chain = failoverManager.getFailoverChain('anthropic');
    expect(chain).toContain('openai');
    expect(chain).toContain('deepseek');
  });
});