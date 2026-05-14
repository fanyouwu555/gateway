/**
 * Provider Registry 测试
 */
import { getProviderNames, hasProvider } from '../providers';
import { initProviders } from '../providers/registry';

describe('Provider Registry', () => {
  beforeAll(() => {
    initProviders();
  });

  describe('getProviderNames', () => {
    it('should return list of provider names', () => {
      const names = getProviderNames();
      expect(names).toContain('openai');
      expect(names).toContain('deepseek');
      expect(names).toContain('anthropic');
      expect(names).toContain('moonshot');
    });
  });

  describe('hasProvider', () => {
    it('should return true for registered provider', () => {
      expect(hasProvider('openai')).toBe(true);
      expect(hasProvider('deepseek')).toBe(true);
      expect(hasProvider('anthropic')).toBe(true);
    });

    it('should return false for non-registered provider', () => {
      expect(hasProvider('non-existent')).toBe(false);
    });
  });
});