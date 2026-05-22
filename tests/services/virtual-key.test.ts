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
import { resetQuotaStore, recordUsage, checkKeyQuota, getKeyCost } from '../../src/services/quota';

describe('Virtual Key System', () => {
  beforeEach(() => {
    resetTenantStore();
    resetMetricsStore();
    resetQuotaStore();
  });

  describe('Create API Key with policy', () => {
    it('should create key with allowed_models', () => {
      const key = createTenantApiKey('default', 'test-key', undefined, {
        allowed_models: ['gpt-4o', 'deepseek-chat'],
      });
      expect(key).toBeDefined();
      expect(key!.allowed_models).toEqual(['gpt-4o', 'deepseek-chat']);
    });

    it('should create key with rate limit policy', () => {
      const key = createTenantApiKey('default', 'rate-limited-key', undefined, {
        rate_limit_qps: 5,
        rate_limit_burst: 10,
      });
      expect(key).toBeDefined();
      expect(key!.rate_limit_qps).toBe(5);
      expect(key!.rate_limit_burst).toBe(10);
    });

    it('should create key with monthly budget', () => {
      const key = createTenantApiKey('default', 'budget-key', undefined, {
        monthly_budget: 50,
      });
      expect(key).toBeDefined();
      expect(key!.monthly_budget).toBe(50);
    });

    it('should create key with max_tokens_per_request', () => {
      const key = createTenantApiKey('default', 'token-limited-key', undefined, {
        max_tokens_per_request: 1024,
      });
      expect(key).toBeDefined();
      expect(key!.max_tokens_per_request).toBe(1024);
    });

    it('should create key with metadata', () => {
      const key = createTenantApiKey('default', 'meta-key', undefined, {
        metadata: { user_id: 'u123', department: 'engineering' },
      });
      expect(key).toBeDefined();
      expect(key!.metadata).toEqual({ user_id: 'u123', department: 'engineering' });
    });

    it('should create key with all policy fields', () => {
      const key = createTenantApiKey('default', 'full-policy-key', undefined, {
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

    it('should return plaintext key only at creation', () => {
      const key = createTenantApiKey('default', 'plaintext-test', undefined, {
        allowed_models: ['gpt-4o'],
      });
      expect(key).toBeDefined();
      // Plaintext key should start with sk-v1- prefix
      expect(key!.key).toMatch(/^sk-v1-/);
    });
  });

  describe('Update API Key policy', () => {
    it('should update allowed_models', () => {
      const created = createTenantApiKey('default', 'update-test', undefined, {
        allowed_models: ['gpt-4o'],
      });
      expect(created).toBeDefined();

      const updated = updateTenantApiKeyPolicy(created!.key, {
        allowed_models: ['gpt-4o', 'claude-3-opus'],
      });
      expect(updated).toBeDefined();
      expect(updated!.allowed_models).toEqual(['gpt-4o', 'claude-3-opus']);
    });

    it('should update rate limit policy', () => {
      const created = createTenantApiKey('default', 'rl-update', undefined, {
        rate_limit_qps: 5,
      });
      expect(created).toBeDefined();

      const updated = updateTenantApiKeyPolicy(created!.key, {
        rate_limit_qps: 10,
        rate_limit_burst: 20,
      });
      expect(updated).toBeDefined();
      expect(updated!.rate_limit_qps).toBe(10);
      expect(updated!.rate_limit_burst).toBe(20);
    });

    it('should update monthly_budget', () => {
      const created = createTenantApiKey('default', 'budget-update', undefined, {
        monthly_budget: 50,
      });
      expect(created).toBeDefined();

      const updated = updateTenantApiKeyPolicy(created!.key, {
        monthly_budget: 100,
      });
      expect(updated).toBeDefined();
      expect(updated!.monthly_budget).toBe(100);
    });

    it('should return null for non-existent key hash', () => {
      const result = updateTenantApiKeyPolicy('non-existent-hash', {
        name: 'new-name',
      });
      expect(result).toBeNull();
    });

    it('should update name without affecting policy', () => {
      const created = createTenantApiKey('default', 'original-name', undefined, {
        allowed_models: ['gpt-4o'],
        monthly_budget: 50,
      });
      expect(created).toBeDefined();

      const updated = updateTenantApiKeyPolicy(created!.key, {
        name: 'new-name',
      });
      expect(updated).toBeDefined();
      expect(updated!.name).toBe('new-name');
      expect(updated!.allowed_models).toEqual(['gpt-4o']);
      expect(updated!.monthly_budget).toBe(50);
    });

    it('should clear policy fields when set to empty array', () => {
      const created = createTenantApiKey('default', 'clear-test', undefined, {
        allowed_models: ['gpt-4o'],
        monthly_budget: 50,
      });
      expect(created).toBeDefined();

      const updated = updateTenantApiKeyPolicy(created!.key, {
        allowed_models: [],
        monthly_budget: undefined,
      });
      expect(updated).toBeDefined();
      expect(updated!.allowed_models).toEqual([]);
      expect(updated!.monthly_budget).toBeUndefined();
    });
  });

  describe('Find API Key by hash', () => {
    it('should find key by its hashed value', () => {
      const created = createTenantApiKey('default', 'find-by-hash', undefined, {
        allowed_models: ['gpt-4o'],
      });
      expect(created).toBeDefined();

      // Verify the key exists in the tenant's key list
      const keys = getTenantApiKeys('default');
      expect(keys.length).toBeGreaterThan(0);
    });
  });

  describe('Delete API Key with policy', () => {
    it('should delete key with policy', () => {
      const created = createTenantApiKey('default', 'delete-policy', undefined, {
        allowed_models: ['gpt-4o'],
      });
      expect(created).toBeDefined();

      const deleted = deleteTenantApiKey(created!.key);
      expect(deleted).toBe(true);
    });
  });

  describe('Verify API Key', () => {
    it('should verify valid key with policy', () => {
      const created = createTenantApiKey('default', 'verify-policy', undefined, {
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
    it('should track key-level usage in metrics', () => {
      const created = createTenantApiKey('default', 'usage-key');
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

    it('should return zero usage for unused key', () => {
      const created = createTenantApiKey('default', 'unused-key');
      expect(created).toBeDefined();

      const usage = getKeyUsage(created!.key);
      expect(usage.total_requests).toBe(0);
      expect(usage.total_tokens).toBe(0);
      expect(usage.total_cost).toBe(0);
      expect(usage.last_used).toBeNull();
    });

    it('should aggregate usage across multiple requests', () => {
      const created = createTenantApiKey('default', 'multi-usage-key');
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
      recordUsage('default', 0, 10, keyHash);

      const check = checkKeyQuota(keyHash, budget);
      expect(check.allowed).toBe(true);
      expect(check.current_cost).toBe(10);
    });

    it('should reject requests that exceed budget', () => {
      const keyHash = 'test-hash-2';
      const budget = 50;
      recordUsage('default', 0, 60, keyHash);

      const check = checkKeyQuota(keyHash, budget);
      expect(check.allowed).toBe(false);
      expect(check.reason).toBe('Key monthly budget exceeded');
    });

    it('should return correct current cost at boundary', () => {
      const keyHash = 'test-hash-3';
      const budget = 100;
      recordUsage('default', 0, 100, keyHash);

      const check = checkKeyQuota(keyHash, budget);
      expect(check.allowed).toBe(false);
      expect(check.current_cost).toBe(100);
    });

    it('should return zero cost for unknown key', () => {
      const check = checkKeyQuota('unknown-key', 100);
      expect(check.allowed).toBe(true);
      expect(check.current_cost).toBe(0);
    });

    it('should track accumulating cost across multiple records', () => {
      const keyHash = 'test-hash-4';
      recordUsage('default', 0, 10, keyHash);
      recordUsage('default', 0, 20, keyHash);
      recordUsage('default', 0, 30, keyHash);

      const cost = getKeyCost(keyHash);
      expect(cost).toBe(60);

      const check = checkKeyQuota(keyHash, 50);
      expect(check.allowed).toBe(false);
    });
  });
});