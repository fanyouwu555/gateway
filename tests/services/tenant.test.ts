/**
 * 多租户管理服务测试
 */
import {
  createTenant,
  getTenant,
  updateTenant,
  deleteTenant,
  listTenants,
  createTenantApiKey,
  deleteTenantApiKey,
  verifyTenantApiKey,
} from '../../src/../src/services/tenant';
import type { TenantConfig } from '../../src/../src/services/tenant';

describe('Tenant Service', () => {
  // Helper to create valid tenant config
  const createValidConfig = (name: string): Omit<TenantConfig, 'tenant_id' | 'created_at' | 'updated_at'> => ({
    name,
    status: 'active',
    plan: 'free',
    settings: {},
    limits: {
      daily_requests: 1000,
      daily_tokens: 100000,
      monthly_cost: 100,
      max_api_keys: 5,
      concurrent_requests: 10,
    },
  });

  describe('createTenant', () => {
    it('should create new tenant', async () => {
      const tenant = await createTenant(createValidConfig('New Tenant'));
      expect(tenant.tenant_id).toMatch(/^tenant_/);
      expect(tenant.name).toBe('New Tenant');
      expect(tenant.plan).toBe('free');
    });
  });

  describe('getTenant', () => {
    it('should return default tenant', () => {
      const tenant = getTenant('default');
      expect(tenant).toBeDefined();
      expect(tenant?.tenant_id).toBe('default');
    });

    it('should return null for non-existent tenant', () => {
      const tenant = getTenant('non-existent');
      expect(tenant).toBeNull();
    });
  });

  describe('updateTenant', () => {
    it('should update tenant properties', async () => {
      const updated = await updateTenant('default', { name: 'Updated Name' });
      expect(updated?.name).toBe('Updated Name');
    });

    it('should return null for non-existent tenant', async () => {
      const updated = await updateTenant('non-existent', { name: 'Test' });
      expect(updated).toBeNull();
    });
  });

  describe('deleteTenant', () => {
    it('should not delete default tenant', async () => {
      const result = await deleteTenant('default');
      expect(result).toBe(false);
    });
  });

  describe('listTenants', () => {
    it('should return array of tenants', () => {
      const tenants = listTenants();
      expect(Array.isArray(tenants)).toBe(true);
      expect(tenants.length).toBeGreaterThan(0);
    });
  });

  describe('createTenantApiKey', () => {
    it('should add API key to tenant', async () => {
      const result = await createTenantApiKey('default', 'Test Key');
      expect(result).toBeDefined();
    });
  });

  describe('deleteTenantApiKey', () => {
    it('should remove API key from tenant', async () => {
      const key = await createTenantApiKey('default', 'Test');
      const result = deleteTenantApiKey(key!.key);
      expect(result).toBe(true);
    });
  });

  describe('default_model in key policy', () => {
    it('should create key with default_model', async () => {
      const key = await createTenantApiKey('default', 'Test Key', undefined, {
        allowed_models: ['gpt-4o'],
        default_model: 'gpt-4o',
      });
      expect(key).toBeDefined();
      expect(key!.default_model).toBe('gpt-4o');
    });

    it('should create key with default_model not in allowed_models', async () => {
      const key = await createTenantApiKey('default', 'Test Key', undefined, {
        allowed_models: ['gpt-4o'],
        default_model: 'claude-3',
      });
      expect(key).toBeDefined();
      expect(key!.default_model).toBe('claude-3');
      expect(key!.allowed_models).toEqual(['gpt-4o']);
    });
  });

  describe('verifyTenantApiKey', () => {
    it('should verify API key', async () => {
      const key = await createTenantApiKey('default', 'Test');
      const result = verifyTenantApiKey(key!.key);
      expect(result.valid).toBe(true);
    });

    it('should reject invalid key', () => {
      const result = verifyTenantApiKey('sk-invalid-key');
      expect(result.valid).toBe(false);
    });
  });
});
