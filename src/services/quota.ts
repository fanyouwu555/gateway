/**
 * 配额管理服务
 * 监控和限制租户的资源使用
 * 支持内存存储（默认）和 Redis 持久化（可选）
 */
import type { TenantId } from '../types';
import { getTenantUsage } from './metrics';
import { getConfig } from '../config';
import { writeLog } from '../utils/logger';
import { createKVStore } from '../stores/factory';

/**
 * 配额检查结果
 */
export interface QuotaCheckResult {
  allowed: boolean;
  remaining_requests?: number;
  remaining_tokens?: number;
  remaining_cost?: number;
  reason?: string;
}

/**
 * 配额存储
 * 支持内存存储 + 可选 Redis 持久化
 */
class QuotaStore {
  private quotas = new Map<
    TenantId,
    {
      daily_requests: number;
      daily_tokens: number;
      monthly_cost: number;
      last_reset: number;
    }
  >();

  // 按 Key 维度的月度花费追踪
  private keyMonthlyCosts = new Map<string, { cost: number; last_reset: number }>();

  // 单独存储自定义限制
  private limits = new Map<
    TenantId,
    { daily_requests?: number; daily_tokens?: number; monthly_cost?: number }
  >();

  private useRedis = false;

  constructor() {
    this.useRedis = process.env.QUOTA_STORAGE === 'redis';
  }

  /**
   * 获取配额
   */
  get(tenantId: TenantId): {
    daily_requests: number;
    daily_tokens: number;
    monthly_cost: number;
    last_reset: number;
  } {
    let quota = this.quotas.get(tenantId);

    if (!quota) {
      quota = {
        daily_requests: 0,
        daily_tokens: 0,
        monthly_cost: 0,
        last_reset: Date.now(),
      };
      this.quotas.set(tenantId, quota);
    }

    return quota;
  }

  /**
   * 增加使用量
   */
  increment(
    tenantId: TenantId,
    tokens: number,
    cost: number,
    keyHash?: string
  ): void {
    const quota = this.get(tenantId);
    quota.daily_requests += 1;
    quota.daily_tokens += tokens;
    quota.monthly_cost += cost;

    // 按 Key 维度追踪月度花费
    if (keyHash) {
      let keyCost = this.keyMonthlyCosts.get(keyHash);
      if (!keyCost) {
        keyCost = { cost: 0, last_reset: Date.now() };
        this.keyMonthlyCosts.set(keyHash, keyCost);
      }
      keyCost.cost += cost;
    }

    // 异步持久化到 Redis（fire-and-forget）
    if (this.useRedis) {
      this.persist(tenantId).catch(() => {
        // 忽略持久化失败
      });
    }
  }

  /**
   * 将租户配额持久化到 Redis
   */
  private async persist(tenantId: TenantId): Promise<void> {
    try {
      const store = createKVStore('quota');
      await store.connect();
      const quota = this.quotas.get(tenantId);
      if (quota) {
        await store.set(`quota:${tenantId}`, JSON.stringify(quota));
      }
    } catch {
      // 持久化失败不影响主流程
    }
  }

  /**
   * 从 Redis 加载租户配额
   */
  async loadFromStorage(): Promise<void> {
    if (!this.useRedis) return;
    try {
      const store = createKVStore('quota');
      await store.connect();
      const keys = await store.keys('quota:*');
      for (const key of keys) {
        const tenantId = key.replace('quota:', '');
        const data = await store.get(key);
        if (data) {
          try {
            const quota = JSON.parse(data) as {
              daily_requests: number;
              daily_tokens: number;
              monthly_cost: number;
              last_reset: number;
            };
            this.quotas.set(tenantId, quota);
          } catch {
            // 忽略解析失败的条目
          }
        }
      }
      writeLog('info', 'Quota loaded from Redis', { count: keys.length });
    } catch (err) {
      writeLog('warn', 'Failed to load quota from Redis', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * 将所有配额 flush 到 Redis
   */
  async flushToStorage(): Promise<void> {
    if (!this.useRedis) return;
    try {
      const store = createKVStore('quota');
      await store.connect();
      for (const [tenantId, quota] of this.quotas.entries()) {
        await store.set(`quota:${tenantId}`, JSON.stringify(quota));
      }
    } catch (err) {
      writeLog('warn', 'Failed to flush quota to Redis', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * 重置日配额
   */
  resetDaily(tenantId: TenantId): void {
    const quota = this.get(tenantId);
    quota.daily_requests = 0;
    quota.daily_tokens = 0;
  }

  /**
   * 重置月配额
   */
  resetMonthly(tenantId: TenantId): void {
    const quota = this.get(tenantId);
    quota.monthly_cost = 0;
  }

  /**
   * 设置自定义限制
   */
  setLimits(
    tenantId: TenantId,
    limits: {
      daily_requests?: number;
      daily_tokens?: number;
      monthly_cost?: number;
    }
  ): void {
    this.limits.set(tenantId, limits);
  }

  /**
   * 获取限制（如果有）
   */
  getLimits(tenantId: TenantId): {
    daily_requests?: number;
    daily_tokens?: number;
    monthly_cost?: number;
  } | null {
    return this.limits.get(tenantId) || null;
  }

  /**
   * 检查 Key 级月度预算
   */
  checkKeyBudget(keyHash: string, monthlyBudget: number): { allowed: boolean; current_cost: number; reason?: string } {
    const keyCost = this.keyMonthlyCosts.get(keyHash);
    const currentCost = keyCost?.cost || 0;

    if (currentCost >= monthlyBudget) {
      return { allowed: false, current_cost: currentCost, reason: 'Key monthly budget exceeded' };
    }

    return { allowed: true, current_cost: currentCost };
  }

  /**
   * 获取 Key 的月度花费
   */
  getKeyCost(keyHash: string): number {
    return this.keyMonthlyCosts.get(keyHash)?.cost || 0;
  }
}

// 单例
let quotaStore = new QuotaStore();

/**
 * 初始化配额存储（可选从 Redis 加载）
 */
export async function initQuotaStore(): Promise<void> {
  await quotaStore.loadFromStorage();
}

/**
 * 重置配额存储（用于测试隔离）
 */
export function resetQuotaStore(): void {
  quotaStore = new QuotaStore();
}

/**
 * 将配额数据 flush 到存储
 */
export async function flushQuotaStore(): Promise<void> {
  await quotaStore.flushToStorage();
}

/**
 * 检查配额
 */
export function checkQuota(tenantId: TenantId): QuotaCheckResult {
  const config = getConfig();

  // 如果未配置成本控制，跳过
  if (!config.cost_control?.monthly_budget) {
    return { allowed: true };
  }

  const usage = getTenantUsage(tenantId);
  const limits = quotaStore.getLimits(tenantId);
  const budget = config.cost_control.monthly_budget;
  const warnThreshold = config.cost_control.warn_threshold || 0.8;

  // 检查月度预算
  if (usage.total_cost >= budget) {
    return {
      allowed: false,
      reason: 'Monthly budget exceeded',
    };
  }

  // 警告阈值
  if (usage.total_cost >= budget * warnThreshold) {
    writeLog('warn', 'Tenant quota warning', {
      tenant_id: tenantId,
      usage_percent: Math.round((usage.total_cost / budget) * 100),
      total_cost: usage.total_cost,
      budget,
    });
  }

  // 检查自定义限制
  if (limits?.daily_requests && usage.total_requests >= limits.daily_requests) {
    return {
      allowed: false,
      reason: 'Daily request limit exceeded',
    };
  }

  if (limits?.daily_tokens && usage.total_tokens >= limits.daily_tokens) {
    return {
      allowed: false,
      reason: 'Daily token limit exceeded',
    };
  }

  if (limits?.monthly_cost && usage.total_cost >= limits.monthly_cost) {
    return {
      allowed: false,
      reason: 'Monthly cost limit exceeded',
    };
  }

  // 计算剩余
  const remainingRequests = limits?.daily_requests
    ? limits.daily_requests - usage.total_requests
    : undefined;
  const remainingTokens = limits?.daily_tokens
    ? limits.daily_tokens - usage.total_tokens
    : undefined;
  const remainingCost = budget - usage.total_cost;

  return {
    allowed: true,
    remaining_requests: remainingRequests,
    remaining_tokens: remainingTokens,
    remaining_cost: Math.round(remainingCost * 1000) / 1000,
  };
}

/**
 * 记录使用量
 */
export function recordUsage(
  tenantId: TenantId,
  tokens: number,
  cost: number,
  keyHash?: string
): void {
  quotaStore.increment(tenantId, tokens, cost, keyHash);
}

/**
 * 检查 Key 级月度预算
 */
export function checkKeyQuota(keyHash: string, monthlyBudget: number): { allowed: boolean; current_cost: number; reason?: string } {
  return quotaStore.checkKeyBudget(keyHash, monthlyBudget);
}

/**
 * 获取 Key 的月度花费
 */
export function getKeyCost(keyHash: string): number {
  return quotaStore.getKeyCost(keyHash);
}

/**
 * 设置租户配额限制
 */
export function setTenantLimits(
  tenantId: TenantId,
  limits: {
    daily_requests?: number;
    daily_tokens?: number;
    monthly_cost?: number;
  }
): void {
  quotaStore.setLimits(tenantId, limits);
}

/**
 * 重置租户配额
 */
export function resetTenantQuota(tenantId: TenantId): void {
  quotaStore.resetDaily(tenantId);
  quotaStore.resetMonthly(tenantId);
}

/**
 * 获取租户配额状态
 */
export function getQuotaStatus(tenantId: TenantId): {
  usage: ReturnType<typeof getTenantUsage>;
  limits: ReturnType<typeof quotaStore.getLimits>;
  check: QuotaCheckResult;
} {
  const usage = getTenantUsage(tenantId);
  const limits = quotaStore.getLimits(tenantId);
  const check = checkQuota(tenantId);

  return { usage, limits, check };
}