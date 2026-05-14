/**
 * 负载均衡服务测试
 */
import { loadBalanceManager } from '../../src/../src/services/loadbalancer';
import type { IProviderConfig } from '../../src/types';

// 模拟 config
jest.mock('../../src/config', () => ({
  getConfig: () => ({
    loadBalance: {
      strategy: 'roundRobin',
      providers: {
        openai: { weight: 2 },
        deepseek: { weight: 1 },
      },
    },
  }),
  getProviderConfig: (name: string) => {
    const config: Record<string, IProviderConfig> = {
      openai: {
        provider: 'openai',
        base_url: 'https://api.openai.com/v1',
        api_key: 'sk-key-1',
      },
      deepseek: {
        provider: 'deepseek',
        base_url: 'https://api.deepseek.com/v1',
        api_key: 'sk-key-2',
      },
      anthropic: {
        provider: 'anthropic',
        base_url: 'https://api.anthropic.com',
        api_key: 'sk-key-3',
      },
    };
    return config[name];
  },
}));

describe('LoadBalanceManager', () => {
  beforeEach(() => {
    loadBalanceManager.reset();
    loadBalanceManager.setStrategy('roundRobin'); // Reset strategy
  });

  describe('selectToken', () => {
    it('should return null for empty keys', () => {
      const result = loadBalanceManager.selectToken('openai', []);
      expect(result).toBeNull();
    });

    it('should return single key directly', () => {
      const result = loadBalanceManager.selectToken('openai', ['sk-key-1']);
      expect(result).not.toBeNull();
      expect(result?.provider).toBe('openai');
      expect(result?.apiKey).toBe('sk-key-1');
      expect(result?.keyIndex).toBe(0);
    });

    it('should distribute keys in round robin', () => {
      const keys = ['sk-key-1', 'sk-key-2', 'sk-key-3'];

      const results = [];
      for (let i = 0; i < 6; i++) {
        const result = loadBalanceManager.selectToken('openai', keys);
        if (result) results.push(result.apiKey);
      }

      // 应该均匀分布
      expect(results[0]).toBe('sk-key-1');
      expect(results[1]).toBe('sk-key-2');
      expect(results[2]).toBe('sk-key-3');
      expect(results[3]).toBe('sk-key-1');
      expect(results[4]).toBe('sk-key-2');
      expect(results[5]).toBe('sk-key-3');
    });

    it('should work with random strategy', () => {
      loadBalanceManager.setStrategy('random');
      const keys = ['sk-key-1', 'sk-key-2', 'sk-key-3'];

      const results = new Set<string>();
      for (let i = 0; i < 100; i++) {
        const result = loadBalanceManager.selectToken('openai', keys);
        if (result) results.add(result.apiKey);
      }

      // 随机策略应该能选到不同的 key
      expect(results.size).toBeGreaterThanOrEqual(2);
    });
  });

  describe('getStrategy', () => {
    it('should return current strategy', () => {
      const strategy = loadBalanceManager.getStrategy();
      expect(strategy).toBe('roundRobin');
    });
  });

  describe('setStrategy', () => {
    it('should change strategy', () => {
      loadBalanceManager.setStrategy('random');
      expect(loadBalanceManager.getStrategy()).toBe('random');

      loadBalanceManager.setStrategy('leastRequest');
      expect(loadBalanceManager.getStrategy()).toBe('leastRequest');
    });
  });

  describe('selectProviders', () => {
    it('should return empty for empty providers', () => {
      const result = loadBalanceManager.selectProviders([]);
      expect(result).toEqual([]);
    });

    it('should return single provider', () => {
      const result = loadBalanceManager.selectProviders(['openai']);
      expect(result.length).toBe(1);
      expect(result[0].provider).toBe('openai');
    });

    it('should return multiple providers sorted by weight', () => {
      const result = loadBalanceManager.selectProviders(
        ['openai', 'deepseek', 'anthropic'],
        { openai: 2, deepseek: 1, anthropic: 1 }
      );

      // openai 权重最高应该在前面
      expect(result[0].provider).toBe('openai');
    });
  });

  describe('recordRequest', () => {
    it('should track request count', () => {
      loadBalanceManager.setStrategy('leastRequest');
      const keys = ['sk-key-1', 'sk-key-2'];

      // 记录请求
      loadBalanceManager.recordRequest('openai', 'sk-key-1');
      loadBalanceManager.recordRequest('openai', 'sk-key-1');

      // leastRequest 应该选择 key-2 (请求更少)
      const result = loadBalanceManager.selectToken('openai', keys);
      expect(result?.apiKey).toBe('sk-key-2');
    });
  });

  describe('reset', () => {
    it('should clear all state', () => {
      loadBalanceManager.selectToken('openai', ['sk-key-1', 'sk-key-2']);
      loadBalanceManager.reset();

      // 重置后重新选择
      const result = loadBalanceManager.selectToken('openai', ['sk-key-1', 'sk-key-2']);
      expect(result?.keyIndex).toBe(0);
    });
  });
});

import { getLoadBalanceStrategy } from '../../src/../src/services/loadbalancer';

describe('getLoadBalanceStrategy', () => {
  it('should return strategy', () => {
    const strategy = getLoadBalanceStrategy();
    expect(strategy).toBeDefined();
  });
});