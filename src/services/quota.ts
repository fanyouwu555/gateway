/**
 * 配额管理服务
 * 只负责日请求/日Token用量配额（与 Billing 彻底分离）
 * Billing = 有没有资格用；Quota = 能用多少
 * 支持内存存储（默认）和 Redis 持久化（可选）
 */
import type { TenantId } from '../types';
import { getTenantUsage } from './metrics';
import { getTenant } from './tenant';
import { writeLog } from '../utils/logger';
import { createKVStore } from '../stores/factory';
import { shouldUseRedis } from '../utils';

/**
 * 配额检查结果
 */
export interface QuotaCheckResult {
  allowed: boolean;
  remaining_requests?: number;
  remaining_tokens?: number;
  reason?: string;
}

/**
 * 配额存储
 * 只跟踪日请求/日Token
 */
class QuotaStore {
  private quotas = new Map<
    TenantId,
    {
      daily_requests: number;
      daily_tokens: number;
      last_reset: number;
    }
  >();

  private limits = new Map<
    TenantId,
    { daily_requests?: number; daily_tokens?: number }
  >();

  private useRedis = false;
  private store: ReturnType<typeof createKVStore> | null = null;

  constructor() {
    this.useRedis = shouldUseRedis('QUOTA_STORAGE');
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
   * 获取配额
   * 自动检查 last_reset，跨天重置 daily
   */
  get(tenantId: TenantId): {
    daily_requests: number;
    daily_tokens: number;
    last_reset: number;
  } {
    let quota = this.quotas.get(tenantId);

    if (!quota) {
      quota = {
        daily_requests: 0,
        daily_tokens: 0,
        last_reset: Date.now(),
      };
      this.quotas.set(tenantId, quota);
      return quota;
    }

    // 自动重置：检查 last_reset 是否跨天
    const now = new Date();
    const lastReset = new Date(quota.last_reset);
    const dayChanged =
      now.getUTCFullYear() !== lastReset.getUTCFullYear() ||
      now.getUTCMonth() !== lastReset.getUTCMonth() ||
      now.getUTCDate() !== lastReset.getUTCDate();

    if (dayChanged) {
      quota.daily_requests = 0;
      quota.daily_tokens = 0;
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
  increment(tenantId: TenantId, tokens: number): void {
    const quota = this.get(tenantId);
    quota.daily_requests += 1;
    quota.daily_tokens += tokens;

    // 异步持久化到 Redis（fire-and-forget）
    if (this.useRedis) {
      this.persist(tenantId).catch(() => {});
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
   * 设置自定义限制
   */
  setLimits(
    tenantId: TenantId,
    limits: {
      daily_requests?: number;
      daily_tokens?: number;
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
  } | null {
    return this.limits.get(tenantId) || null;
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
 * 只检查日请求/日Token限制（月度成本由 BillingService 负责）
 */
export function checkQuota(tenantId: TenantId): QuotaCheckResult {
  const current = quotaStore.get(tenantId);

  // 1. 优先使用 Tenant 级别的 limits
  const tenant = getTenant(tenantId);
  const tenantLimits = tenant?.limits;

  // 2. 其次使用 quotaStore 中自定义的 limits
  const customLimits = quotaStore.getLimits(tenantId);

  // 确定有效的日请求限制
  const dailyRequestLimit = tenantLimits?.daily_requests ?? customLimits?.daily_requests;

  // 确定有效的日 token 限制
  const dailyTokenLimit = tenantLimits?.daily_tokens ?? customLimits?.daily_tokens;

  // 如果没有配置任何限制，允许通过
  if (dailyRequestLimit === undefined && dailyTokenLimit === undefined) {
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

  // 计算剩余
  const remainingRequests = dailyRequestLimit !== undefined
    ? dailyRequestLimit - current.daily_requests
    : undefined;
  const remainingTokens = dailyTokenLimit !== undefined
    ? dailyTokenLimit - current.daily_tokens
    : undefined;

  return {
    allowed: true,
    remaining_requests: remainingRequests,
    remaining_tokens: remainingTokens,
  };
}

/**
 * 记录使用量
 */
export function recordUsage(
  tenantId: TenantId,
  tokens: number
): void {
  quotaStore.increment(tenantId, tokens);
}

/**
 * 设置租户配额限制
 */
export function setTenantLimits(
  tenantId: TenantId,
  limits: {
    daily_requests?: number;
    daily_tokens?: number;
  }
): void {
  quotaStore.setLimits(tenantId, limits);
}

/**
 * 重置租户配额
 */
export function resetTenantQuota(tenantId: TenantId): void {
  quotaStore.resetDaily(tenantId);
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
