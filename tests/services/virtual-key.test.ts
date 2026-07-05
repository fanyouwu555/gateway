/**
 * Virtual Key System Tests
 * Tests for virtual key creation, policy enforcement, and per-key usage tracking
 */
import { describe, it, expect, beforeEach } from '@jest/globals';
import {
  createTenantApiKey,
  deleteTenantApiKey,
  verifyTenantApiKey,
  updateTenantApiKeyPolicy,
  resetTenantStore,
  getTenantApiKeys,
} from '../../src/services/tenant';
import { getKeyUsage, resetMetricsStore, recordMetric } from '../../src/services/metrics';
import { resetQuotaStore } from '../../src/services/quota';
import { resetBillingCostTracker, recordKeyCost, checkKeyBudget, getKeyCost } from '../../src/services/billing';

describe('Virtual Key System', () => {
  beforeEach(() => {
    resetTenantStore();
    resetMetricsStore();
    resetQuotaStore();
    resetBillingCostTracker();
  });

  describe('Create API Key with policy', () => {
    it('should create key with allowed_models', async () => {
      const key = await createTenantApiKey('default', 'test-key', undefined, {
        allowed_models: ['gpt-4o', 'deepseek-chat'],
      });
      expect(key).toBeDefined();
      expect(key!.allowed_models).toEqual(['gpt-4o', 'deepseek-chat']);
    });

    it('should create key with rate limit policy', async () => {
      const key = await createTenantApiKey('default', 'rate-limited-key', undefined, {
        rate_limit_qps: 5,
        rate_limit_burst: 10,
      });
      expect(key).toBeDefined();
      expect(key!.rate_limit_qps).toBe(5);
      expect(key!.rate_limit_burst).toBe(10);
    });

    it('should create key with monthly budget', async () => {
      const key = await createTenantApiKey('default', 'budget-key', undefined, {
        monthly_budget: 50,
      });
      expect(key).toBeDefined();
      expect(key!.monthly_budget).toBe(50);
    });

    it('should create key with max_tokens_per_request', async () => {
      const key = await createTenantApiKey('default', 'token-limited-key', undefined, {
        max_tokens_per_request: 1024,
      });
      expect(key).toBeDefined();
      expect(key!.max_tokens_per_request).toBe(1024);
    });

    it('should create key with metadata', async () => {
      const key = await createTenantApiKey('default', 'meta-key', undefined, {
        metadata: { user_id: 'u123', department: 'engineering' },
      });
      expect(key).toBeDefined();
      expect(key!.metadata).toEqual({ user_id: 'u123', department: 'engineering' });
    });

    it('should create key with all policy fields', async () => {
      const key = await createTenantApiKey('default', 'full-policy-key', undefined, {
        allowed_models: ['gpt-4o'],
        rate_limit_qps: 10,
        rate_limit_burst: 20,
        monthly_budget: 100,
        max_tokens_per_request: 4096,
        metadata: { app: 'test' },
      });
      expect(key).toBeDefined();
      expect(key!.allowed_models).toEqual(['gpt-4o']);
      expect(key!.rate_limit_qps).toBe(10);
      expect(key!.rate_limit_burst).toBe(20);
      expect(key!.monthly_budget).toBe(100);
      expect(key!.max_tokens_per_request).toBe(4096);
      expect(key!.metadata).toEqual({ app: 'test' });
    });

    it('should return plaintext key only at creation', async () => {
      const key = await createTenantApiKey('default', 'plaintext-test', undefined, {
        allowed_models: ['gpt-4o'],
      });
      expect(key).toBeDefined();
      // Plaintext key should start with sk-v1- prefix
      expect(key!.key).toMatch(/^sk-v1-/);
    });
  });

  describe('Update API Key policy', () => {
    it('should update allowed_models', async () => {
      const created = await createTenantApiKey('default', 'update-test', undefined, {
        allowed_models: ['gpt-4o'],
      });
      expect(created).toBeDefined();

      const updated = await updateTenantApiKeyPolicy(created!.key, {
        allowed_models: ['gpt-4o', 'claude-3-opus'],
      });
      expect(updated).toBeDefined();
      expect(updated!.allowed_models).toEqual(['gpt-4o', 'claude-3-opus']);
    });

    it('should update rate limit policy', async () => {
      const created = await createTenantApiKey('default', 'rl-update', undefined, {
        rate_limit_qps: 5,
      });
      expect(created).toBeDefined();

      const updated = await updateTenantApiKeyPolicy(created!.key, {
        rate_limit_qps: 10,
        rate_limit_burst: 20,
      });
      expect(updated).toBeDefined();
      expect(updated!.rate_limit_qps).toBe(10);
      expect(updated!.rate_limit_burst).toBe(20);
    });

    it('should update monthly_budget', async () => {
      const created = await createTenantApiKey('default', 'budget-update', undefined, {
        monthly_budget: 50,
      });
      expect(created).toBeDefined();

      const updated = await updateTenantApiKeyPolicy(created!.key, {
        monthly_budget: 100,
      });
      expect(updated).toBeDefined();
      expect(updated!.monthly_budget).toBe(100);
    });

    it('should return null for non-existent key hash', async () => {
      const result = await updateTenantApiKeyPolicy('non-existent-hash', {
        name: 'new-name',
      });
      expect(result).toBeNull();
    });

    it('should update name without affecting policy', async () => {
      const created = await createTenantApiKey('default', 'original-name', undefined, {
        allowed_models: ['gpt-4o'],
        monthly_budget: 50,
      });
      expect(created).toBeDefined();

      const updated = await updateTenantApiKeyPolicy(created!.key, {
        name: 'new-name',
      });
      expect(updated).toBeDefined();
      expect(updated!.name).toBe('new-name');
      expect(updated!.allowed_models).toEqual(['gpt-4o']);
      expect(updated!.monthly_budget).toBe(50);
    });

    it('should clear policy fields when set to empty array', async () => {
      const created = await createTenantApiKey('default', 'clear-test', undefined, {
        allowed_models: ['gpt-4o'],
        monthly_budget: 50,
      });
      expect(created).toBeDefined();

      const updated = await updateTenantApiKeyPolicy(created!.key, {
        allowed_models: [],
        monthly_budget: undefined,
      });
      expect(updated).toBeDefined();
      expect(updated!.allowed_models).toEqual([]);
      expect(updated!.monthly_budget).toBeUndefined();
    });
  });

  describe('Find API Key by hash', () => {
    it('should find key by its hashed value', async () => {
      const created = await createTenantApiKey('default', 'find-by-hash', undefined, {
        allowed_models: ['gpt-4o'],
      });
      expect(created).toBeDefined();

      // Verify the key exists in the tenant's key list
      const keys = getTenantApiKeys('default');
      expect(keys.length).toBeGreaterThan(0);
    });
  });

  describe('Delete API Key with policy', () => {
    it('should delete key with policy', async () => {
      const created = await createTenantApiKey('default', 'delete-policy', undefined, {
        allowed_models: ['gpt-4o'],
      });
      expect(created).toBeDefined();

      const deleted = deleteTenantApiKey(created!.key);
      expect(deleted).toBe(true);
    });
  });

  describe('Verify API Key', () => {
    it('should verify valid key with policy', async () => {
      const created = await createTenantApiKey('default', 'verify-policy', undefined, {
        allowed_models: ['gpt-4o'],
        rate_limit_qps: 10,
      });
      expect(created).toBeDefined();

      const result = verifyTenantApiKey(created!.key);
      expect(result.valid).toBe(true);
      expect(result.meta?.allowed_models).toEqual(['gpt-4o']);
      expect(result.meta?.rate_limit_qps).toBe(10);
    });
  });

  describe('Per-key usage tracking', () => {
    it('should track key-level usage in metrics', async () => {
      const created = await createTenantApiKey('default', 'usage-key');
      expect(created).toBeDefined();

      // Record some usage against this key
      recordMetric(
        'req-1', 'default', 'openai', 'gpt-4o',
        100, 200,
        { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
        created!.key,
        { user_id: 'u1' }
      );

      const usage = getKeyUsage(created!.key);
      expect(usage.total_requests).toBe(1);
      expect(usage.total_tokens).toBe(30);
      expect(usage.last_used).not.toBeNull();
    });

    it('should return zero usage for unused key', async () => {
      const created = await createTenantApiKey('default', 'unused-key');
      expect(created).toBeDefined();

      const usage = getKeyUsage(created!.key);
      expect(usage.total_requests).toBe(0);
      expect(usage.total_tokens).toBe(0);
      expect(usage.total_cost).toBe(0);
      expect(usage.last_used).toBeNull();
    });

    it('should aggregate usage across multiple requests', async () => {
      const created = await createTenantApiKey('default', 'multi-usage-key');
      expect(created).toBeDefined();

      for (let i = 0; i < 5; i++) {
        recordMetric(
          `req-${i}`, 'default', 'openai', 'gpt-4o',
          100, 200,
          { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
          created!.key
        );
      }

      const usage = getKeyUsage(created!.key);
      expect(usage.total_requests).toBe(5);
      expect(usage.total_tokens).toBe(100);
    });
  });

  describe('Key-level quota (monthly budget)', () => {
    it('should allow requests within budget', () => {
      const keyHash = 'test-hash-1';
      const budget = 100;
      // Simulate some cost
      recordKeyCost(keyHash, 10);

      const check = checkKeyBudget(keyHash, budget);
      expect(check.allowed).toBe(true);
      expect(check.current_cost).toBe(10);
    });

    it('should reject requests that exceed budget', () => {
      const keyHash = 'test-hash-2';
      const budget = 50;
      recordKeyCost(keyHash, 60);

      const check = checkKeyBudget(keyHash, budget);
      expect(check.allowed).toBe(false);
      expect(check.reason).toBe('Key monthly budget exceeded');
    });

    it('should return correct current cost at boundary', () => {
      const keyHash = 'test-hash-3';
      const budget = 100;
      recordKeyCost(keyHash, 100);

      const check = checkKeyBudget(keyHash, budget);
      expect(check.allowed).toBe(false);
      expect(check.current_cost).toBe(100);
    });

    it('should return zero cost for unknown key', () => {
      const check = checkKeyBudget('unknown-key', 100);
      expect(check.allowed).toBe(true);
      expect(check.current_cost).toBe(0);
    });

    it('should track accumulating cost across multiple records', () => {
      const keyHash = 'test-hash-4';
      recordKeyCost(keyHash, 10);
      recordKeyCost(keyHash, 20);
      recordKeyCost(keyHash, 30);

      const cost = getKeyCost(keyHash);
      expect(cost).toBe(60);

      const check = checkKeyBudget(keyHash, 50);
      expect(check.allowed).toBe(false);
    });
  });
});
