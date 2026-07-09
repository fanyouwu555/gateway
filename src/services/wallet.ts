/**
 * 钱包服务
 * 管理 API Key 的预付余额和充值/消费流水
 * 支持内存存储（默认）和 Redis 持久化（可选）
 * 内部单位：微元（1元 = 1_000_000）
 */
import type { IWalletTransaction } from '../types';
import { createKVStore } from '../stores/factory';
import { shouldUseRedis, generateSecureRandomString } from '../utils';
import { writeLog } from '../utils/logger';

const MAX_TRANSACTIONS_PER_KEY = 1000;

/**
 * 余额检查结果
 */
export interface WalletCheckResult {
  allowed: boolean;
  reason?: string;
  current_balance_micro_yuan?: number;
}

/**
 * 充值结果
 */
export interface RechargeResult {
  success: boolean;
  new_balance_micro_yuan: number;
  transaction: IWalletTransaction;
}

/**
 * 扣费结果
 */
export interface DeductResult {
  success: boolean;
  newBalance: number;
  transaction: IWalletTransaction;
}

/**
 * 钱包存储
 */
class WalletStore {
  private balances = new Map<string, number>();
  private transactions = new Map<string, IWalletTransaction[]>();

  private useRedis = false;
  private store: ReturnType<typeof createKVStore> | null = null;

  private inFlight = new Map<string, Promise<unknown>>();

  constructor() {
    this.useRedis = shouldUseRedis('WALLET_STORAGE');
    if (this.useRedis) {
      this.store = createKVStore('wallet');
    }
  }

  private async withLock<T>(keyHash: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.inFlight.get(keyHash);
    const next = (async () => {
      if (prev) await prev;
      return fn();
    })();
    this.inFlight.set(keyHash, next);
    try {
      return await next;
    } finally {
      if (this.inFlight.get(keyHash) === next) {
        this.inFlight.delete(keyHash);
      }
    }
  }

  private async getStore(): Promise<ReturnType<typeof createKVStore>> {
    if (!this.store) {
      this.store = createKVStore('wallet');
    }
    if (!this.store.isConnected()) {
      await this.store.connect();
    }
    return this.store;
  }

  /**
   * 获取余额（微元）
   */
  getBalance(keyHash: string): number {
    return this.balances.get(keyHash) || 0;
  }

  /**
   * 设置余额（微元）
   */
  setBalance(keyHash: string, balanceMicroYuan: number): void {
    this.balances.set(keyHash, Math.max(0, balanceMicroYuan));
    if (this.useRedis) {
      this.persistBalance(keyHash).catch(() => {});
    }
  }

  /**
   * 检查预付余额是否充足
   */
  checkPrepaidBalance(keyHash: string, estimatedCostMicroYuan = 0): WalletCheckResult {
    const balance = this.getBalance(keyHash);
    if (balance <= 0) {
      return { allowed: false, reason: 'Insufficient balance', current_balance_micro_yuan: balance };
    }
    if (estimatedCostMicroYuan > 0 && balance < estimatedCostMicroYuan) {
      return { allowed: false, reason: 'Insufficient balance for estimated cost', current_balance_micro_yuan: balance };
    }
    return { allowed: true, current_balance_micro_yuan: balance };
  }

  /**
   * 扣费
   */
  async deductBalance(
    keyHash: string,
    costMicroYuan: number,
    metadata?: Record<string, string>
  ): Promise<DeductResult> {
    return this.withLock(keyHash, async () => {
      const current = this.getBalance(keyHash);
      const amount = Math.max(0, costMicroYuan);
      let newBalance: number;
      let success: boolean;

      if (current >= amount) {
        newBalance = current - amount;
        success = true;
      } else {
        newBalance = 0;
        success = false;
        writeLog('warn', 'Prepaid balance overdraft', {
          key_hash: keyHash,
          cost_micro_yuan: amount,
          current_micro_yuan: current,
        });
      }

      this.balances.set(keyHash, newBalance);

      const transaction: IWalletTransaction = {
        id: `tx-${Date.now()}-${generateSecureRandomString(8)}`,
        key_hash: keyHash,
        tenant_id: metadata?.tenant_id || '',
        type: 'deduct',
        amount_micro_yuan: success ? -amount : -(current),
        balance_after_micro_yuan: newBalance,
        reason: metadata?.reason || 'API request deduction',
        created_at: Date.now(),
        metadata,
      };

      this.appendTransaction(keyHash, transaction);

      if (this.useRedis) {
        await this.persistBalanceAtomic(keyHash, newBalance, transaction);
      }

      return { success, newBalance, transaction };
    });
  }

  /**
   * 充值
   */
  rechargeBalance(
    keyHash: string,
    amountMicroYuan: number,
    reason?: string,
    metadata?: Record<string, string>
  ): RechargeResult {
    const amount = Math.max(0, amountMicroYuan);
    const current = this.getBalance(keyHash);
    const newBalance = current + amount;

    this.balances.set(keyHash, newBalance);

    const transaction: IWalletTransaction = {
      id: `tx-${Date.now()}-${generateSecureRandomString(8)}`,
      key_hash: keyHash,
      tenant_id: metadata?.tenant_id || '',
      type: 'recharge',
      amount_micro_yuan: amount,
      balance_after_micro_yuan: newBalance,
      reason: reason || 'Manual recharge',
      created_at: Date.now(),
      metadata,
    };

    this.appendTransaction(keyHash, transaction);

    if (this.useRedis) {
      this.persistBalance(keyHash).catch(() => {});
      this.persistTransaction(keyHash, transaction).catch(() => {});
    }

    return { success: true, new_balance_micro_yuan: newBalance, transaction };
  }

  /**
   * 获取交易流水
   */
  getTransactions(keyHash: string, limit = 50): IWalletTransaction[] {
    const txs = this.transactions.get(keyHash) || [];
    return txs.slice(0, limit);
  }

  /**
   * 追加交易记录到内存
   */
  private appendTransaction(keyHash: string, tx: IWalletTransaction): void {
    let txs = this.transactions.get(keyHash);
    if (!txs) {
      txs = [];
      this.transactions.set(keyHash, txs);
    }
    txs.unshift(tx);
    if (txs.length > MAX_TRANSACTIONS_PER_KEY) {
      txs.length = MAX_TRANSACTIONS_PER_KEY;
    }
  }

  /**
   * 持久化余额到 Redis
   */
  private async persistBalance(keyHash: string): Promise<void> {
    try {
      const store = await this.getStore();
      await store.set(`balance:${keyHash}`, String(this.balances.get(keyHash) || 0));
    } catch {
      // 忽略持久化失败
    }
  }

  /**
   * 持久化交易到 Redis
   */
  private async persistTransaction(keyHash: string, tx: IWalletTransaction): Promise<void> {
    try {
      const store = await this.getStore();
      await store.lPush(`transactions:${keyHash}`, JSON.stringify(tx));
      // 保持列表长度上限
      await store.lTrim(`transactions:${keyHash}`, 0, MAX_TRANSACTIONS_PER_KEY - 1);
    } catch {
      // 忽略持久化失败
    }
  }

  /**
   * 原子化持久化余额和交易到 Redis
   */
  private async persistBalanceAtomic(
    keyHash: string,
    newBalance: number,
    tx: IWalletTransaction
  ): Promise<void> {
    try {
      const store = await this.getStore();
      const pipeline = store.pipeline();
      pipeline.set(`balance:${keyHash}`, String(newBalance));
      pipeline.lPush(`transactions:${keyHash}`, JSON.stringify(tx));
      pipeline.lTrim(`transactions:${keyHash}`, 0, MAX_TRANSACTIONS_PER_KEY - 1);
      await pipeline.exec();
    } catch (err) {
      writeLog('warn', 'Failed to persist wallet atomically', {
        key_hash: keyHash,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * 从 Redis 加载所有余额
   */
  async loadFromStorage(): Promise<void> {
    if (!this.useRedis) return;
    try {
      const store = await this.getStore();
      const keys = await store.keys('balance:*');
      for (const key of keys) {
        const keyHash = key.replace('balance:', '');
        const value = await store.get(key);
        if (value !== null) {
          const balance = parseInt(value, 10);
          if (!Number.isNaN(balance)) {
            this.balances.set(keyHash, balance);
          }
        }
      }
      writeLog('info', 'Wallet balances loaded from Redis', { count: keys.length });
    } catch (err) {
      writeLog('warn', 'Failed to load wallet balances from Redis', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * 将所有余额 flush 到 Redis
   */
  async flushToStorage(): Promise<void> {
    if (!this.useRedis) return;
    try {
      const store = await this.getStore();
      for (const [keyHash, balance] of this.balances.entries()) {
        await store.set(`balance:${keyHash}`, String(balance));
      }
    } catch (err) {
      writeLog('warn', 'Failed to flush wallet balances to Redis', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

// 单例
let walletStore = new WalletStore();

/**
 * 初始化钱包存储（可选从 Redis 加载）
 */
export async function initWalletStore(): Promise<void> {
  await walletStore.loadFromStorage();
}

/**
 * 重置钱包存储（用于测试隔离）
 */
export function resetWalletStore(): void {
  walletStore = new WalletStore();
}

/**
 * 将钱包数据 flush 到存储
 */
export async function flushWalletStore(): Promise<void> {
  await walletStore.flushToStorage();
}

/**
 * 获取余额（微元）
 */
export function getBalance(keyHash: string): number {
  return walletStore.getBalance(keyHash);
}

/**
 * 设置余额（微元）
 */
export function setBalance(keyHash: string, balanceMicroYuan: number): void {
  walletStore.setBalance(keyHash, balanceMicroYuan);
}

/**
 * 检查预付余额
 */
export function checkPrepaidBalance(keyHash: string, estimatedCostMicroYuan?: number): WalletCheckResult {
  return walletStore.checkPrepaidBalance(keyHash, estimatedCostMicroYuan);
}

/**
 * 扣费
 */
export async function deductBalance(
  keyHash: string,
  costMicroYuan: number,
  metadata?: Record<string, string>
): Promise<DeductResult> {
  return walletStore.deductBalance(keyHash, costMicroYuan, metadata);
}

/**
 * 充值
 */
export function rechargeBalance(
  keyHash: string,
  amountMicroYuan: number,
  reason?: string,
  metadata?: Record<string, string>
): RechargeResult {
  return walletStore.rechargeBalance(keyHash, amountMicroYuan, reason, metadata);
}

/**
 * 获取交易流水
 */
export function getTransactions(keyHash: string, limit?: number): IWalletTransaction[] {
  return walletStore.getTransactions(keyHash, limit);
}
