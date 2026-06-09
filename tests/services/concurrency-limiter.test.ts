import { ConcurrencyLimiter } from '../../src/services/concurrency-limiter';

describe('ConcurrencyLimiter', () => {
  let limiter: ConcurrencyLimiter;

  beforeEach(() => {
    limiter = new ConcurrencyLimiter();
  });

  afterEach(() => {
    limiter.clear();
  });

  it('should allow requests under limit', () => {
    expect(limiter.acquire('tenant-1', 2)).toBe(true);
    expect(limiter.acquire('tenant-1', 2)).toBe(true);
  });

  it('should block requests over limit', () => {
    limiter.acquire('tenant-1', 1);
    expect(limiter.acquire('tenant-1', 1)).toBe(false);
  });

  it('should release slot on done', () => {
    limiter.acquire('tenant-1', 1);
    limiter.release('tenant-1');
    expect(limiter.acquire('tenant-1', 1)).toBe(true);
  });

  it('should track per-tenant independently', () => {
    limiter.acquire('tenant-1', 1);
    expect(limiter.acquire('tenant-2', 1)).toBe(true);
  });
});
