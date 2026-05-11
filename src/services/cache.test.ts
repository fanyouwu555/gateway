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
} from '../services/cache';
import type { ChatCompletionRequest } from '../types';

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
    it('should store and retrieve cache', () => {
      const request: ChatCompletionRequest = {
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'Test' }],
      };
      const response = '{"result": "cached response"}';

      setCache(request, response);
      const cached = getCache(request);
      expect(cached).toBe(response);
    });

    it('should return null for non-existent cache', () => {
      const request: ChatCompletionRequest = {
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'Never cached' }],
      };
      const cached = getCache(request);
      expect(cached).toBeNull();
    });
  });

  describe('deleteCache', () => {
    it('should delete cache entry', () => {
      const request: ChatCompletionRequest = {
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'Test' }],
      };
      setCache(request, 'test');
      deleteCache(request);
      expect(getCache(request)).toBeNull();
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
});