/**
 * 缓存服务测试
 */
import {
  generateCacheKey,
  getCache,
  setCache,
  deleteCache,
  getCacheStats,
  createCacheStore,
} from '../../src/services/cache';
import type { ChatCompletionRequest } from '../../src/types';

describe('Cache Service', () => {
  describe('generateCacheKey', () => {
    it('should generate consistent keys for same request', () => {
      const request: ChatCompletionRequest = {
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'Hello' }],
        temperature: 0.7,
      };
      const key1 = generateCacheKey(request);
      const key2 = generateCacheKey(request);
      expect(key1).toBe(key2);
    });

    it('should generate different keys for different requests', () => {
      const request1: ChatCompletionRequest = {
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'Hello' }],
      };
      const request2: ChatCompletionRequest = {
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'World' }],
      };
      const key1 = generateCacheKey(request1);
      const key2 = generateCacheKey(request2);
      expect(key1).not.toBe(key2);
    });

    it('should include model in key', () => {
      const request1: ChatCompletionRequest = {
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'Hello' }],
      };
      const request2: ChatCompletionRequest = {
        model: 'gpt-3.5-turbo',
        messages: [{ role: 'user', content: 'Hello' }],
      };
      const key1 = generateCacheKey(request1);
      const key2 = generateCacheKey(request2);
      expect(key1).not.toBe(key2);
    });
  });

  describe('getCache & setCache', () => {
    it('should store and retrieve cache', async () => {
      const request: ChatCompletionRequest = {
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'Test' }],
      };
      const response = '{"result": "cached response"}';

      await setCache(request, response);
      const cached = await getCache(request);
      expect(cached).toBe(response);
    });

    it('should return null for non-existent cache', async () => {
      const request: ChatCompletionRequest = {
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'Never cached' }],
      };
      const cached = await getCache(request);
      expect(cached).toBeNull();
    });
  });

  describe('deleteCache', () => {
    it('should delete cache entry', async () => {
      const request: ChatCompletionRequest = {
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'Test' }],
      };
      await setCache(request, 'test');
      deleteCache(request);
      expect(await getCache(request)).toBeNull();
    });
  });

  describe('getCacheStats', () => {
    it('should return cache statistics', () => {
      const stats = getCacheStats();
      expect(stats).toHaveProperty('size');
      expect(stats).toHaveProperty('hit_rate');
    });
  });

  describe('createCacheStore', () => {
    it('should create cache store with custom config', () => {
      const store = createCacheStore<string>(100, 60000);
      expect(store).toBeDefined();
    });
  });

  describe('Semantic Cache', () => {
    it('should find semantically similar requests', async () => {
      const request1: ChatCompletionRequest = {
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'How to create a React component?' }],
      };
      const request2: ChatCompletionRequest = {
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'How to create React component?' }],
      };
      const response = '{"result": "You can create a component with JSX"}';

      await setCache(request1, response);
      const cached = await getCache(request2);
      expect(cached).toBe(response);
    });

    it('should not find semantically dissimilar requests', async () => {
      const request1: ChatCompletionRequest = {
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'How to create a React component?' }],
      };
      const request2: ChatCompletionRequest = {
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'What is machine learning?' }],
      };

      await setCache(request1, 'response1');
      const cached = await getCache(request2);
      expect(cached).toBeNull();
    });
  });
});