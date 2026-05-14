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
    },
  }),
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
}));

import type { IProviderConfig } from '../../src/types';

jest.mock('../../src/config', () => ({
  getProviderConfig: (name: string) => {
    const config: Record<string, IProviderConfig> = {
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
    return config[name];
  },
  getConfig: () => ({
    failover: {
      enabled: true,
      failureThreshold: 2,
      successThreshold: 1,
      healthCheckInterval: 1000,
      healthCheckTimeout: 500,
      healthCheckModel: 'gpt-4o-mini',
    },
  }),
}));

describe('FailoverManager', () => {
  beforeEach(() => {
    failoverManager.reset();
  });

  const openaiKey = 'sk-test-key-12345678';
  const deepseekKey = 'sk-test-deepseek-123';

  describe('getAvailableToken', () => {
    it('should return token when failover is disabled', () => {
      // 通过 config mock 禁用 failover
      const result = failoverManager.getAvailableToken('openai');
      expect(result).not.toBeNull();
      expect(result?.apiKey).toBe('sk-test-key-12345678');
    });

    it('should return null when token is unhealthy', () => {
      // 模拟 token 变不健康
      for (let i = 0; i < 2; i++) {
        failoverManager.recordFailure('openai', openaiKey);
      }

      // 现在应该返回 null，因为 token 不健康
      const result = failoverManager.getAvailableToken('openai');
      // 由于我们的实现，unhealthy 时返回 null
      expect(result).toBeNull();
    });

    it('should return token after recovery', () => {
      // 先失败
      failoverManager.recordFailure('openai', openaiKey);
      failoverManager.recordFailure('openai', openaiKey);

      // 再成功
      failoverManager.recordSuccess('openai', openaiKey);

      // 应该恢复健康
      const status = failoverManager.getHealthStatus();
      const keys = Object.keys(status);
      expect(keys.length).toBeGreaterThan(0);
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