/**
 * 配置管理测试
 */
import { getConfig, getProviderConfig, getRoutingStrategy, getProviderForModel, reloadConfig, resolveModelAlias, setConfig } from '../../src/../src/config/index';

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
      // 设置环境变量后重新加载配置
      process.env.OPENAI_API_KEY = 'sk-test-key';
      process.env.DEEPSEEK_API_KEY = 'sk-deepseek-key';
      reloadConfig();

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
      const provider = getProviderForModel('ark-code-latest');
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

  describe('resolveModelAlias', () => {
    it('should return original name when no alias exists', () => {
      const resolved = resolveModelAlias('gpt-4o');
      expect(resolved).toBe('gpt-4o');
    });

    it('should resolve alias to actual model name', () => {
      setConfig({ model_aliases: { fast: 'gpt-4o-mini', smart: 'gpt-4o' } });
      expect(resolveModelAlias('fast')).toBe('gpt-4o-mini');
      expect(resolveModelAlias('smart')).toBe('gpt-4o');
    });

    it('should detect circular aliases', () => {
      setConfig({ model_aliases: { a: 'b', b: 'a' } });
      expect(resolveModelAlias('a')).toBe('a');
    });

    it('should stop at max depth', () => {
      setConfig({ model_aliases: { a: 'b', b: 'c', c: 'd', d: 'e', e: 'f', f: 'g' } });
      expect(resolveModelAlias('a')).toBe('f');
    });

    it('should stop when alias points to itself', () => {
      setConfig({ model_aliases: { same: 'same' } });
      expect(resolveModelAlias('same')).toBe('same');
    });
  });

  describe('getProviderForModel', () => {
    it('should match model prefix', () => {
      const provider = getProviderForModel('ark-code-2024');
      expect(provider).toBe('volcano');
    });
  });

  describe('setConfig', () => {
    it('should deep merge auth config', () => {
      setConfig({ auth: { enabled: false } });
      const config = getConfig();
      expect(config.auth.enabled).toBe(false);
    });

    it('should deep merge providers config', () => {
      setConfig({ providers: { openai: { provider: 'openai', base_url: 'https://custom.com', api_key: 'sk-test' } } });
      const config = getConfig();
      expect(config.providers.openai?.base_url).toBe('https://custom.com');
    });

    it('should hash new api keys in auth', () => {
      setConfig({ auth: { api_keys: [{ key: 'plaintext-key', tenant_id: 'test', name: 'test', created_at: Date.now() }] } });
      const config = getConfig();
      expect(config.auth.api_keys?.[0]?.key).not.toBe('plaintext-key');
    });
  });

  describe('loadConfigFile', () => {
    it('should handle missing config file', () => {
      const { reloadConfig } = require('../../src/config');
      const config = reloadConfig('./nonexistent-config.json');
      expect(config).toBeDefined();
      expect(config.port).toBeGreaterThan(0);
    });
  });

  describe('overrideFromEnv', () => {
    it('should override with env vars', () => {
      process.env.API_KEYS = 'key1,key2';
      process.env.OPENAI_API_KEY = 'sk-test';
      process.env.FAILOVER_ENABLED = 'true';
      process.env.SEMANTIC_CACHE_ENABLED = 'true';
      const { reloadConfig } = require('../../src/config');
      const config = reloadConfig();
      expect(config.auth.api_keys?.length).toBeGreaterThanOrEqual(2);
      expect(config.providers.openai?.api_key).toBe('sk-test');
      expect(config.failover?.enabled).toBe(true);
      expect(config.semantic_cache?.enabled).toBe(true);
      delete process.env.API_KEYS;
      delete process.env.OPENAI_API_KEY;
      delete process.env.FAILOVER_ENABLED;
      delete process.env.SEMANTIC_CACHE_ENABLED;
    });
  });
});