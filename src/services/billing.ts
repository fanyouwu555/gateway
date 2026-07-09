/**
 * 统一计费检查服务
 * 整合 competition / subscription / prepaid 三种计费模式的资格检查
 * 并管理 Key 级月度成本（供 monthly_budget 安全阀使用）
 * 与 QuotaService 分离：Billing = 有没有资格用，Quota = 能用多少
 */
import type { IApiKeyMeta } from '../types';
import { getBalance, checkPrepaidBalance } from './wallet';
import { createKVStore } from '../stores/factory';
import { shouldUseRedis } from '../utils';
import { writeLog } from '../utils/logger';

/**
 * 计费检查结果
 */
export interface BillingCheckResult {
  allowed: boolean;
  reason?: string;
  code?: 'subscription_expired' | 'insufficient_balance' | 'monthly_budget_exceeded';
  billing_info?: {
    current_balance_micro_yuan?: number;
    subscription_expires_at?: number;
    current_monthly_cost?: number;
  };
}

/**
 * Key 级月度成本追踪器
 * 独立于 QuotaService，避免职责混淆
 */
class BillingCostTracker {
  private keyMonthlyCosts = new Map<string, { cost: number; last_reset: number }>();
  private useRedis = false;
  private store: ReturnType<typeof createKVStore> | null = null;

  private inFlight = new Map<string, Promise<unknown>>();

  constructor() {
    this.useRedis = shouldUseRedis('BILLING_STORAGE');
    if (this.useRedis) {
      this.store = createKVStore('billing');
    }
  }

  private async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.inFlight.get(key);
    const next = (async () => {
      if (prev) await prev;
      return fn();
    })();
    this.inFlight.set(key, next);
    try {
      return await next;
    } finally {
      if (this.inFlight.get(key) === next) {
        this.inFlight.delete(key);
      }
    }
  }

  private async getStore(): Promise<ReturnType<typeof createKVStore>> {
    if (!this.store) {
      this.store = createKVStore('billing');
    }
    if (!this.store.isConnected()) {
      await this.store.connect();
    }
    return this.store;
  }

  /**
   * 检查 keyMonthlyCosts 条目是否需要月度重置
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
   * 记录 Key 级月度成本
   */
  async recordKeyCost(keyHash: string, cost: number): Promise<void> {
    return this.withLock(keyHash, async () => {
      let keyCost = this.keyMonthlyCosts.get(keyHash);
      if (!keyCost) {
        keyCost = { cost: 0, last_reset: Date.now() };
        this.keyMonthlyCosts.set(keyHash, keyCost);
      }
      this.ensureKeyMonthlyReset(keyCost);
      keyCost.cost += cost;

      if (this.useRedis) {
        await this.persistKeyCosts();
      }
    });
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
    const keyCost = this.keyMonthlyCosts.get(keyHash);
    if (keyCost) {
      this.ensureKeyMonthlyReset(keyCost);
    }
    return keyCost?.cost || 0;
  }

  /**
   * 重置 tracker（用于测试隔离）
   */
  reset(): void {
    this.keyMonthlyCosts.clear();
  }

  /**
   * 从 Redis 加载 Key 级月度花费
   */
  async loadFromStorage(): Promise<void> {
    if (!this.useRedis) return;
    try {
      const store = await this.getStore();
      const data = await store.get('billing:key_monthly_costs');
      if (data) {
        try {
          const parsed = JSON.parse(data) as Record<string, { cost: number; last_reset: number }>;
          for (const [keyHash, entry] of Object.entries(parsed)) {
            this.keyMonthlyCosts.set(keyHash, entry);
          }
        } catch {
          // 忽略解析失败
        }
      }
      writeLog('info', 'Billing key monthly costs loaded from Redis');
    } catch (err) {
      writeLog('warn', 'Failed to load billing key monthly costs from Redis', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * 将所有 Key 级月度花费 flush 到 Redis
   */
  async flushToStorage(): Promise<void> {
    if (!this.useRedis) return;
    try {
      const store = await this.getStore();
      const keyCostsObj: Record<string, { cost: number; last_reset: number }> = {};
      for (const [keyHash, entry] of this.keyMonthlyCosts.entries()) {
        keyCostsObj[keyHash] = entry;
      }
      await store.set('billing:key_monthly_costs', JSON.stringify(keyCostsObj));
    } catch (err) {
      writeLog('warn', 'Failed to flush billing key monthly costs to Redis', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * 持久化 Key 级月度花费
   */
  private async persistKeyCosts(): Promise<void> {
    if (!this.useRedis) return;
    try {
      const store = await this.getStore();
      const keyCostsObj: Record<string, { cost: number; last_reset: number }> = {};
      for (const [keyHash, entry] of this.keyMonthlyCosts.entries()) {
        keyCostsObj[keyHash] = entry;
      }
      await store.set('billing:key_monthly_costs', JSON.stringify(keyCostsObj));
    } catch {
      // 忽略持久化失败
    }
  }
}

// 单例
let billingCostTracker = new BillingCostTracker();

/**
 * 初始化 Billing 成本追踪器
 */
export async function initBillingCostTracker(): Promise<void> {
  await billingCostTracker.loadFromStorage();
}

/**
 * 重置 Billing 成本追踪器（用于测试隔离）
 */
export function resetBillingCostTracker(): void {
  billingCostTracker = new BillingCostTracker();
}

/**
 * 将 Billing 成本数据 flush 到存储
 */
export async function flushBillingCostTracker(): Promise<void> {
  await billingCostTracker.flushToStorage();
}

/**
 * 记录 Key 级月度成本
 */
export async function recordKeyCost(keyHash: string, cost: number): Promise<void> {
  await billingCostTracker.recordKeyCost(keyHash, cost);
}

/**
 * 检查 Key 级月度预算
 */
export function checkKeyBudget(keyHash: string, monthlyBudget: number): { allowed: boolean; current_cost: number; reason?: string } {
  return billingCostTracker.checkKeyBudget(keyHash, monthlyBudget);
}

/**
 * 获取 Key 的月度花费
 */
export function getKeyCost(keyHash: string): number {
  return billingCostTracker.getKeyCost(keyHash);
}

/**
 * 统一计费检查入口
 *
 * 检查顺序：
 * 1. competition → 直接放行
 * 2. subscription → 必须设置且未过期
 * 3. prepaid → 检查余额
 * 4. monthly_budget（可选安全阀）→ 检查 Key 级月度累计花费
 * 5. 无 billing_mode（旧 Key）→ 只检查 monthly_budget（如果设置了）
 */
export function checkBilling(
  keyHash: string,
  billingMode: IApiKeyMeta['billing_mode'],
  monthlyBudget?: number,
  subscriptionExpiresAt?: number
): BillingCheckResult {
  // 1. 比赛用户：完全免费，不受任何额度限制
  if (billingMode === 'competition') {
    return { allowed: true };
  }

  // 2. 包月用户：必须设置过期时间且未过期
  if (billingMode === 'subscription') {
    if (subscriptionExpiresAt === undefined || subscriptionExpiresAt < Date.now()) {
      return {
        allowed: false,
        reason: subscriptionExpiresAt === undefined
          ? 'API key subscription expiration not set'
          : 'API key subscription expired',
        code: 'subscription_expired',
        billing_info: { subscription_expires_at: subscriptionExpiresAt },
      };
    }
  }

  // 3. 预付用户：检查余额
  if (billingMode === 'prepaid') {
    const balanceCheck = checkPrepaidBalance(keyHash, 0);
    if (!balanceCheck.allowed) {
      return {
        allowed: false,
        reason: balanceCheck.reason || 'Insufficient balance',
        code: 'insufficient_balance',
        billing_info: { current_balance_micro_yuan: balanceCheck.current_balance_micro_yuan },
      };
    }
  }

  // 4. 月度预算安全阀（所有非 competition 模式）
  if (monthlyBudget !== undefined && monthlyBudget > 0) {
    const budgetCheck = checkKeyBudget(keyHash, monthlyBudget);
    if (!budgetCheck.allowed) {
      return {
        allowed: false,
        reason: budgetCheck.reason || 'Key monthly budget exceeded',
        code: 'monthly_budget_exceeded',
        billing_info: { current_monthly_cost: budgetCheck.current_cost },
      };
    }
  }

  // 通过
  const info: BillingCheckResult['billing_info'] = {};
  if (billingMode === 'prepaid') {
    info.current_balance_micro_yuan = getBalance(keyHash);
  }
  if (billingMode === 'subscription' && subscriptionExpiresAt !== undefined) {
    info.subscription_expires_at = subscriptionExpiresAt;
  }

  return {
    allowed: true,
    billing_info: Object.keys(info).length > 0 ? info : undefined,
  };
}
