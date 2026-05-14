/**
 * 多租户管理服务
 * 租户配置、API Key管理、配额控制
 */
import type { TenantId, IApiKeyMeta } from '../types';
import { generateRequestId, hashApiKey, verifyApiKey } from '../utils';

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
   */
  createApiKey(tenantId: TenantId, name: string, expiresAt?: number): IApiKeyMeta | null {
    const tenant = this.tenants.get(tenantId);
    if (!tenant) return null;

    // 检查API Key数量限制
    const tenantKeys = this.getApiKeysByTenant(tenantId);
    if (tenantKeys.length >= tenant.limits.max_api_keys) {
      return null;
    }

    const plaintextKey = `sk-${tenantId.slice(0, 8)}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    // 存储哈希值，与 auth middleware 的 verifyApiKey() 兼容
    const hashedKey = hashApiKey(plaintextKey);
    const meta: IApiKeyMeta = {
      key: hashedKey,
      tenant_id: tenantId,
      name,
      created_at: Date.now(),
      expires_at: expiresAt,
    };

    this.apiKeys.set(hashedKey, { key: hashedKey, tenant_id: tenantId, meta });
    // 返回明文 key（调用方需在创建时保存，之后无法再次获取）
    return { ...meta, key: plaintextKey };
  }

  /**
   * 通过哈希值查找 API Key 记录（线性扫描）
   * 因为 scrypt 哈希非确定性，无法直接 get
   */
  private findApiKeyByPlaintext(plaintextKey: string): { key: string; tenant_id: TenantId; meta: IApiKeyMeta } | undefined {
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
   * 删除API Key（支持明文输入）
   */
  deleteApiKey(key: string): boolean {
    // 先尝试直接删除（如果 key 已经是哈希值）
    if (this.apiKeys.delete(key)) return true;
    // 否则通过 verifyApiKey 查找并删除
    const record = this.findApiKeyByPlaintext(key);
    if (record) {
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
  tenant: Omit<TenantConfig, 'tenant_id' | 'created_at' | 'updated_at'>
): TenantConfig {
  return tenantStore.create(tenant);
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
 * 创建租户API Key
 */
export function createTenantApiKey(tenantId: TenantId, name: string, expiresAt?: number): IApiKeyMeta | null {
  return tenantStore.createApiKey(tenantId, name, expiresAt);
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