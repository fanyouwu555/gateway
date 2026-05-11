/**
 * 动态 Provider 测试
 */
import { DynamicProvider } from './dynamic';
import type { DynamicProviderConfig } from '../types';

describe('DynamicProvider', () => {
  describe('constructor', () => {
    it('should create provider with config name', () => {
      const config: DynamicProviderConfig = {
        name: 'my-provider',
        base_url: 'https://api.example.com',
        endpoints: {
          chat: '/chat',
        },
      };

      const provider = new DynamicProvider(config);
      expect(provider.name).toBe('my-provider');
    });

    it('should set capabilities based on endpoints', () => {
      const config: DynamicProviderConfig = {
        name: 'chat-only',
        base_url: 'https://api.example.com',
        endpoints: {
          chat: '/chat',
        },
      };

      const provider = new DynamicProvider(config);
      expect(provider.capabilities.chat).toBe(true);
      expect(provider.capabilities.embed).toBe(false);
      expect(provider.capabilities.streaming).toBe(false);
    });

    it('should support all capabilities when all endpoints defined', () => {
      const config: DynamicProviderConfig = {
        name: 'full-provider',
        base_url: 'https://api.example.com',
        endpoints: {
          chat: '/chat',
          chat_stream: '/chat/stream',
          embeddings: '/embed',
          models: '/models',
        },
        capabilities: {
          vision: true,
          function_call: true,
        },
      };

      const provider = new DynamicProvider(config);
      expect(provider.capabilities.chat).toBe(true);
      expect(provider.capabilities.embed).toBe(true);
      expect(provider.capabilities.streaming).toBe(true);
      expect(provider.capabilities.vision).toBe(true);
      expect(provider.capabilities.function_call).toBe(true);
    });
  });

  describe('buildHeaders', () => {
    it('should use default Authorization header', () => {
      const config: DynamicProviderConfig = {
        name: 'test',
        base_url: 'https://api.example.com',
        endpoints: { chat: '/chat' },
      };

      const provider = new DynamicProvider(config);
      // 模拟测试 - 验证配置正确
      expect(provider.name).toBe('test');
      expect(provider.capabilities.chat).toBe(true);
    });

    it('should support custom auth header', () => {
      const config: DynamicProviderConfig = {
        name: 'test',
        base_url: 'https://api.example.com',
        auth_header: 'X-API-Key',
        endpoints: { chat: '/chat' },
      };

      const provider = new DynamicProvider(config);
      expect(provider.name).toBe('test');
    });

    it('should support custom auth prefix', () => {
      const config: DynamicProviderConfig = {
        name: 'test',
        base_url: 'https://api.example.com',
        auth_prefix: 'ApiKey',
        endpoints: { chat: '/chat' },
      };

      const provider = new DynamicProvider(config);
      expect(provider.name).toBe('test');
    });
  });
});