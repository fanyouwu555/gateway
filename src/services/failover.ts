/**
 * Failover 服务
 * API Key 故障自动转移和健康恢复
 * 支持内存/Redis 存储
 */
import { getProviderConfig, getConfig } from '../config';
import type { IKVStore } from '../stores/interface';
import { createKVStore } from '../stores/factory';
import { writeLog } from '../utils/logger';
import { fetchWithAgent } from '../utils/http-client';

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
  /** Explicit failover chains: primary -> [fallback1, fallback2, ...] */
  chains?: Record<string, string[]>;
  /** Error-rate threshold (0-1) that triggers provider-level degradation. Default 0.5 */
  errorRateThreshold?: number;
  /** Average-latency threshold (ms) that triggers degradation. Default 30000 */
  latencyThresholdMs?: number;
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
 * Provider-level health state
 */
interface ProviderHealth {
  total_requests: number;
  error_count: number;
  total_latency_ms: number;
  consecutive_failures: number;
  consecutive_successes: number;
  last_failure: number;
  last_success: number;
  is_healthy: boolean;
  is_checking: boolean;
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
  private providerHealth = new Map<string, ProviderHealth>();
  private providerCheckTimers = new Map<string, NodeJS.Timeout>();
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
      await this.loadProviderHealthState();
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
   * Save provider health state to storage
   */
  private async saveProviderHealthState(provider: string, health: ProviderHealth): Promise<void> {
    if (!this.store) return;
    try {
      await this.store.hSet('provider_health', provider, JSON.stringify(health));
    } catch (err) {
      writeLog('warn', 'Failed to save provider health state', {
        provider,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Load provider health states from storage
   */
  private async loadProviderHealthState(): Promise<void> {
    if (!this.store) return;
    try {
      const stored = await this.store.hGetAll('provider_health');
      for (const [key, value] of Object.entries(stored)) {
        this.providerHealth.set(key, JSON.parse(value) as ProviderHealth);
      }
      writeLog('info', 'Loaded provider health states from storage', { count: this.providerHealth.size });
    } catch (err) {
      writeLog('warn', 'Failed to load provider health state from storage', {
        error: err instanceof Error ? err.message : String(err),
      });
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
   * Record a provider-level request result
   */
  recordProviderRequest(provider: string, success: boolean, latencyMs: number): void {
    let health = this.providerHealth.get(provider);
    if (!health) {
      health = {
        total_requests: 0,
        error_count: 0,
        total_latency_ms: 0,
        consecutive_failures: 0,
        consecutive_successes: 0,
        last_failure: 0,
        last_success: 0,
        is_healthy: true,
        is_checking: false,
      };
    }

    health.total_requests++;
    health.total_latency_ms += latencyMs;

    if (success) {
      health.consecutive_successes++;
      health.consecutive_failures = 0;
      health.last_success = Date.now();
    } else {
      health.consecutive_failures++;
      health.consecutive_successes = 0;
      health.error_count++;
      health.last_failure = Date.now();
    }

    const errorRate = health.total_requests > 0 ? health.error_count / health.total_requests : 0;
    const avgLatency = health.total_requests > 0 ? health.total_latency_ms / health.total_requests : 0;

    if (health.is_healthy) {
      if (
        health.consecutive_failures >= this.config.failureThreshold ||
        errorRate >= (this.config.errorRateThreshold ?? 0.5) ||
        avgLatency > (this.config.latencyThresholdMs ?? 30000)
      ) {
        health.is_healthy = false;
        health.consecutive_successes = 0;
        this.startProviderHealthCheck(provider);
        writeLog('warn', 'Provider marked unhealthy', {
          provider,
          errorRate: Math.round(errorRate * 10000) / 10000,
          avgLatencyMs: Math.round(avgLatency),
          consecutiveFailures: health.consecutive_failures,
        });
      }
    } else {
      if (health.consecutive_successes >= this.config.successThreshold) {
        health.is_healthy = true;
        health.consecutive_failures = 0;
        this.stopProviderHealthCheck(provider);
        writeLog('info', 'Provider recovered', { provider });
      }
    }

    this.providerHealth.set(provider, health);
    this.saveProviderHealthState(provider, health);
  }

  /**
   * Check if a provider is healthy at the provider level
   */
  isProviderHealthy(provider: string): boolean {
    if (!this.config.enabled) return true;
    const health = this.providerHealth.get(provider);
    if (!health) return true;
    return health.is_healthy;
  }

  /**
   * Get provider-level health status summary
   */
  getProviderHealthStatus(): Record<string, { isHealthy: boolean; totalRequests: number; errorRate: number; avgLatencyMs: number }> {
    const status: Record<string, { isHealthy: boolean; totalRequests: number; errorRate: number; avgLatencyMs: number }> = {};
    this.providerHealth.forEach((health, key) => {
      const errorRate = health.total_requests > 0 ? health.error_count / health.total_requests : 0;
      const avgLatency = health.total_requests > 0 ? health.total_latency_ms / health.total_requests : 0;
      status[key] = {
        isHealthy: health.is_healthy,
        totalRequests: health.total_requests,
        errorRate: Math.round(errorRate * 10000) / 10000,
        avgLatencyMs: Math.round(avgLatency),
      };
    });
    return status;
  }

  /**
   * Get the explicit failover chain for a provider
   */
  getFailoverChain(provider: string): string[] {
    const chains = this.config.chains;
    if (chains && chains[provider]) {
      return chains[provider];
    }
    // Fallback: return all other configured providers
    const appConfig = getConfig();
    return Object.keys(appConfig.providers).filter((p) => p !== provider);
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

      const response = await fetchWithAgent(`${config.base_url}/models`, {
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
   * Start periodic health check for an unhealthy provider
   */
  private startProviderHealthCheck(provider: string): void {
    if (this.providerCheckTimers.has(provider)) return;

    writeLog('info', 'Starting provider health check', { provider });

    const timer = setInterval(async () => {
      await this.performProviderHealthCheck(provider);
    }, this.config.healthCheckInterval);

    this.providerCheckTimers.set(provider, timer);
    this.performProviderHealthCheck(provider);
  }

  /**
   * Execute a provider-level health check
   */
  private async performProviderHealthCheck(provider: string): Promise<void> {
    const health = this.providerHealth.get(provider);
    if (!health || health.is_healthy || health.is_checking) return;

    health.is_checking = true;

    try {
      const config = getProviderConfig(provider);
      if (!config) {
        this.markProviderUnhealthy(provider);
        return;
      }

      const response = await fetch(`${config.base_url}/models`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${config.api_key}`,
        },
        signal: AbortSignal.timeout(this.config.healthCheckTimeout),
      });

      if (response.ok) {
        const updated = this.providerHealth.get(provider);
        if (updated) {
          updated.is_checking = false;
          updated.consecutive_successes++;
          if (updated.consecutive_successes >= this.config.successThreshold) {
            updated.is_healthy = true;
            updated.consecutive_failures = 0;
            this.stopProviderHealthCheck(provider);
            writeLog('info', 'Provider recovered via health check', { provider });
          }
          this.providerHealth.set(provider, updated);
          this.saveProviderHealthState(provider, updated);
        }
      } else {
        this.markProviderUnhealthy(provider);
      }
    } catch {
      this.markProviderUnhealthy(provider);
    }
  }

  /**
   * Mark a provider as still unhealthy during a check
   */
  private markProviderUnhealthy(provider: string): void {
    const health = this.providerHealth.get(provider);
    if (health) {
      health.is_checking = false;
      health.consecutive_failures++;
      this.providerHealth.set(provider, health);
      this.saveProviderHealthState(provider, health);
    }
  }

  /**
   * Stop provider health check timer
   */
  private stopProviderHealthCheck(provider: string): void {
    const timer = this.providerCheckTimers.get(provider);
    if (timer) {
      clearInterval(timer);
      this.providerCheckTimers.delete(provider);
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
    this.providerHealth.clear();
    this.providerCheckTimers.forEach((timer) => clearInterval(timer));
    this.providerCheckTimers.clear();
  }
}

// 单例
export const failoverManager = new FailoverManager();

// 便捷函数
export function getFailoverConfig(): FailoverConfig {
  return failoverManager['config'];
}