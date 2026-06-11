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
  resetCache,
  flushCache,
} from '../../src/services/cache';
import type { ChatCompletionRequest } from '../../src/types';

describe('Cache Service', () => {
  beforeEach(() => {
    resetCache();
  });

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
    it('should return cache statistics with hits/misses and real hit rate', () => {
      const stats = getCacheStats();
      expect(stats).toHaveProperty('size');
      expect(stats).toHaveProperty('hit_rate');
      expect(stats).toHaveProperty('hits');
      expect(stats).toHaveProperty('misses');
    });

    it('should calculate real hit rate after cache hits and misses', async () => {
      const request1: ChatCompletionRequest = {
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'Hit me' }],
      };
      const request2: ChatCompletionRequest = {
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'Miss me' }],
      };

      await setCache(request1, '{"result": "cached"}');

      // 1 hit + 1 miss
      await getCache(request1);
      await getCache(request2);

      const stats = getCacheStats();
      expect(stats.hits).toBe(1);
      expect(stats.misses).toBe(1);
      expect(stats.hit_rate).toBe(0.5);
      expect(stats.size).toBe(1);
    });
  });

  describe('createCacheStore', () => {
    it('should create cache store with custom config', () => {
      const store = createCacheStore<string>(100, 60000);
      expect(store).toBeDefined();
    });
  });

  describe('generateCacheKey', () => {
    it('should produce fixed-length SHA-256 hex keys', () => {
      const request: ChatCompletionRequest = {
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'Hello world this is a long message' }],
      };
      const key = generateCacheKey(request);
      expect(key).toMatch(/^[a-f0-9]{64}$/);
    });

    it('should not be affected by pipe characters in content', () => {
      const request: ChatCompletionRequest = {
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'a|b|c' }],
      };
      const key = generateCacheKey(request);
      expect(key).toMatch(/^[a-f0-9]{64}$/);
    });
  });

  describe('LRU eviction', () => {
    it('should evict least recently used entries first', async () => {
      // 创建容量为 2 的 store
      const store = createCacheStore<string>(2, 60000);

      await store.setAsync('key1', 'v1', { request_text: 'one', model: 'm1' });
      await new Promise((r) => setTimeout(r, 20));
      await store.setAsync('key2', 'v2', { request_text: 'two', model: 'm1' });

      // 访问 key1，使其比 key2 更新
      await new Promise((r) => setTimeout(r, 20));
      await store.get('key1');

      // 写入 key3，应该淘汰 key2（最久未访问）
      await new Promise((r) => setTimeout(r, 20));
      await store.setAsync('key3', 'v3', { request_text: 'three', model: 'm1' });

      expect(await store.get('key1')).toBe('v1');
      expect(await store.get('key2')).toBeNull();
      expect(await store.get('key3')).toBe('v3');
    });
  });

  describe('flushCache', () => {
    it('should clear all entries and reset stats', async () => {
      const request: ChatCompletionRequest = {
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'flush test' }],
      };
      await setCache(request, '{"result": "ok"}');
      await getCache(request); // 1 hit

      const before = getCacheStats();
      expect(before.size).toBe(1);
      expect(before.hits).toBe(1);

      const count = await flushCache();
      expect(count).toBeGreaterThanOrEqual(1);

      const after = getCacheStats();
      expect(after.size).toBe(0);
      expect(after.hits).toBe(0);
      expect(after.misses).toBe(0);
      expect(await getCache(request)).toBeNull();
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