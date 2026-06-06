/**
 * 负载均衡服务测试
 */
import { loadBalanceManager } from '../../src/../src/services/loadbalancer';
import type { IProviderConfig } from '../../src/types';

jest.mock('../../src/config', () => ({
  getConfig: () => ({
    loadBalance: {
      strategy: 'roundRobin',
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
  resolveModelAlias: jest.fn((alias: string) => alias),
}));

describe('LoadBalanceManager', () => {
  beforeEach(() => {
    loadBalanceManager.reset();
    loadBalanceManager.setStrategy('roundRobin');
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

      loadBalanceManager.setStrategy('roundRobin');
      expect(loadBalanceManager.getStrategy()).toBe('roundRobin');
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

    it('should return multiple providers', () => {
      const result = loadBalanceManager.selectProviders(['openai', 'deepseek', 'anthropic']);
      expect(result.length).toBe(3);
    });
  });

  describe('reset', () => {
    it('should clear all state', () => {
      loadBalanceManager.selectToken('openai', ['sk-key-1', 'sk-key-2']);
      loadBalanceManager.reset();

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
