/**
 * Google Provider Tests
 */
import { googleProvider } from '../../src/providers/google';

describe('GoogleProvider', () => {
  it('should be registered', () => {
    expect(googleProvider.name).toBe('google');
  });

  it('should support chat and streaming', () => {
    expect(googleProvider.capabilities.chat).toBe(true);
    expect(googleProvider.capabilities.streaming).toBe(true);
  });

  it('should not support embed', () => {
    expect(googleProvider.capabilities.embed).toBe(false);
  });
});