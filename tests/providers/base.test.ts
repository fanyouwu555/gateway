/**
 * Provider Registry 测试
 */
import { getProviderNames } from '../../src/providers';
import { initProviders } from '../../src/providers/registry';

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
      expect(names).toContain('volcano');
      expect(names).toContain('kimi-code');
    });
  });
});