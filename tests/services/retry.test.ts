/**
 * Retry Service Tests
 */
import { withRetry, calculateBackoff, isRetryableError } from '../../src/services/retry';

describe('Retry Service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('calculateBackoff', () => {
    it('should return baseDelay on first attempt', () => {
      const delay = calculateBackoff(0, 1000, 10000);
      expect(delay).toBeGreaterThanOrEqual(500);
      expect(delay).toBeLessThanOrEqual(1500);
    });

    it('should double delay on each attempt', () => {
      const d0 = calculateBackoff(0, 1000, 10000);
      const d1 = calculateBackoff(1, 1000, 10000);
      const d2 = calculateBackoff(2, 1000, 10000);
      expect(d1).toBeGreaterThan(d0);
      expect(d2).toBeGreaterThan(d1);
    });

    it('should cap delay at maxDelay', () => {
      const delay = calculateBackoff(10, 1000, 5000);
      expect(delay).toBeLessThanOrEqual(5500); // maxDelay + jitter
    });
  });

  describe('isRetryableError', () => {
    it('should retry on 5xx Response', () => {
      const res = new Response(null, { status: 503 });
      expect(isRetryableError(res)).toBe(true);
    });

    it('should not retry on 4xx Response', () => {
      const res = new Response(null, { status: 400 });
      expect(isRetryableError(res)).toBe(false);
    });

    it('should retry on network errors', () => {
      expect(isRetryableError(new Error('ECONNREFUSED'))).toBe(true);
      expect(isRetryableError(new Error('ECONNRESET'))).toBe(true);
      expect(isRetryableError(new Error('ENOTFOUND'))).toBe(true);
      expect(isRetryableError(new Error('timeout'))).toBe(true);
      expect(isRetryableError(new Error('Network error'))).toBe(true);
      expect(isRetryableError(new Error('Socket hang up'))).toBe(true);
    });

    it('should not retry on non-network errors', () => {
      expect(isRetryableError(new Error('Invalid API key'))).toBe(false);
      expect(isRetryableError(new Error('Bad request'))).toBe(false);
    });

    it('should not retry on non-Error types', () => {
      expect(isRetryableError('string error')).toBe(false);
      expect(isRetryableError(42)).toBe(false);
      expect(isRetryableError(null)).toBe(false);
    });
  });

  describe('withRetry', () => {
    it('should return result on first success', async () => {
      const fn = jest.fn().mockResolvedValue('success');
      const result = await withRetry(fn);
      expect(result).toBe('success');
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('should retry on retryable error then succeed', async () => {
      const fn = jest
        .fn()
        .mockRejectedValueOnce(new Error('ECONNRESET'))
        .mockResolvedValue('success');

      const result = await withRetry(fn, { maxRetries: 3, baseDelay: 10, maxDelay: 50 });
      expect(result).toBe('success');
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it('should throw after maxRetries exhausted', async () => {
      const fn = jest.fn().mockRejectedValue(new Error('ECONNRESET'));

      await expect(
        withRetry(fn, { maxRetries: 2, baseDelay: 10, maxDelay: 50 })
      ).rejects.toThrow('ECONNRESET');

      expect(fn).toHaveBeenCalledTimes(3); // initial + 2 retries
    });

    it('should not retry on non-retryable error', async () => {
      const fn = jest.fn().mockRejectedValue(new Error('Invalid request'));

      await expect(
        withRetry(fn, { maxRetries: 3, baseDelay: 10, maxDelay: 50 })
      ).rejects.toThrow('Invalid request');

      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('should use custom retry options', async () => {
      const fn = jest
        .fn()
        .mockRejectedValueOnce(new Error('timeout'))
        .mockRejectedValueOnce(new Error('timeout'))
        .mockResolvedValue('success');

      const result = await withRetry(fn, { maxRetries: 5, baseDelay: 5, maxDelay: 20 });
      expect(result).toBe('success');
      expect(fn).toHaveBeenCalledTimes(3);
    });
  });
});
