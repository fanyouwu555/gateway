/**
 * 配置管理测试
 */
import { getConfig, getProviderConfig, getRoutingStrategy, getProviderForModel, reloadConfig } from '../../src/../src/config/index';

// 测试环境变量
const originalEnv = process.env;

beforeEach(() => {
  jest.resetModules();
  process.env = { ...originalEnv };
});

afterAll(() => {
  process.env = originalEnv;
});

describe('Config', () => {
  describe('getConfig', () => {
    it('should return configuration', () => {
      const config = getConfig();
      expect(config).toBeDefined();
      expect(config.port).toBeDefined();
    });

    it('should have default values', () => {
      const config = getConfig();
      expect(config.host).toBe('0.0.0.0');
      expect(config.log_level).toBeDefined();
    });
  });

  describe('getProviderConfig', () => {
    it('should return provider config', () => {
      // 设置环境变量
      process.env.OPENAI_API_KEY = 'sk-test-key';
      process.env.DEEPSEEK_API_KEY = 'sk-deepseek-key';

      const openaiConfig = getProviderConfig('openai');
      expect(openaiConfig).toBeDefined();
      expect(openaiConfig?.provider).toBe('openai');
    });

    it('should return undefined for unknown provider', () => {
      const config = getProviderConfig('unknown-provider');
      expect(config).toBeUndefined();
    });
  });

  describe('getRoutingStrategy', () => {
    it('should return default routing strategy', () => {
      const strategy = getRoutingStrategy();
      expect(strategy).toBeDefined();
      expect(strategy?.name).toBe('default');
    });

    it('should return custom strategy by name', () => {
      const strategy = getRoutingStrategy('default');
      expect(strategy).toBeDefined();
    });
  });

  describe('getProviderForModel', () => {
    it('should return provider for known model', () => {
      const provider = getProviderForModel('gpt-4o');
      expect(provider).toBeDefined();
    });

    it('should return default provider for unknown model', () => {
      const provider = getProviderForModel('unknown-model');
      expect(provider).toBeDefined();
    });
  });

  describe('reloadConfig', () => {
    it('should reload configuration', () => {
      const config = reloadConfig();
      expect(config).toBeDefined();
    });
  });
});