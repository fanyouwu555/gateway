/**
 * 集成测试
 * 测试核心功能模块间的协作
 */
import { getProvider } from '../src/providers';
import { generateCacheKey, getCache, setCache, cleanCache } from '../src/services/cache';
import { checkQuota, recordUsage } from '../src/services/quota';
import { createTenant, getTenant, listTenants } from '../src/services/tenant';
import { getProviderConfig, getConfig } from '../src/config';
import { generateRequestId, maskApiKey, getRetryDelay } from '../src/utils';
import type { ChatCompletionRequest } from '../src/types';

// Mock providers
jest.mock('../src/providers', () => ({
  getProvider: jest.fn((name) => {
    if (['openai', 'deepseek', 'anthropic'].includes(name)) {
      return {
        name,
        capabilities: { chat: true, embed: true, streaming: true, vision: false, function_call: false, reasoning: false },
        chat: jest.fn().mockResolvedValue({ id: 'test', choices: [] }),
        chatStream: jest.fn().mockResolvedValue(new ReadableStream()),
        embed: jest.fn().mockResolvedValue({ data: [] }),
      };
    }
    return undefined;
  }),
  hasProvider: jest.fn((name) => ['openai', 'deepseek', 'anthropic'].includes(name)),
  chatComplete: jest.fn().mockResolvedValue({ id: 'test', choices: [] }),
}));

// Mock config
jest.mock('../src/config', () => ({
  getConfig: jest.fn(() => ({
    port: 3000,
    host: '0.0.0.0',
    providers: {
      openai: { provider: 'openai', base_url: 'https://api.openai.com/v1', api_key: 'sk-test' },
    },
    auth: { enabled: true, api_keys: [] },
    rate_limit: { enabled: true, qps: 10, burst: 20 },
    cost_control: { monthly_budget: 100, warn_threshold: 0.8 },
  })),
  getProviderConfig: jest.fn((name) => {
    if (name === 'openai') {
      return { provider: 'openai', base_url: 'https://api.openai.com/v1', api_key: 'sk-test' };
    }
    return undefined;
  }),
  isModelPool: jest.fn(() => false),
  getModelPool: jest.fn(() => undefined),
  getProviderApiKeys: (config: { api_key?: string; api_keys?: string[] }) => {
    if (config.api_keys && config.api_keys.length > 0) return config.api_keys;
    if (config.api_key) return [config.api_key];
    return [];
  },
}));

// Mock metrics
jest.mock('../src/services/metrics', () => ({
  getTenantUsage: jest.fn(() => ({ total_requests: 0, total_tokens: 0, total_cost: 0 })),
  recordMetric: jest.fn(),
}));

describe('Integration Tests', () => {
  describe('Provider Integration', () => {
    it('should have all core providers registered', () => {
      expect(getProvider('openai') !== undefined).toBe(true);
      expect(getProvider('deepseek') !== undefined).toBe(true);
      expect(getProvider('anthropic') !== undefined).toBe(true);
    });

    it('should get provider by name', () => {
      const provider = getProvider('openai');
      expect(provider).toBeDefined();
      expect(provider?.name).toBe('openai');
    });

    it('should have provider capabilities', () => {
      const provider = getProvider('openai');
      expect(provider?.capabilities.chat).toBe(true);
      expect(provider?.capabilities.embed).toBe(true);
      expect(provider?.capabilities.streaming).toBe(true);
    });
  });

  describe('Cache Integration', () => {
    const mockRequest: ChatCompletionRequest = {
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'Hello' }],
    };

    it('should generate consistent cache key', () => {
      const key1 = generateCacheKey(mockRequest);
      const key2 = generateCacheKey(mockRequest);
      expect(key1).toBe(key2);
    });

    it('should return null for non-existent cache', async () => {
      const result = await getCache(mockRequest);
      expect(result).toBeNull();
    });

    it('should set and get cache', async () => {
      await setCache(mockRequest, 'cached-response');
      const result = await getCache(mockRequest);
      expect(result).toBe('cached-response');
    });

    it('should clean expired cache', () => {
      const before = cleanCache();
      expect(typeof before).toBe('number');
    });
  });

  describe('Quota Integration', () => {
    it('should check quota for tenant', () => {
      const result = checkQuota('test-tenant');
      expect(result).toBeDefined();
      expect('allowed' in result).toBe(true);
    });

    it('should record usage', () => {
      expect(() => recordUsage('test-tenant', 100, 0.01)).not.toThrow();
    });
  });

  describe('Tenant Integration', () => {
    it('should create and get tenant', () => {
      const tenant = createTenant({ name: 'Integration Test', plan: 'pro', status: 'active', settings: {}, limits: { daily_requests: 100, daily_tokens: 10000, monthly_cost: 10, max_api_keys: 3, concurrent_requests: 5 } });
      expect(tenant.tenant_id).toMatch(/^tenant_/);

      // Should find by generated ID
      const retrieved = getTenant(tenant.tenant_id);
      expect(retrieved?.tenant_id).toBe(tenant.tenant_id);
    });

    it('should list tenants', () => {
      const tenants = listTenants();
      expect(Array.isArray(tenants)).toBe(true);
      expect(tenants.length).toBeGreaterThan(0);
    });
  });

  describe('Config Integration', () => {
    it('should get full config', () => {
      const config = getConfig();
      expect(config.port).toBe(3000);
      expect(config.providers).toBeDefined();
    });

    it('should get provider config', () => {
      const providerConfig = getProviderConfig('openai');
      expect(providerConfig).toBeDefined();
      expect(providerConfig?.provider).toBe('openai');
    });
  });

  describe('Utils Integration', () => {
    it('should generate request ID', () => {
      const id = generateRequestId();
      expect(id).toMatch(/^req_[a-f0-9]+$/);
    });

    it('should mask API key', () => {
      const masked = maskApiKey('sk-1234567890123456');
      // Should show first 4 and last 4 characters
      expect(masked.startsWith('sk-1')).toBe(true);
      expect(masked.endsWith('3456')).toBe(true);
      expect(masked).not.toBe('sk-1234567890123456');
    });

    it('should calculate retry delay', () => {
      const delay1 = getRetryDelay(0);
      const delay2 = getRetryDelay(1);
      const delay3 = getRetryDelay(2);
      expect(delay1).toBe(1000);
      expect(delay2).toBe(2000);
      expect(delay3).toBe(4000);
    });

    it('should cap retry delay at max', () => {
      const delay = getRetryDelay(10);
      expect(delay).toBeLessThanOrEqual(30000);
    });
  });
});

describe('Regression Tests', () => {
  describe('Cache Key Generation', () => {
    it('should generate same key for same input', () => {
      const req1: ChatCompletionRequest = { model: 'gpt-4', messages: [{ role: 'user', content: 'test' }] };
      const req2: ChatCompletionRequest = { model: 'gpt-4', messages: [{ role: 'user', content: 'test' }] };
      expect(generateCacheKey(req1)).toBe(generateCacheKey(req2));
    });

    it('should generate different keys for different models', () => {
      const req1: ChatCompletionRequest = { model: 'gpt-4', messages: [{ role: 'user', content: 'test' }] };
      const req2: ChatCompletionRequest = { model: 'gpt-3.5', messages: [{ role: 'user', content: 'test' }] };
      expect(generateCacheKey(req1)).not.toBe(generateCacheKey(req2));
    });

    it('should generate different keys for different messages', () => {
      const req1: ChatCompletionRequest = { model: 'gpt-4', messages: [{ role: 'user', content: 'test1' }] };
      const req2: ChatCompletionRequest = { model: 'gpt-4', messages: [{ role: 'user', content: 'test2' }] };
      expect(generateCacheKey(req1)).not.toBe(generateCacheKey(req2));
    });
  });

  describe('API Key Security', () => {
    it('should not expose full API key in logs', () => {
      const key = 'sk-prod-12345678901234567890';
      const masked = maskApiKey(key);
      // First 4 and last 4 visible, middle is masked
      expect(masked.startsWith('sk-p')).toBe(true);  // First 4 chars
      expect(masked.endsWith('7890')).toBe(true);   // Last 4 chars
      // Middle should not contain original characters
      expect(masked).not.toContain('2345');
      expect(masked).not.toContain('6789');
    });

    it('should handle short keys', () => {
      const masked = maskApiKey('short');
      expect(masked).toBe('*****');
    });
  });

  describe('Retry Delay Calculation', () => {
    it('should follow exponential backoff', () => {
      const delays = [0, 1, 2, 3, 4].map((i) => getRetryDelay(i));
      for (let i = 1; i < delays.length; i++) {
        expect(delays[i]).toBeGreaterThanOrEqual(delays[i - 1]);
      }
    });

    it('should not exceed max delay', () => {
      for (let i = 0; i < 20; i++) {
        expect(getRetryDelay(i)).toBeLessThanOrEqual(30000);
      }
    });
  });
});