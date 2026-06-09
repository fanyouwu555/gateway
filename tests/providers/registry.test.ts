/**
 * Provider Registry Tests
 */
const mockWriteLog = jest.fn();
jest.mock('../../src/utils/logger', () => ({
  writeLog: (...args: unknown[]) => mockWriteLog(...args),
}));

const mockGetConfig = jest.fn();
jest.mock('../../src/config', () => ({
  getConfig: (...args: unknown[]) => mockGetConfig(...args),
  isModelPool: jest.fn(() => false),
  getModelPool: jest.fn(() => undefined),
}));

async function importRegistry() {
  jest.resetModules();
  const registry = await import('../../src/providers/registry');
  const providers = await import('../../src/providers');
  return { registry, providers };
}

describe('Provider Registry', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetConfig.mockReturnValue({ dynamicProviders: [] });
  });

  describe('initProviders', () => {
    it('should register all built-in providers', async () => {
      const { registry, providers } = await importRegistry();
      registry.initProviders();
      expect(providers.getProviderNames()).toContain('openai');
      expect(providers.getProviderNames()).toContain('deepseek');
      expect(providers.getProviderNames()).toContain('xai');
    });

    it('should register mock provider when MOCK_PROVIDER=1', async () => {
      const original = process.env.MOCK_PROVIDER;
      process.env.MOCK_PROVIDER = '1';
      const { registry, providers } = await importRegistry();
      registry.initProviders();
      expect(providers.getProvider('mock') !== undefined).toBe(true);
      if (original !== undefined) {
        process.env.MOCK_PROVIDER = original;
      } else {
        delete process.env.MOCK_PROVIDER;
      }
    });

    it('should register dynamic providers from config', async () => {
      mockGetConfig.mockReturnValue({
        dynamicProviders: [
          { name: 'dynamic-test', base_url: 'https://api.example.com', endpoints: { chat: '/chat' } },
        ],
      });
      const { registry, providers } = await importRegistry();
      registry.initProviders();
      expect(providers.getProvider('dynamic-test') !== undefined).toBe(true);
    });

    it('should skip dynamic providers with invalid URL', async () => {
      mockGetConfig.mockReturnValue({
        dynamicProviders: [
          { name: 'bad-provider', base_url: 'http://localhost:3000', endpoints: { chat: '/chat' } },
        ],
      });
      const { registry, providers } = await importRegistry();
      registry.initProviders();
      expect(providers.getProvider('bad-provider') !== undefined).toBe(false);
    });
  });

  describe('mockProvider chat', () => {
    it('should return mock response with token estimation', async () => {
      process.env.MOCK_PROVIDER = '1';
      const { registry, providers } = await importRegistry();
      registry.initProviders();
      const mock = providers.getProvider('mock');
      expect(mock).toBeDefined();

      const result = await mock!.chat({
        model: 'mock-model',
        messages: [{ role: 'user', content: 'hello world' }],
      }, { provider: 'mock', base_url: 'http://localhost' });

      expect(result.choices[0].message.content).toBeDefined();
      expect(result.usage.prompt_tokens).toBeGreaterThan(0);
      expect(result.usage.completion_tokens).toBeGreaterThan(0);
      delete process.env.MOCK_PROVIDER;
    });

    it('should return Chinese reply for 你好', async () => {
      process.env.MOCK_PROVIDER = '1';
      const { registry, providers } = await importRegistry();
      registry.initProviders();
      const mock = providers.getProvider('mock');
      const result = await mock!.chat({
        model: 'mock-model',
        messages: [{ role: 'user', content: '你好' }],
      }, { provider: 'mock', base_url: 'http://localhost' });
      expect(result.choices[0].message.content).toContain('你好');
      delete process.env.MOCK_PROVIDER;
    });

    it('should return weather reply', async () => {
      process.env.MOCK_PROVIDER = '1';
      const { registry, providers } = await importRegistry();
      registry.initProviders();
      const mock = providers.getProvider('mock');
      const result = await mock!.chat({
        model: 'mock-model',
        messages: [{ role: 'user', content: '天气怎么样' }],
      }, { provider: 'mock', base_url: 'http://localhost' });
      expect(result.choices[0].message.content).toContain('天气');
      delete process.env.MOCK_PROVIDER;
    });

    it('should return code reply', async () => {
      process.env.MOCK_PROVIDER = '1';
      const { registry, providers } = await importRegistry();
      registry.initProviders();
      const mock = providers.getProvider('mock');
      const result = await mock!.chat({
        model: 'mock-model',
        messages: [{ role: 'user', content: '给我写段代码' }],
      }, { provider: 'mock', base_url: 'http://localhost' });
      expect(result.choices[0].message.content).toContain('代码');
      delete process.env.MOCK_PROVIDER;
    });

    it('should return goodbye reply', async () => {
      process.env.MOCK_PROVIDER = '1';
      const { registry, providers } = await importRegistry();
      registry.initProviders();
      const mock = providers.getProvider('mock');
      const result = await mock!.chat({
        model: 'mock-model',
        messages: [{ role: 'user', content: '再见' }],
      }, { provider: 'mock', base_url: 'http://localhost' });
      expect(result.choices[0].message.content).toContain('再见');
      delete process.env.MOCK_PROVIDER;
    });
  });

  describe('isValidProviderUrl SSRF protection', () => {
    it('should reject localhost', async () => {
      mockGetConfig.mockReturnValue({
        dynamicProviders: [{ name: 'localhost-test', base_url: 'http://localhost:3000', endpoints: { chat: '/chat' } }],
      });
      const { registry, providers } = await importRegistry();
      registry.initProviders();
      expect(providers.getProvider('localhost-test') !== undefined).toBe(false);
    });

    it('should reject 127.0.0.1', async () => {
      mockGetConfig.mockReturnValue({
        dynamicProviders: [{ name: 'loopback', base_url: 'http://127.0.0.1:3000', endpoints: { chat: '/chat' } }],
      });
      const { registry, providers } = await importRegistry();
      registry.initProviders();
      expect(providers.getProvider('loopback') !== undefined).toBe(false);
    });

    it('should reject 10.x.x.x', async () => {
      mockGetConfig.mockReturnValue({
        dynamicProviders: [{ name: 'private10', base_url: 'http://10.0.0.1', endpoints: { chat: '/chat' } }],
      });
      const { registry, providers } = await importRegistry();
      registry.initProviders();
      expect(providers.getProvider('private10') !== undefined).toBe(false);
    });

    it('should reject 172.16-31.x.x', async () => {
      mockGetConfig.mockReturnValue({
        dynamicProviders: [{ name: 'private172', base_url: 'http://172.16.0.1', endpoints: { chat: '/chat' } }],
      });
      const { registry, providers } = await importRegistry();
      registry.initProviders();
      expect(providers.getProvider('private172') !== undefined).toBe(false);
    });

    it('should reject 192.168.x.x', async () => {
      mockGetConfig.mockReturnValue({
        dynamicProviders: [{ name: 'private192', base_url: 'http://192.168.1.1', endpoints: { chat: '/chat' } }],
      });
      const { registry, providers } = await importRegistry();
      registry.initProviders();
      expect(providers.getProvider('private192') !== undefined).toBe(false);
    });

    it('should reject 169.254.x.x', async () => {
      mockGetConfig.mockReturnValue({
        dynamicProviders: [{ name: 'linklocal', base_url: 'http://169.254.1.1', endpoints: { chat: '/chat' } }],
      });
      const { registry, providers } = await importRegistry();
      registry.initProviders();
      expect(providers.getProvider('linklocal') !== undefined).toBe(false);
    });

    it('should reject non-http protocols', async () => {
      mockGetConfig.mockReturnValue({
        dynamicProviders: [{ name: 'fileproto', base_url: 'file:///etc/passwd', endpoints: { chat: '/chat' } }],
      });
      const { registry, providers } = await importRegistry();
      registry.initProviders();
      expect(providers.getProvider('fileproto') !== undefined).toBe(false);
    });

    it('should reject invalid URL', async () => {
      mockGetConfig.mockReturnValue({
        dynamicProviders: [{ name: 'badurl', base_url: 'not-a-url', endpoints: { chat: '/chat' } }],
      });
      const { registry, providers } = await importRegistry();
      registry.initProviders();
      expect(providers.getProvider('badurl') !== undefined).toBe(false);
    });

    it('should allow public URLs', async () => {
      mockGetConfig.mockReturnValue({
        dynamicProviders: [{ name: 'public', base_url: 'https://api.public.com', endpoints: { chat: '/chat' } }],
      });
      const { registry, providers } = await importRegistry();
      registry.initProviders();
      expect(providers.getProvider('public') !== undefined).toBe(true);
    });
  });

  describe('estimateTokens', () => {
    it('should estimate tokens for CJK characters', async () => {
      process.env.MOCK_PROVIDER = '1';
      const { registry, providers } = await importRegistry();
      registry.initProviders();
      const mock = providers.getProvider('mock');
      const result = await mock!.chat({
        model: 'mock-model',
        messages: [{ role: 'user', content: '你好世界' }],
      }, { provider: 'mock', base_url: 'http://localhost' });
      expect(result.usage.prompt_tokens).toBeGreaterThanOrEqual(4);
      delete process.env.MOCK_PROVIDER;
    });

    it('should estimate tokens for ASCII characters', async () => {
      process.env.MOCK_PROVIDER = '1';
      const { registry, providers } = await importRegistry();
      registry.initProviders();
      const mock = providers.getProvider('mock');
      const result = await mock!.chat({
        model: 'mock-model',
        messages: [{ role: 'user', content: 'hello world test' }],
      }, { provider: 'mock', base_url: 'http://localhost' });
      expect(result.usage.prompt_tokens).toBeGreaterThanOrEqual(1);
      delete process.env.MOCK_PROVIDER;
    });
  });
});
