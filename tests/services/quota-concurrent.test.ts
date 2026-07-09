/**
 * QuotaStore concurrent increment tests
 */
import { resetQuotaStore, recordUsage, checkQuota, setTenantLimits } from '../../src/services/quota';

describe('QuotaStore concurrent increment', () => {
  beforeEach(() => {
    resetQuotaStore();
  });

  it('should increment correctly under concurrent requests', async () => {
    const tenantId = 'test-tenant';
    setTenantLimits(tenantId, { daily_requests: 1000, daily_tokens: 10000 });

    const promises = Array.from({ length: 20 }, () =>
      recordUsage(tenantId, 10)
    );
    await Promise.all(promises);

    const result = checkQuota(tenantId);
    expect(result.allowed).toBe(true);
    expect(result.remaining_requests).toBe(980);
    expect(result.remaining_tokens).toBe(9800);
  });

  it('should not exceed daily request limit under concurrent requests', async () => {
    const tenantId = 'test-tenant-2';
    setTenantLimits(tenantId, { daily_requests: 10 });

    const promises = Array.from({ length: 20 }, () =>
      recordUsage(tenantId, 1)
    );
    await Promise.all(promises);

    const result = checkQuota(tenantId);
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('Daily request limit exceeded');
  });
});
