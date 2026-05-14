/**
 * Failover 服务
 * API Key 故障自动转移和健康恢复
 * 支持内存/Redis 存储
 */
import { getProviderConfig, getConfig } from '../config';
import type { IKVStore } from '../stores/interface';
import { createKVStore } from '../stores/factory';
import { writeLog } from '../middleware/logger';

/**
 * Failover 配置
 */
export interface FailoverConfig {
  enabled: boolean;
  failureThreshold: number; // 连续失败次数触发 failover
  successThreshold: number; // 健康检测成功次数恢复
  healthCheckInterval: number; // 健康检测间隔 (ms)
  healthCheckTimeout: number; // 健康检测超时 (ms)
  healthCheckModel: string; // 健康检测使用的模型
}

/**
 * Token 健康状态
 */
interface TokenHealth {
  failureCount: number;
  successCount: number;
  lastFailure: number;
  isHealthy: boolean;
  isChecking: boolean;
}

/**
 * 故障转移结果
 */
export interface FailoverResult {
  success: boolean;
  provider: string;
  error?: string;
  attempts: number;
}

/**
 * Failover 管理器
 */
class FailoverManager {
  private tokenHealth = new Map<string, TokenHealth>();
  private config: FailoverConfig;
  private healthCheckTimers = new Map<string, NodeJS.Timeout>();
  private store: IKVStore | null = null;
  private useStorage = false;

  constructor() {
    const appConfig = getConfig();
    this.config = {
      enabled: false,
      failureThreshold: 3,
      successThreshold: 2,
      healthCheckInterval: 60000,
      healthCheckTimeout: 5000,
      healthCheckModel: 'gpt-4o-mini',
      ...appConfig.failover,
    };

    // 初始化存储
    this.useStorage = process.env.FAILOVER_STORAGE === 'redis';
    if (this.useStorage) {
      this.store = createKVStore('failover');
    }
  }

  async initStorage(): Promise<void> {
    if (this.useStorage && this.store) {
      await this.store.connect();
      // 从存储加载健康状态
      await this.loadHealthState();
    }
  }

  /**
   * 从存储加载健康状态
   */
  private async loadHealthState(): Promise<void> {
    if (!this.store) return;

    try {
      const stored = await this.store.hGetAll('health');
      for (const [key, value] of Object.entries(stored)) {
        const health = JSON.parse(value) as TokenHealth;
        this.tokenHealth.set(key, health);
      }
      writeLog('info', 'Loaded health states from storage', { count: this.tokenHealth.size });
    } catch (err) {
      writeLog('warn', 'Failed to load health state from storage, using in-memory', { error: err instanceof Error ? err.message : String(err) });
    }
  }

  /**
   * 保存健康状态到存储
   */
  private async saveHealthState(key: string, health: TokenHealth): Promise<void> {
    if (!this.store) return;

    try {
      await this.store.hSet('health', key, JSON.stringify(health));
    } catch (err) {
      writeLog('warn', 'Failed to save health state', { key, error: err instanceof Error ? err.message : String(err) });
    }
  }

  /**
   * 获取可用 Token
   */
  getAvailableToken(provider: string): { apiKey: string; index: number } | null {
    if (!this.config.enabled) {
      const config = getProviderConfig(provider);
      if (config?.api_key) {
        return { apiKey: config.api_key, index: 0 };
      }
      return null;
    }

    // 多 API Key 场景 (future: 从配置读取多个 key)
    const config = getProviderConfig(provider);
    if (!config?.api_key) return null;

    const key = `${provider}:${config.api_key.substring(0, 8)}`;
    const health = this.tokenHealth.get(key);

    if (!health || health.isHealthy) {
      return { apiKey: config.api_key, index: 0 };
    }

    return null; // 当前 key 不健康
  }

  /**
   * 记录请求失败
   */
  recordFailure(provider: string, apiKey: string): void {
    const key = `${provider}:${apiKey.substring(0, 8)}`;
    let health = this.tokenHealth.get(key);

    if (!health) {
      health = {
        failureCount: 0,
        successCount: 0,
        lastFailure: Date.now(),
        isHealthy: true,
        isChecking: false,
      };
    }

    health.failureCount++;
    health.lastFailure = Date.now();

    // 超过阈值，标记为不健康
    if (health.failureCount >= this.config.failureThreshold) {
      health.isHealthy = false;
      health.successCount = 0;
      this.startHealthCheck(provider, apiKey);
    }

    this.tokenHealth.set(key, health);
    // 持久化状态
    this.saveHealthState(key, health);
  }

  /**
   * 记录请求成功
   */
  recordSuccess(provider: string, apiKey: string): void {
    const key = `${provider}:${apiKey.substring(0, 8)}`;
    const health = this.tokenHealth.get(key);

    if (!health) return;

    health.successCount++;
    health.failureCount = 0;

    // 达到恢复阈值，恢复健康状态
    if (health.successCount >= this.config.successThreshold) {
      health.isHealthy = true;
      this.stopHealthCheck(key);
    }

    this.tokenHealth.set(key, health);
    // 持久化状态
    this.saveHealthState(key, health);
  }

  /**
   * 启动健康检查
   */
  private startHealthCheck(provider: string, apiKey: string): void {
    const key = `${provider}:${apiKey.substring(0, 8)}`;

    // 已有检查中
    if (this.healthCheckTimers.has(key)) return;

    writeLog('info', 'Starting health check', { provider });

    // 定时健康检查
    const timer = setInterval(async () => {
      await this.performHealthCheck(provider, apiKey);
    }, this.config.healthCheckInterval);

    this.healthCheckTimers.set(key, timer);

    // 立即执行一次
    this.performHealthCheck(provider, apiKey);
  }

  /**
   * 执行健康检查
   */
  private async performHealthCheck(provider: string, apiKey: string): Promise<void> {
    const key = `${provider}:${apiKey.substring(0, 8)}`;
    const health = this.tokenHealth.get(key);

    if (!health || health.isChecking) return;

    health.isChecking = true;
    this.tokenHealth.set(key, health);

    try {
      // 简单的健康检查请求
      // 这里使用简单的请求来验证 token 有效性
      const config = getProviderConfig(provider);
      if (!config) {
        this.markUnhealthy(key);
        return;
      }

      const response = await fetch(`${config.base_url}/models`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
        },
        signal: AbortSignal.timeout(this.config.healthCheckTimeout),
      });

      if (response.ok) {
        // 健康检查成功
        const updatedHealth = this.tokenHealth.get(key);
        if (updatedHealth) {
          updatedHealth.isChecking = false;
          updatedHealth.successCount++;
          if (updatedHealth.successCount >= this.config.successThreshold) {
            updatedHealth.isHealthy = true;
            updatedHealth.failureCount = 0;
            this.stopHealthCheck(key);
            writeLog('info', 'Token recovered', { provider });
          }
          this.tokenHealth.set(key, updatedHealth);
        }
      } else {
        this.markUnhealthy(key);
      }
    } catch {
      this.markUnhealthy(key);
    }
  }

  /**
   * 标记为不健康
   */
  private markUnhealthy(key: string): void {
    const health = this.tokenHealth.get(key);
    if (health) {
      health.isChecking = false;
      health.failureCount++;
      this.tokenHealth.set(key, health);
    }
  }

  /**
   * 停止健康检查
   */
  private stopHealthCheck(key: string): void {
    const timer = this.healthCheckTimers.get(key);
    if (timer) {
      clearInterval(timer);
      this.healthCheckTimers.delete(key);
    }
  }

  /**
   * 获取健康状态
   */
  getHealthStatus(): Record<string, { isHealthy: boolean; failureCount: number }> {
    const status: Record<string, { isHealthy: boolean; failureCount: number }> = {};

    this.tokenHealth.forEach((health, key) => {
      status[key] = {
        isHealthy: health.isHealthy,
        failureCount: health.failureCount,
      };
    });

    return status;
  }

  /**
   * 重置所有状态
   */
  reset(): void {
    this.tokenHealth.clear();
    this.healthCheckTimers.forEach((timer) => clearInterval(timer));
    this.healthCheckTimers.clear();
  }
}

// 单例
export const failoverManager = new FailoverManager();

// 便捷函数
export function getFailoverConfig(): FailoverConfig {
  return failoverManager['config'];
}