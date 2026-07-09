/**
 * Billing Mode 集成测试
 * 测试 competition / subscription / prepaid 三种计费模式在路由层的行为
 */
import { createApp } from '../../src/app';
import { resetWalletStore, setBalance, getBalance, rechargeBalance } from '../../src/services/wallet';
import { resetQuotaStore } from '../../src/services/quota';
import { resetBillingCostTracker, recordKeyCost } from '../../src/services/billing';

jest.mock('../../src/config', () => ({
  getConfig: jest.fn(() => ({
    port: 3000,
    host: '0.0.0.0',
    log_level: 'info',
    providers: {
      openai: { provider: 'openai', base_url: 'https://api.openai.com/v1', api_key: 'sk-test' },
    },
    routing: [{ name: 'default', rules: [{ model: 'gpt-4o', provider: 'openai' }] }],
    auth: {
      enabled: true,
      api_keys: [
        {
          key: 'competition-key',
          tenant_id: 'default',
          name: 'Competition Key',
          created_at: Date.now(),
          billing_mode: 'competition',
          monthly_budget: 0,
        },
        {
          key: 'subscription-key-active',
          tenant_id: 'default',
          name: 'Subscription Active',
          created_at: Date.now(),
          billing_mode: 'subscription',
          subscription_expires_at: Date.now() + 86400000,
        },
        {
          key: 'subscription-key-expired',
          tenant_id: 'default',
          name: 'Subscription Expired',
          created_at: Date.now(),
          billing_mode: 'subscription',
          subscription_expires_at: Date.now() - 86400000,
        },
        {
          key: 'subscription-key-no-expires',
          tenant_id: 'default',
          name: 'Subscription No Expires',
          created_at: Date.now(),
          billing_mode: 'subscription',
        },
        {
          key: 'monthly-budget-key',
          tenant_id: 'default',
          name: 'Monthly Budget Key',
          created_at: Date.now(),
          billing_mode: 'subscription',
          subscription_expires_at: Date.now() + 86400000,
          monthly_budget: 1,
        },
        {
          key: 'prepaid-key-empty',
          tenant_id: 'default',
          name: 'Prepaid Empty',
          created_at: Date.now(),
          billing_mode: 'prepaid',
        },
        {
          key: 'prepaid-key-funded',
          tenant_id: 'default',
          name: 'Prepaid Funded',
          created_at: Date.now(),
          billing_mode: 'prepaid',
        },
        {
          key: 'admin-dashboard-key-456',
          tenant_id: 'default',
          name: 'Admin Key',
          created_at: Date.now(),
          is_admin: true,
        },
      ],
    },
    rate_limit: { enabled: false, qps: 1000, burst: 1000 },
    cache: { enabled: false, ttl: 60000, max_size: 1000 },
    model_aliases: {},
    model_pools: {},
    pricing: { 'gpt-4o': { input: 30, output: 60 } },
  })),
  getProviderConfig: jest.fn(() => ({ provider: 'openai', base_url: 'https://api.openai.com/v1', api_key: 'sk-test' })),
  getProviderForModel: jest.fn(() => 'openai'),
  getRoutingStrategy: jest.fn(() => ({ name: 'default', rules: [{ model: 'gpt-4o', provider: 'openai' }] })),
  resolveModelAlias: jest.fn((alias: string) => alias),
  isModelPool: jest.fn(() => false),
  getModelPool: jest.fn(() => undefined),
}));

jest.mock('../../src/providers', () => ({
  chatComplete: jest.fn(() => Promise.resolve({
    id: 'resp-1',
    object: 'chat.completion',
    created: Date.now(),
    model: 'gpt-4o',
    choices: [{ index: 0, message: { role: 'assistant', content: 'Hello' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  })),
  chatCompleteStream: jest.fn(() => Promise.resolve(new ReadableStream())),
  getProvider: jest.fn(() => ({
    capabilities: { chat: true, embed: true, streaming: true, vision: true, function_call: true, reasoning: true },
  })),
}));

jest.mock('../../src/services/cache', () => ({
  getCache: jest.fn(() => Promise.resolve(null)),
  setCache: jest.fn(() => Promise.resolve()),
  getLastCacheHitType: jest.fn(() => null),
}));

jest.mock('../../src/services/semantic-cache', () => ({
  getSemanticCache: jest.fn(() => null),
  initSemanticCache: jest.fn(),
}));

jest.mock('../../src/plugins', () => ({
  runGuardrailPlugins: jest.fn(() => Promise.resolve({ allowed: true })),
  runRequestPlugins: jest.fn((_c, req) => Promise.resolve(req)),
  runResponsePlugins: jest.fn((_c, res) => Promise.resolve(res)),
  runTransformPlugins: jest.fn((_c, req) => Promise.resolve(req)),
}));

jest.mock('../../src/services/router', () => ({
  smartRoute: jest.fn(() => ({ provider: 'openai', reason: 'default' })),
  evaluateConditionalRules: jest.fn(() => null),
  recordLatency: jest.fn(),
  recordError: jest.fn(),
}));

jest.mock('../../src/utils', () => ({
  ...jest.requireActual('../../src/utils'),
  verifyApiKey: jest.fn((apiKey: string, hashed: string) => apiKey === hashed),
}));

jest.mock('../../src/services/tenant', () => ({
  listTenants: jest.fn(() => []),
  getTenant: jest.fn(() => null),
  createTenant: jest.fn(() => ({})),
  updateTenant: jest.fn(() => true),
  deleteTenant: jest.fn(() => true),
  getTenantStats: jest.fn(() => ({})),
  getTenantApiKeys: jest.fn(() => []),
  createTenantApiKey: jest.fn(() => ({ key: 'test-key' })),
  deleteTenantApiKey: jest.fn(() => true),
  findTenantApiKeyByHash: jest.fn(() => null),
  findApiKeyByPrefix: jest.fn(() => []),
  updateTenantApiKeyPolicy: jest.fn(() => null),
  getAllTenantApiKeys: jest.fn(() => []),
}));

describe('Billing Mode Integration', () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    resetWalletStore();
    resetQuotaStore();
    resetBillingCostTracker();
    app = createApp();
  });

  const makeRequest = (apiKey: string) =>
    app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: 'Hi' }] }),
    });

  describe('competition mode', () => {
    it('should allow request and bypass billing checks', async () => {
      const res = await makeRequest('competition-key');
      expect(res.status).toBe(200);
    });
  });

  describe('subscription mode', () => {
    it('should allow request when subscription is active', async () => {
      const res = await makeRequest('subscription-key-active');
      expect(res.status).toBe(200);
    });

    it('should reject request when subscription expired', async () => {
      const res = await makeRequest('subscription-key-expired');
      expect(res.status).toBe(403);
      const body = await res.json() as { error: { code: string } };
      expect(body.error.code).toBe('subscription_expired');
    });

    it('should reject request when subscription expiration is not set', async () => {
      const res = await makeRequest('subscription-key-no-expires');
      expect(res.status).toBe(403);
      const body = await res.json() as { error: { code: string } };
      expect(body.error.code).toBe('subscription_expired');
    });
  });

  describe('monthly budget safety valve', () => {
    it('should reject request when monthly budget exceeded', async () => {
      // 先累计成本超过 1 元预算
      await recordKeyCost('monthly-budget-key', 2);
      const res = await makeRequest('monthly-budget-key');
      expect(res.status).toBe(402);
      const body = await res.json() as { error: { code: string } };
      expect(body.error.code).toBe('monthly_budget_exceeded');
    });
  });

  describe('prepaid mode', () => {
    it('should reject request when balance is 0', async () => {
      setBalance('prepaid-key-empty', 0);
      const res = await makeRequest('prepaid-key-empty');
      expect(res.status).toBe(402);
      const body = await res.json() as { error: { code: string } };
      expect(body.error.code).toBe('insufficient_balance');
    });

    it('should allow request and deduct balance after success', async () => {
      setBalance('prepaid-key-funded', 10_000_000); // 10元

      const beforeBalance = getBalance('prepaid-key-funded');
      const res = await makeRequest('prepaid-key-funded');
      expect(res.status).toBe(200);

      const afterBalance = getBalance('prepaid-key-funded');
      expect(afterBalance).toBeLessThan(beforeBalance);
      expect(afterBalance).toBeGreaterThanOrEqual(0);

      // 检查响应头
      const balanceHeader = res.headers.get('X-Remaining-Balance-Micro-Yuan');
      expect(balanceHeader).toBe(afterBalance.toString());
    });
  });
});

describe('Wallet Admin API', () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    resetWalletStore();
    app = createApp();
  });

  const adminAuth = { Authorization: 'Bearer admin-dashboard-key-456' };

  it('GET /v1/tenants/:id/keys/:keyHash/balance should return balance', async () => {
    const { findTenantApiKeyByHash } = require('../../src/services/tenant');
    findTenantApiKeyByHash.mockReturnValueOnce({
      key: 'hash123',
      tenant_id: 't1',
      name: 'test',
      billing_mode: 'prepaid',
    });
    setBalance('hash123', 5_000_000);

    const res = await app.request('/v1/tenants/t1/keys/hash123/balance', { headers: adminAuth });
    expect(res.status).toBe(200);
    const body = await res.json() as { balance_micro_yuan: number };
    expect(body.balance_micro_yuan).toBe(5_000_000);
  });

  it('GET /v1/tenants/:id/keys/:keyHash/balance should return 404 for missing key', async () => {
    const res = await app.request('/v1/tenants/t1/keys/missing/balance', { headers: adminAuth });
    expect(res.status).toBe(404);
  });

  it('POST /v1/tenants/:id/keys/:keyHash/recharge should increase balance', async () => {
    const { findTenantApiKeyByHash } = require('../../src/services/tenant');
    findTenantApiKeyByHash.mockReturnValueOnce({
      key: 'hash123',
      tenant_id: 't1',
      name: 'test',
      billing_mode: 'prepaid',
    });

    const res = await app.request('/v1/tenants/t1/keys/hash123/recharge', {
      method: 'POST',
      headers: { ...adminAuth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount: 10.5, reason: 'Test recharge' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { new_balance_micro_yuan: number; transaction: { type: string; amount_micro_yuan: number } };
    expect(body.new_balance_micro_yuan).toBe(10_500_000);
    expect(body.transaction.type).toBe('recharge');
    expect(body.transaction.amount_micro_yuan).toBe(10_500_000);
  });

  it('POST /v1/tenants/:id/keys/:keyHash/recharge should reject non-positive amount', async () => {
    const { findTenantApiKeyByHash } = require('../../src/services/tenant');
    findTenantApiKeyByHash.mockReturnValueOnce({
      key: 'hash123',
      tenant_id: 't1',
      name: 'test',
      billing_mode: 'prepaid',
    });

    const res = await app.request('/v1/tenants/t1/keys/hash123/recharge', {
      method: 'POST',
      headers: { ...adminAuth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount: 0 }),
    });
    expect(res.status).toBe(400);
  });

  it('GET /v1/tenants/:id/keys/:keyHash/transactions should return list', async () => {
    const { findTenantApiKeyByHash } = require('../../src/services/tenant');
    findTenantApiKeyByHash.mockReturnValueOnce({
      key: 'hash123',
      tenant_id: 't1',
      name: 'test',
      billing_mode: 'prepaid',
    });
    await rechargeBalance('hash123', 1_000_000, 'Initial');
    await rechargeBalance('hash123', 500_000, 'Top up');

    const res = await app.request('/v1/tenants/t1/keys/hash123/transactions?limit=10', { headers: adminAuth });
    expect(res.status).toBe(200);
    const body = await res.json() as { transactions: Array<{ type: string }> };
    expect(body.transactions.length).toBe(2);
    expect(body.transactions[0].type).toBe('recharge');
  });
});
