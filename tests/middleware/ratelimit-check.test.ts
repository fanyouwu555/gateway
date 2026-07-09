/**
 * Programmable rate-limit check tests
 */
import { checkRateLimit, resetRateLimitStore } from '../../src/middleware/ratelimit';
import { createTenant, resetTenantStore } from '../../src/services/tenant';

jest.mock('../../src/config', () => ({
  getConfig: () => ({
    rate_limit: { enabled: true, qps: 10, burst: 2 },
    auth: { enabled: false, api_keys: [] },
  }),
  resolveModelAlias: jest.fn((alias: string) => alias),
  isModelPool: jest.fn(() => false),
  getModelPool: jest.fn(() => undefined),
}));

describe('checkRateLimit', () => {
  beforeEach(() => {
    resetRateLimitStore();
    resetTenantStore();
  });

  it('should allow requests within burst and return a release callback', async () => {
    const { result, release } = await checkRateLimit({
      tenantId: 't1',
      keyHash: 'hash1',
      isAdminPath: false,
    });
    expect(result.allowed).toBe(true);
    expect(release).toBeDefined();
    release?.();
  });

  it('should block when burst is exceeded', async () => {
    await checkRateLimit({ tenantId: 't1', keyHash: 'hash1', isAdminPath: false });
    const { release } = await checkRateLimit({ tenantId: 't1', keyHash: 'hash1', isAdminPath: false });
    release?.();
    const { result } = await checkRateLimit({ tenantId: 't1', keyHash: 'hash1', isAdminPath: false });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('rate_limit_exceeded');
  });

  it('should block concurrent requests over tenant limit', async () => {
    const tenant = await createTenant({
      name: 'Concurrent Tenant',
      status: 'active',
      plan: 'free',
      settings: {},
      limits: {
        daily_requests: 1000,
        daily_tokens: 100000,
        max_api_keys: 5,
        concurrent_requests: 1,
      },
    });

    const first = await checkRateLimit({
      tenantId: tenant.tenant_id,
      keyHash: 'hash1',
      isAdminPath: false,
    });
    expect(first.result.allowed).toBe(true);

    const second = await checkRateLimit({
      tenantId: tenant.tenant_id,
      keyHash: 'hash1',
      isAdminPath: false,
    });
    expect(second.result.allowed).toBe(false);
    expect(second.result.reason).toBe('concurrent_limit_exceeded');

    first.release?.();
  });
});
