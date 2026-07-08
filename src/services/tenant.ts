/**
 * 多租户管理服务
 * 租户配置、API Key管理、配额控制
 * 支持内存存储（默认）和 Redis 持久化（可选）
 */
import type { TenantId, IApiKeyMeta, TenantSettings, TenantLimits } from '../types';
import { generateRequestId, hashApiKey, verifyApiKey, generateSecureRandomString, shouldUseRedis } from '../utils';
import { writeLog } from '../utils/logger';
import { createKVStore } from '../stores/factory';

/**
 * 租户配置
 */
export interface TenantConfig {
  tenant_id: TenantId;
  name: string;
  status: 'active' | 'suspended' | 'trial';
  plan: 'free' | 'pro' | 'enterprise';
  created_at: number;
  updated_at: number;
  settings: TenantSettings;
  limits: TenantLimits;
}

/**
 * 租户存储
 * 支持内存存储 + 可选 Redis 持久化
 */
class TenantStore {
  private tenants = new Map<TenantId, TenantConfig>();
  private apiKeys = new Map<string, { key: string; tenant_id: TenantId; meta: IApiKeyMeta }>();
  // 前缀索引：plaintext key 前 10 字符 → hashed key 列表，加速 verifyApiKey
  private keyPrefixIndex = new Map<string, string[]>();

  private useRedis = false;
  private store: ReturnType<typeof createKVStore> | null = null;

  constructor() {
    this.useRedis = shouldUseRedis('TENANT_STORAGE');
    if (this.useRedis) {
      this.store = createKVStore('tenant');
    }
    this.createDefaultTenant();
  }

  private async getStore(): Promise<ReturnType<typeof createKVStore>> {
    if (!this.store) {
      this.store = createKVStore('tenant');
    }
    if (!this.store.isConnected()) {
      await this.store.connect();
    }
    return this.store;
  }

  private async persistTenant(tenantId: TenantId): Promise<void> {
    if (!this.useRedis) return;
    try {
      const store = await this.getStore();
      const tenant = this.tenants.get(tenantId);
      if (tenant && tenantId !== 'default') {
        await store.set(`tenant:data:${tenantId}`, JSON.stringify(tenant));
      }
    } catch {
      // 持久化失败不影响主流程
    }
  }

  private async persistApiKey(hashedKey: string): Promise<void> {
    if (!this.useRedis) return;
    try {
      const store = await this.getStore();
      const record = this.apiKeys.get(hashedKey);
      if (record) {
        const prefix = this.findPrefixForHash(hashedKey);
        await store.set(`tenant:keys:${hashedKey}`, JSON.stringify({ ...record, _key_prefix: prefix }));
      }
    } catch {
      // 持久化失败不影响主流程
    }
  }

  private async removeTenantFromStorage(tenantId: TenantId): Promise<void> {
    if (!this.useRedis) return;
    try {
      const store = await this.getStore();
      await store.delete(`tenant:data:${tenantId}`);
    } catch {
      // 删除失败不影响主流程
    }
  }

  private async removeApiKeyFromStorage(hashedKey: string): Promise<void> {
    if (!this.useRedis) return;
    try {
      const store = await this.getStore();
      await store.delete(`tenant:keys:${hashedKey}`);
    } catch {
      // 删除失败不影响主流程
    }
  }

  private findPrefixForHash(hashedKey: string): string {
    for (const [prefix, keys] of this.keyPrefixIndex.entries()) {
      if (keys.includes(hashedKey)) {
        return prefix;
      }
    }
    return '';
  }

  async loadFromStorage(): Promise<void> {
    if (!this.useRedis) return;
    try {
      const store = await this.getStore();

      const tenantKeys = await store.keys('tenant:data:*');
      for (const key of tenantKeys) {
        const tenantId = key.replace('tenant:data:', '');
        if (tenantId === 'default') continue;
        const data = await store.get(key);
        if (data) {
          try {
            const tenant = JSON.parse(data) as TenantConfig;
            this.tenants.set(tenantId, tenant);
          } catch {
            // 忽略解析失败的条目
          }
        }
      }

      const apiKeyKeys = await store.keys('tenant:keys:*');
      for (const key of apiKeyKeys) {
        const data = await store.get(key);
        if (data) {
          try {
            const parsed = JSON.parse(data) as { key: string; tenant_id: TenantId; meta: IApiKeyMeta; _key_prefix?: string };
            this.apiKeys.set(parsed.key, { key: parsed.key, tenant_id: parsed.tenant_id, meta: parsed.meta });
            if (parsed._key_prefix) {
              const list = this.keyPrefixIndex.get(parsed._key_prefix) || [];
              if (!list.includes(parsed.key)) {
                list.push(parsed.key);
                this.keyPrefixIndex.set(parsed._key_prefix, list);
              }
            }
          } catch {
            // 忽略解析失败的条目
          }
        }
      }

      writeLog('info', 'Tenant data loaded from Redis', {
        tenants: tenantKeys.length,
        api_keys: apiKeyKeys.length,
      });
    } catch (err) {
      writeLog('warn', 'Failed to load tenant data from Redis', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async flushToStorage(): Promise<void> {
    if (!this.useRedis) return;
    try {
      const store = await this.getStore();
      for (const [tenantId, tenant] of this.tenants.entries()) {
        if (tenantId === 'default') continue;
        await store.set(`tenant:data:${tenantId}`, JSON.stringify(tenant));
      }
      for (const [hashedKey, record] of this.apiKeys.entries()) {
        const prefix = this.findPrefixForHash(hashedKey);
        await store.set(`tenant:keys:${hashedKey}`, JSON.stringify({ ...record, _key_prefix: prefix }));
      }
    } catch (err) {
      writeLog('warn', 'Failed to flush tenant data to Redis', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * 创建默认租户
   */
  private createDefaultTenant(): void {
    const defaultTenant: TenantConfig = {
      tenant_id: 'default',
      name: 'Default Tenant',
      status: 'active',
      plan: 'free',
      created_at: Date.now(),
      updated_at: Date.now(),
      settings: {
        default_provider: 'openai',
        allowed_providers: ['openai', 'deepseek', 'anthropic'],
      },
      limits: {
        daily_requests: 1000,
        daily_tokens: 10000000,
        max_api_keys: 5,
        concurrent_requests: 10,
      },
    };
    this.tenants.set('default', defaultTenant);
  }

  /**
   * 创建租户
   */
  async create(tenant: Omit<TenantConfig, 'tenant_id' | 'created_at' | 'updated_at'>): Promise<TenantConfig> {
    const tenantId = `tenant_${generateRequestId()}`;
    const now = Date.now();

    const newTenant: TenantConfig = {
      ...tenant,
      tenant_id: tenantId,
      created_at: now,
      updated_at: now,
      settings: tenant.settings || {},
      limits: tenant.limits || {
        daily_requests: 1000,
        daily_tokens: 100000,
        max_api_keys: 5,
        concurrent_requests: 10,
      },
    };

    this.tenants.set(tenantId, newTenant);
    await this.persistTenant(tenantId);
    return newTenant;
  }

  /**
   * 获取租户
   */
  get(tenantId: TenantId): TenantConfig | null {
    return this.tenants.get(tenantId) || null;
  }

  /**
   * 更新租户
   */
  async update(tenantId: TenantId, updates: Partial<Omit<TenantConfig, 'tenant_id' | 'created_at'>>): Promise<TenantConfig | null> {
    const tenant = this.tenants.get(tenantId);
    if (!tenant) return null;

    const updated: TenantConfig = {
      ...tenant,
      ...updates,
      updated_at: Date.now(),
    };
    this.tenants.set(tenantId, updated);
    await this.persistTenant(tenantId);
    return updated;
  }

  /**
   * 删除租户
   */
  async delete(tenantId: TenantId): Promise<boolean> {
    if (tenantId === 'default') return false;
    const deleted = this.tenants.delete(tenantId);
    if (deleted) {
      await this.removeTenantFromStorage(tenantId);
    }
    return deleted;
  }

  /**
   * 列出所有租户
   */
  list(): TenantConfig[] {
    return Array.from(this.tenants.values());
  }

  /**
   * 为租户创建API Key
   * Key 以哈希形式存储，与认证中间件的 verifyApiKey() 兼容
   * 支持传入虚拟 Key 策略字段（allowed_models / rate_limit 等）
   */
  async createApiKey(
    tenantId: TenantId,
    name: string,
    expiresAt?: number,
    policy?: Pick<IApiKeyMeta, 'allowed_models' | 'default_model' | 'rate_limit_qps' | 'rate_limit_burst' | 'monthly_budget' | 'max_tokens_per_request' | 'metadata' | 'billing_mode' | 'subscription_expires_at'>,
    initialBalanceMicroYuan?: number
  ): Promise<IApiKeyMeta | null> {
    const tenant = this.tenants.get(tenantId);
    if (!tenant) return null;

    // 检查API Key数量限制
    const tenantKeys = this.getApiKeysByTenant(tenantId);
    if (tenantKeys.length >= tenant.limits.max_api_keys) {
      return null;
    }

    const plaintextKey = `sk-v1-${tenantId.slice(0, 8)}-${Date.now()}-${generateSecureRandomString(12)}`;
    // 存储哈希值，与 auth middleware 的 verifyApiKey() 兼容
    const hashedKey = hashApiKey(plaintextKey);
    const meta: IApiKeyMeta = {
      key: hashedKey,
      tenant_id: tenantId,
      name,
      created_at: Date.now(),
      expires_at: expiresAt,
      ...policy,
    };

    this.apiKeys.set(hashedKey, { key: hashedKey, tenant_id: tenantId, meta });
    // 更新前缀索引
    const prefix = this.getKeyPrefix(plaintextKey);
    const list = this.keyPrefixIndex.get(prefix) || [];
    list.push(hashedKey);
    this.keyPrefixIndex.set(prefix, list);

    // 如果是预付模式且设置了初始余额，初始化钱包
    if (policy?.billing_mode === 'prepaid' && initialBalanceMicroYuan !== undefined) {
      const { setBalance } = await import('../services/wallet');
      setBalance(hashedKey, initialBalanceMicroYuan);
    }

    await this.persistApiKey(hashedKey);
    // 返回明文 key（调用方需在创建时保存，之后无法再次获取）
    return { ...meta, key: plaintextKey };
  }

  /**
   * 提取 plaintext key 的前缀用于索引
   */
  private getKeyPrefix(plaintextKey: string): string {
    return plaintextKey.slice(0, 10);
  }

  /**
   * 通过哈希值查找 API Key 记录
   * 优先使用前缀索引，减少 scrypt 验证次数
   */
  private findApiKeyByPlaintext(plaintextKey: string): { key: string; tenant_id: TenantId; meta: IApiKeyMeta } | undefined {
    const prefix = this.getKeyPrefix(plaintextKey);
    const candidates = this.keyPrefixIndex.get(prefix);
    if (candidates) {
      for (const hashedKey of candidates) {
        const record = this.apiKeys.get(hashedKey);
        if (record && verifyApiKey(plaintextKey, record.key)) {
          return record;
        }
      }
    }
    // 防御性回退：索引未命中时全量扫描（应对数据不一致）
    for (const record of this.apiKeys.values()) {
      if (verifyApiKey(plaintextKey, record.key)) {
        return record;
      }
    }
    return undefined;
  }

  /**
   * 验证API Key
   * 输入为明文，通过 verifyApiKey 遍历查找匹配项
   */
  verifyApiKey(key: string): { valid: boolean; tenant_id?: TenantId; meta?: IApiKeyMeta; error?: string } {
    const record = this.findApiKeyByPlaintext(key);
    if (!record) {
      return { valid: false, error: 'Invalid API key' };
    }

    const tenant = this.tenants.get(record.tenant_id);
    if (!tenant) {
      return { valid: false, error: 'Tenant not found' };
    }

    if (tenant.status !== 'active') {
      return { valid: false, error: 'Tenant is not active' };
    }

    // 检查过期
    if (record.meta.expires_at && record.meta.expires_at < Date.now()) {
      return { valid: false, error: 'API key expired' };
    }

    return { valid: true, tenant_id: record.tenant_id, meta: record.meta };
  }

  /**
   * 从前缀索引中移除 hashed key
   */
  private removeFromPrefixIndex(hashedKey: string): void {
    for (const [prefix, keys] of this.keyPrefixIndex.entries()) {
      const idx = keys.indexOf(hashedKey);
      if (idx >= 0) {
        keys.splice(idx, 1);
        if (keys.length === 0) {
          this.keyPrefixIndex.delete(prefix);
        }
        break;
      }
    }
  }

  /**
   * 通过哈希值查找 Key 记录（供管理 API 使用）
   */
  findApiKeyByHash(hash: string): { key: string; tenant_id: TenantId; meta: IApiKeyMeta } | undefined {
    return this.apiKeys.get(hash);
  }

  /**
   * 更新 API Key 策略（通过哈希值定位，也支持明文输入）
   */
  async updateApiKeyPolicy(
    key: string,
    updates: Partial<Pick<IApiKeyMeta, 'name' | 'expires_at' | 'allowed_models' | 'default_model' | 'rate_limit_qps' | 'rate_limit_burst' | 'monthly_budget' | 'max_tokens_per_request' | 'metadata' | 'billing_mode' | 'subscription_expires_at'>>,
    balanceMicroYuan?: number
  ): Promise<IApiKeyMeta | null> {
    // 先尝试直接按哈希值查找
    let record = this.apiKeys.get(key);
    if (!record) {
      // 再尝试通过明文查找
      record = this.findApiKeyByPlaintext(key);
    }
    if (!record) return null;

    const newMeta: IApiKeyMeta = {
      ...record.meta,
      ...updates,
    };

    // 如果显式提供了余额，同步更新钱包（不存入 API Key 元数据）
    if (balanceMicroYuan !== undefined) {
      const { setBalance } = await import('../services/wallet');
      setBalance(record.key, balanceMicroYuan);
    }

    this.apiKeys.set(record.key, { ...record, meta: newMeta });
    await this.persistApiKey(record.key);
    return newMeta;
  }

  /**
   * 删除API Key（支持明文输入）
   */
  deleteApiKey(key: string): boolean {
    if (this.apiKeys.delete(key)) {
      this.removeFromPrefixIndex(key);
      this.removeApiKeyFromStorage(key).catch(() => {});
      return true;
    }
    const record = this.findApiKeyByPlaintext(key);
    if (record) {
      this.removeFromPrefixIndex(record.key);
      this.removeApiKeyFromStorage(record.key).catch(() => {});
      return this.apiKeys.delete(record.key);
    }
    return false;
  }

  /**
   * 获取租户的所有API Key
   */
  getApiKeysByTenant(tenantId: TenantId): IApiKeyMeta[] {
    const keys: IApiKeyMeta[] = [];
    for (const record of this.apiKeys.values()) {
      if (record.tenant_id === tenantId) {
        keys.push(record.meta);
      }
    }
    return keys;
  }

  /**
   * 获取所有租户的所有 API Keys
   */
  getAllApiKeys(): IApiKeyMeta[] {
    const keys: IApiKeyMeta[] = [];
    for (const record of this.apiKeys.values()) {
      keys.push(record.meta);
    }
    return keys;
  }

  /**
   * 获取租户统计
   */
  getTenantStats(tenantId: TenantId): {
    api_keys_count: number;
    is_active: boolean;
    plan: string;
  } | null {
    const tenant = this.tenants.get(tenantId);
    if (!tenant) return null;

    return {
      api_keys_count: this.getApiKeysByTenant(tenantId).length,
      is_active: tenant.status === 'active',
      plan: tenant.plan,
    };
  }
}

// 单例
let tenantStore = new TenantStore();

/**
 * 初始化租户存储（可选从 Redis 加载）
 */
export async function initTenantStore(): Promise<void> {
  await tenantStore.loadFromStorage();
}

/**
 * 重置租户存储（用于测试隔离）
 */
export function resetTenantStore(): void {
  tenantStore = new TenantStore();
}

/**
 * 将租户数据 flush 到存储
 */
export async function flushTenantStore(): Promise<void> {
  await tenantStore.flushToStorage();
}

/**
 * 创建租户
 */
export async function createTenant(
  tenant: Omit<TenantConfig, 'tenant_id' | 'created_at' | 'updated_at' | 'settings' | 'limits'> & { settings?: TenantSettings; limits?: TenantLimits }
): Promise<TenantConfig> {
  // plan 感知的默认限制
  const planDefaults: Record<string, TenantLimits> = {
    free:       { daily_requests: 1000,   daily_tokens: 100000,   max_api_keys: 5,   concurrent_requests: 10 },
    pro:        { daily_requests: 10000,  daily_tokens: 1000000,  max_api_keys: 20,  concurrent_requests: 50 },
    enterprise: { daily_requests: 100000, daily_tokens: 10000000, max_api_keys: 100, concurrent_requests: 200 },
  };

  const completed: Omit<TenantConfig, 'tenant_id' | 'created_at' | 'updated_at'> = {
    ...tenant,
    settings: tenant.settings || { allowed_providers: ['openai'] },
    limits: tenant.limits || planDefaults[tenant.plan] || planDefaults.free,
  };

  return tenantStore.create(completed);
}

/**
 * 获取租户
 */
export function getTenant(tenantId: TenantId): TenantConfig | null {
  return tenantStore.get(tenantId);
}

/**
 * 更新租户
 */
export async function updateTenant(
  tenantId: TenantId,
  updates: Partial<Omit<TenantConfig, 'tenant_id' | 'created_at'>>
): Promise<TenantConfig | null> {
  return tenantStore.update(tenantId, updates);
}

/**
 * 删除租户
 */
export async function deleteTenant(tenantId: TenantId): Promise<boolean> {
  return tenantStore.delete(tenantId);
}

/**
 * 列出所有租户
 */
export function listTenants(): TenantConfig[] {
  return tenantStore.list();
}

/**
 * 创建租户API Key（支持虚拟 Key 策略字段）
 */
export async function createTenantApiKey(
  tenantId: TenantId,
  name: string,
  expiresAt?: number,
  policy?: Pick<IApiKeyMeta, 'allowed_models' | 'default_model' | 'rate_limit_qps' | 'rate_limit_burst' | 'monthly_budget' | 'max_tokens_per_request' | 'metadata' | 'billing_mode' | 'subscription_expires_at'>,
  initialBalanceMicroYuan?: number
): Promise<IApiKeyMeta | null> {
  return tenantStore.createApiKey(tenantId, name, expiresAt, policy, initialBalanceMicroYuan);
}

/**
 * 通过哈希值查找 API Key 元数据
 */
export function findTenantApiKeyByHash(hash: string): IApiKeyMeta | undefined {
  return tenantStore.findApiKeyByHash(hash)?.meta;
}

/**
 * 更新 API Key 策略（通过哈希值定位）
 */
export async function updateTenantApiKeyPolicy(
  hash: string,
  updates: Parameters<typeof tenantStore.updateApiKeyPolicy>[1],
  balanceMicroYuan?: number
): Promise<IApiKeyMeta | null> {
  return tenantStore.updateApiKeyPolicy(hash, updates, balanceMicroYuan);
}

/**
 * 验证API Key
 */
export function verifyTenantApiKey(key: string) {
  return tenantStore.verifyApiKey(key);
}

/**
 * 删除API Key
 */
export function deleteTenantApiKey(key: string): boolean {
  return tenantStore.deleteApiKey(key);
}

/**
 * 获取租户的API Keys
 */
export function getTenantApiKeys(tenantId: TenantId): IApiKeyMeta[] {
  return tenantStore.getApiKeysByTenant(tenantId);
}

/**
 * 获取所有租户的所有 API Keys（用于全局鉴权）
 */
export function getAllTenantApiKeys(): IApiKeyMeta[] {
  return tenantStore.getAllApiKeys();
}

/**
 * 获取租户统计
 */
export function getTenantStats(tenantId: TenantId) {
  return tenantStore.getTenantStats(tenantId);
}