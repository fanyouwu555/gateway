/**
 * 多租户管理服务
 * 租户配置、API Key管理、配额控制
 */
import type { TenantId, IApiKeyMeta } from '../types';
import { generateRequestId, hashApiKey, verifyApiKey, generateSecureRandomString } from '../utils';

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
 * 租户设置
 */
export interface TenantSettings {
  default_provider?: string;
  allowed_providers?: string[];
  allowed_models?: string[];
  webhook_url?: string;
  notification_email?: string;
}

/**
 * 租户限制
 */
export interface TenantLimits {
  daily_requests: number;
  daily_tokens: number;
  monthly_cost: number;
  max_api_keys: number;
  concurrent_requests: number;
}

/**
 * 租户存储
 */
class TenantStore {
  private tenants = new Map<TenantId, TenantConfig>();
  private apiKeys = new Map<string, { key: string; tenant_id: TenantId; meta: IApiKeyMeta }>();
  // 前缀索引：plaintext key 前 10 字符 → hashed key 列表，加速 verifyApiKey
  private keyPrefixIndex = new Map<string, string[]>();

  constructor() {
    // 创建默认租户
    this.createDefaultTenant();
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
        daily_tokens: 100000,
        monthly_cost: 100,
        max_api_keys: 5,
        concurrent_requests: 10,
      },
    };
    this.tenants.set('default', defaultTenant);
  }

  /**
   * 创建租户
   */
  create(tenant: Omit<TenantConfig, 'tenant_id' | 'created_at' | 'updated_at'>): TenantConfig {
    const tenantId = `tenant_${generateRequestId()}`;
    const now = Date.now();

    const newTenant: TenantConfig = {
      ...tenant,
      tenant_id: tenantId,
      created_at: now,
      updated_at: now,
    };

    this.tenants.set(tenantId, newTenant);
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
  update(tenantId: TenantId, updates: Partial<Omit<TenantConfig, 'tenant_id' | 'created_at'>>): TenantConfig | null {
    const tenant = this.tenants.get(tenantId);
    if (!tenant) return null;

    const updated: TenantConfig = {
      ...tenant,
      ...updates,
      updated_at: Date.now(),
    };
    this.tenants.set(tenantId, updated);
    return updated;
  }

  /**
   * 删除租户
   */
  delete(tenantId: TenantId): boolean {
    if (tenantId === 'default') return false; // 不能删除默认租户
    return this.tenants.delete(tenantId);
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
  createApiKey(
    tenantId: TenantId,
    name: string,
    expiresAt?: number,
    policy?: Pick<IApiKeyMeta, 'allowed_models' | 'rate_limit_qps' | 'rate_limit_burst' | 'monthly_budget' | 'max_tokens_per_request' | 'metadata'>
  ): IApiKeyMeta | null {
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
  updateApiKeyPolicy(
    key: string,
    updates: Partial<Pick<IApiKeyMeta, 'name' | 'expires_at' | 'allowed_models' | 'rate_limit_qps' | 'rate_limit_burst' | 'monthly_budget' | 'max_tokens_per_request' | 'metadata'>>
  ): IApiKeyMeta | null {
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
    this.apiKeys.set(record.key, { ...record, meta: newMeta });
    return newMeta;
  }

  /**
   * 删除API Key（支持明文输入）
   */
  deleteApiKey(key: string): boolean {
    // 先尝试直接删除（如果 key 已经是哈希值）
    if (this.apiKeys.delete(key)) {
      this.removeFromPrefixIndex(key);
      return true;
    }
    // 否则通过 verifyApiKey 查找并删除
    const record = this.findApiKeyByPlaintext(key);
    if (record) {
      this.removeFromPrefixIndex(record.key);
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
 * 重置租户存储（用于测试隔离）
 */
export function resetTenantStore(): void {
  tenantStore = new TenantStore();
}

/**
 * 创建租户
 */
export function createTenant(
  tenant: Omit<TenantConfig, 'tenant_id' | 'created_at' | 'updated_at' | 'settings' | 'limits'> & { settings?: TenantSettings; limits?: TenantLimits }
): TenantConfig {
  // plan 感知的默认限制
  const planDefaults: Record<string, TenantLimits> = {
    free:       { daily_requests: 1000, daily_tokens: 100000,  monthly_cost: 100,  max_api_keys: 5,  concurrent_requests: 10 },
    pro:        { daily_requests: 10000, daily_tokens: 1000000,  monthly_cost: 1000,  max_api_keys: 20,  concurrent_requests: 50 },
    enterprise: { daily_requests: 100000, daily_tokens: 10000000, monthly_cost: 10000, max_api_keys: 100, concurrent_requests: 200 },
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
export function updateTenant(
  tenantId: TenantId,
  updates: Partial<Omit<TenantConfig, 'tenant_id' | 'created_at'>>
): TenantConfig | null {
  return tenantStore.update(tenantId, updates);
}

/**
 * 删除租户
 */
export function deleteTenant(tenantId: TenantId): boolean {
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
export function createTenantApiKey(
  tenantId: TenantId,
  name: string,
  expiresAt?: number,
  policy?: Pick<IApiKeyMeta, 'allowed_models' | 'rate_limit_qps' | 'rate_limit_burst' | 'monthly_budget' | 'max_tokens_per_request' | 'metadata'>
): IApiKeyMeta | null {
  return tenantStore.createApiKey(tenantId, name, expiresAt, policy);
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
export function updateTenantApiKeyPolicy(
  hash: string,
  updates: Parameters<typeof tenantStore.updateApiKeyPolicy>[1]
): IApiKeyMeta | null {
  return tenantStore.updateApiKeyPolicy(hash, updates);
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