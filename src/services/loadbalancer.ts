/**
 * 负载均衡服务
 * 支持多 API Key/Provider 的负载分配
 */
import { getProviderConfig, getConfig } from '../config';

/**
 * 负载均衡策略
 */
export type LoadBalanceStrategy = 'roundRobin' | 'random' | 'weighted' | 'leastRequest';

/**
 * 负载均衡配置
 */
export interface LoadBalanceConfig {
  strategy: LoadBalanceStrategy;
  providers: Record<string, ProviderWeight>;
}

/**
 * Provider 权重配置
 */
export interface ProviderWeight {
  weight: number; // 权重值
  maxRps?: number; // 最大请求速率
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
  private tokenIndex = new Map<string, number>(); // provider -> current index
  private providerWeights: Record<string, ProviderWeight> = {};
  private tokenRps = new Map<string, number>(); // tokenKey -> current rps

  constructor() {
    const config = getConfig();
    if (config.loadBalance) {
      this.strategy = config.loadBalance.strategy || 'roundRobin';
      this.providerWeights = config.loadBalance.providers || {};
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

    // 单 Key 直接返回
    if (availableKeys.length === 1) {
      return {
        provider,
        apiKey: availableKeys[0],
        keyIndex: 0,
      };
    }

    // 多 Key 根据策略选择
    switch (this.strategy) {
      case 'roundRobin':
        return this.roundRobinSelect(provider, availableKeys);
      case 'random':
        return this.randomSelect(provider, availableKeys);
      case 'weighted':
        return this.weightedSelect(provider, availableKeys);
      case 'leastRequest':
        return this.leastRequestSelect(provider, availableKeys);
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
   * 权重选择
   */
  private weightedSelect(provider: string, keys: string[]): LoadBalanceResult {
    const weightConfig = this.providerWeights[provider];

    if (!weightConfig || keys.length === 1) {
      return this.roundRobinSelect(provider, keys);
    }

    // 计算权重区间
    const totalWeight = weightConfig.weight * keys.length;
    const random = Math.random() * totalWeight;
    const selectedIndex = Math.floor(random / weightConfig.weight);

    return {
      provider,
      apiKey: keys[selectedIndex % keys.length],
      keyIndex: selectedIndex % keys.length,
    };
  }

  /**
   * 最少请求选择
   */
  private leastRequestSelect(provider: string, keys: string[]): LoadBalanceResult {
    let minRps = Infinity;
    let selectedIndex = 0;

    for (let i = 0; i < keys.length; i++) {
      const key = `${provider}:${keys[i].substring(0, 8)}`;
      const rps = this.tokenRps.get(key) || 0;

      if (rps < minRps) {
        minRps = rps;
        selectedIndex = i;
      }
    }

    return {
      provider,
      apiKey: keys[selectedIndex],
      keyIndex: selectedIndex,
    };
  }

  /**
   * 记录请求完成 (用于 leastRequest 策略)
   */
  recordRequest(provider: string, apiKey: string): void {
    const key = `${provider}:${apiKey.substring(0, 8)}`;
    const current = this.tokenRps.get(key) || 0;
    this.tokenRps.set(key, current + 1);

    // 简单滑动窗口 - 每秒重置
    setTimeout(() => {
      const rps = this.tokenRps.get(key) || 1;
      this.tokenRps.set(key, Math.max(0, rps - 1));
    }, 1000);
  }

  /**
   * 批量选择 (用于多 Provider 场景)
   */
  selectProviders(
    providers: string[],
    weights?: Record<string, number>
  ): LoadBalanceResult[] {
    if (providers.length === 0) return [];

    if (providers.length === 1) {
      const config = getProviderConfig(providers[0]);
      if (!config?.api_key) return [];
      return [{ provider: providers[0], apiKey: config.api_key, keyIndex: 0 }];
    }

    // 按权重排序
    const sorted = [...providers].sort((a, b) => {
      const weightA = weights?.[a] || 1;
      const weightB = weights?.[b] || 1;
      return weightB - weightA;
    });

    const results: LoadBalanceResult[] = [];
    for (const provider of sorted) {
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
    this.tokenRps.clear();
  }
}

// 单例
export const loadBalanceManager = new LoadBalanceManager();

// 便捷函数
export function getLoadBalanceStrategy(): LoadBalanceStrategy {
  return loadBalanceManager.getStrategy();
}