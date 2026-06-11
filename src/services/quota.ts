/**
 * 配额管理服务
 * 监控和限制租户的资源使用
 * 支持内存存储（默认）和 Redis 持久化（可选）
 */
import type { TenantId } from '../types';
import { getTenantUsage } from './metrics';
import { getConfig } from '../config';
import { getTenant } from './tenant';
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

  private keyMonthlyCosts = new Map<string, { cost: number; last_reset: number }>();

  private limits = new Map<
    TenantId,
    { daily_requests?: number; daily_tokens?: number; monthly_cost?: number }
  >();

  private useRedis = false;
  private store: ReturnType<typeof createKVStore> | null = null;

  constructor() {
    this.useRedis = process.env.QUOTA_STORAGE === 'redis';
    if (this.useRedis) {
      this.store = createKVStore('quota');
    }
  }

  private async getStore(): Promise<ReturnType<typeof createKVStore>> {
    if (!this.store) {
      this.store = createKVStore('quota');
    }
    if (!this.store.isConnected()) {
      await this.store.connect();
    }
    return this.store;
  }

  /**
   * 检查 keyMonthlyCosts 条目是否需要月度重置
   * 如果 last_reset 不在当前月份，将 cost 归零并更新时间戳
   */
  private ensureKeyMonthlyReset(entry: { cost: number; last_reset: number }): void {
    const now = new Date();
    const last = new Date(entry.last_reset);
    if (now.getUTCFullYear() !== last.getUTCFullYear() || now.getUTCMonth() !== last.getUTCMonth()) {
      entry.cost = 0;
      entry.last_reset = now.getTime();
    }
  }

  /**
   * 获取配额
   * 自动检查 last_reset，跨天重置 daily，跨月重置 monthly
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
      return quota;
    }

    // 自动重置：检查 last_reset 是否跨天/跨月
    const now = new Date();
    const lastReset = new Date(quota.last_reset);
    const dayChanged =
      now.getUTCFullYear() !== lastReset.getUTCFullYear() ||
      now.getUTCMonth() !== lastReset.getUTCMonth() ||
      now.getUTCDate() !== lastReset.getUTCDate();
    const monthChanged =
      now.getUTCFullYear() !== lastReset.getUTCFullYear() ||
      now.getUTCMonth() !== lastReset.getUTCMonth();

    if (dayChanged || monthChanged) {
      if (dayChanged) {
        quota.daily_requests = 0;
        quota.daily_tokens = 0;
      }
      if (monthChanged) {
        quota.monthly_cost = 0;
      }
      quota.last_reset = Date.now();

      // 异步持久化到 Redis
      if (this.useRedis) {
        this.persist(tenantId).catch(() => {});
      }
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
      this.ensureKeyMonthlyReset(keyCost);
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
      const store = await this.getStore();
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
      const store = await this.getStore();
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
      const store = await this.getStore();
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
    if (keyCost) {
      this.ensureKeyMonthlyReset(keyCost);
    }
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
 *
 * 使用 quotaStore.get() 作为数据源，而非 metrics store。
 * 原因：recordUsage() 同步更新 quotaStore，而 metricsStore 的更新在之后发生。
 * 使用 quotaStore 消除了 check → record 之间的 TOCTOU 窗口，
 * 确保并发请求在 check 时能感知到已完成的请求的用量。
 */
export function checkQuota(tenantId: TenantId): QuotaCheckResult {
  const current = quotaStore.get(tenantId);

  // 1. 优先使用 Tenant 级别的 limits
  const tenant = getTenant(tenantId);
  const tenantLimits = tenant?.limits;

  // 2. 其次使用 quotaStore 中自定义的 limits
  const customLimits = quotaStore.getLimits(tenantId);

  // 3. 最后回退到全局 cost_control 配置
  const config = getConfig();
  const globalBudget = config.cost_control?.monthly_budget;

  // 确定有效的月度预算：tenant limits > custom limits > global config
  const monthlyBudget = tenantLimits?.monthly_cost ?? customLimits?.monthly_cost ?? globalBudget;

  // 确定有效的日请求限制：tenant limits > custom limits
  const dailyRequestLimit = tenantLimits?.daily_requests ?? customLimits?.daily_requests;

  // 确定有效的日 token 限制：tenant limits > custom limits
  const dailyTokenLimit = tenantLimits?.daily_tokens ?? customLimits?.daily_tokens;

  // 如果没有配置任何限制，允许通过
  if (monthlyBudget === undefined && dailyRequestLimit === undefined && dailyTokenLimit === undefined) {
    return { allowed: true };
  }

  // 检查日请求限制
  if (dailyRequestLimit !== undefined && current.daily_requests >= dailyRequestLimit) {
    return {
      allowed: false,
      reason: 'Daily request limit exceeded',
    };
  }

  // 检查日 token 限制
  if (dailyTokenLimit !== undefined && current.daily_tokens >= dailyTokenLimit) {
    return {
      allowed: false,
      reason: 'Daily token limit exceeded',
    };
  }

  // 检查月度预算限制
  if (monthlyBudget !== undefined) {
    if (current.monthly_cost >= monthlyBudget) {
      return {
        allowed: false,
        reason: 'Monthly budget exceeded',
      };
    }

    // 警告阈值（仅对月度预算）
    const warnThreshold = config.cost_control?.warn_threshold || 0.8;
    if (current.monthly_cost >= monthlyBudget * warnThreshold) {
      writeLog('warn', 'Tenant quota warning', {
        tenant_id: tenantId,
        usage_percent: Math.round((current.monthly_cost / monthlyBudget) * 100),
        total_cost: current.monthly_cost,
        budget: monthlyBudget,
      });
    }
  }

  // 计算剩余
  const remainingRequests = dailyRequestLimit !== undefined
    ? dailyRequestLimit - current.daily_requests
    : undefined;
  const remainingTokens = dailyTokenLimit !== undefined
    ? dailyTokenLimit - current.daily_tokens
    : undefined;
  const remainingCost = monthlyBudget !== undefined
    ? Math.round((monthlyBudget - current.monthly_cost) * 1000) / 1000
    : undefined;

  return {
    allowed: true,
    remaining_requests: remainingRequests,
    remaining_tokens: remainingTokens,
    remaining_cost: remainingCost,
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