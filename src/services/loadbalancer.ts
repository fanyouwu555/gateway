/**
 * 负载均衡服务
 * 支持多 API Key/Provider 的负载分配
 */
import { getProviderConfig, getConfig } from '../config';

/**
 * 负载均衡策略
 */
export type LoadBalanceStrategy = 'roundRobin' | 'random';

/**
 * 负载均衡配置
 */
export interface LoadBalanceConfig {
  strategy: LoadBalanceStrategy;
}

/**
 * 负载均衡结果
 */
export interface LoadBalanceResult {
  provider: string;
  apiKey: string;
  keyIndex: number;
}

/**
 * 负载均衡管理器
 */
class LoadBalanceManager {
  private strategy: LoadBalanceStrategy = 'roundRobin';
  private tokenIndex = new Map<string, number>();

  constructor() {
    const config = getConfig();
    if (config.loadBalance) {
      this.strategy = config.loadBalance.strategy || 'roundRobin';
    }
  }

  /**
   * 选择一个 Token
   * @param provider - Provider 名称
   * @param availableKeys - 可用的 API Keys 列表
   */
  selectToken(provider: string, availableKeys: string[]): LoadBalanceResult | null {
    if (availableKeys.length === 0) {
      return null;
    }

    if (availableKeys.length === 1) {
      return {
        provider,
        apiKey: availableKeys[0],
        keyIndex: 0,
      };
    }

    switch (this.strategy) {
      case 'random':
        return this.randomSelect(provider, availableKeys);
      case 'roundRobin':
      default:
        return this.roundRobinSelect(provider, availableKeys);
    }
  }

  /**
   * 轮询选择
   */
  private roundRobinSelect(provider: string, keys: string[]): LoadBalanceResult {
    const currentIndex = this.tokenIndex.get(provider) || 0;
    const selectedIndex = currentIndex % keys.length;

    this.tokenIndex.set(provider, currentIndex + 1);

    return {
      provider,
      apiKey: keys[selectedIndex],
      keyIndex: selectedIndex,
    };
  }

  /**
   * 随机选择
   */
  private randomSelect(provider: string, keys: string[]): LoadBalanceResult {
    const selectedIndex = Math.floor(Math.random() * keys.length);

    return {
      provider,
      apiKey: keys[selectedIndex],
      keyIndex: selectedIndex,
    };
  }

  /**
   * 批量选择 (用于多 Provider 场景)
   */
  selectProviders(providers: string[]): LoadBalanceResult[] {
    if (providers.length === 0) return [];

    if (providers.length === 1) {
      const config = getProviderConfig(providers[0]);
      if (!config?.api_key) return [];
      return [{ provider: providers[0], apiKey: config.api_key, keyIndex: 0 }];
    }

    const results: LoadBalanceResult[] = [];
    for (const provider of providers) {
      const config = getProviderConfig(provider);
      if (config?.api_key) {
        results.push({ provider, apiKey: config.api_key, keyIndex: 0 });
      }
    }

    return results;
  }

  /**
   * 获取当前策略
   */
  getStrategy(): LoadBalanceStrategy {
    return this.strategy;
  }

  /**
   * 设置策略
   */
  setStrategy(strategy: LoadBalanceStrategy): void {
    this.strategy = strategy;
  }

  /**
   * 重置状态
   */
  reset(): void {
    this.tokenIndex.clear();
  }
}

// 单例
export const loadBalanceManager = new LoadBalanceManager();

// 便捷函数
export function getLoadBalanceStrategy(): LoadBalanceStrategy {
  return loadBalanceManager.getStrategy();
}
