/**
 * 配额管理服务
 * 监控和限制租户的资源使用
 */
import type { TenantId } from '../types';
import { getTenantUsage } from './metrics';
import { getConfig } from '../config';
import { writeLog } from '../middleware/logger';

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
 * 配额存储（生产环境应使用数据库）
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

  // 单独存储自定义限制
  private limits = new Map<
    TenantId,
    { daily_requests?: number; daily_tokens?: number; monthly_cost?: number }
  >();

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
    cost: number
  ): void {
    const quota = this.get(tenantId);
    quota.daily_requests += 1;
    quota.daily_tokens += tokens;
    quota.monthly_cost += cost;
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
}

// 单例
const quotaStore = new QuotaStore();

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
  cost: number
): void {
  quotaStore.increment(tenantId, tokens, cost);
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