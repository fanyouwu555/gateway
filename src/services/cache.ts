/**
 * 响应缓存服务
 * 基于请求内容生成缓存键，支持语义缓存
 * 支持内存/Redis 存储
 */
import type { ChatCompletionRequest } from '../types';
import type { IKVStore } from '../stores/interface';
import { createKVStore } from '../stores/factory';
import { writeLog } from '../utils/logger';

/**
 * 缓存条目
 */
interface CacheEntry<T> {
  key: string;
  value: T;
  created_at: number;
  expires_at: number;
  hit_count: number;
}

/**
 * 缓存存储 - 支持内存和 Redis
 */
class CacheStore<T> {
  private cache = new Map<string, CacheEntry<T>>();
  private readonly maxSize: number;
  private readonly ttl: number; // 毫秒
  private store: IKVStore | null = null;
  private useStorage = false;

  constructor(maxSize = 1000, ttl = 3600000) {
    // 默认1小时TTL
    this.maxSize = maxSize;
    this.ttl = ttl;

    // 初始化存储 (Redis 或 Memory)
    const useStorage = process.env.CACHE_STORAGE === 'redis';
    this.useStorage = useStorage;

    if (useStorage) {
      this.store = createKVStore('cache');
    }
  }

  /**
   * 初始化存储连接
   */
  async initStorage(): Promise<void> {
    if (this.useStorage && this.store) {
      await this.store.connect();
    }
  }

  /**
   * 生成缓存键
   */
  generateKey(request: ChatCompletionRequest): string {
    const parts = [
      request.model,
      JSON.stringify(request.messages),
      String(request.temperature || ''),
      String(request.top_p || ''),
      String(request.max_tokens || ''),
    ];
    return parts.join('|');
  }

  /**
   * 获取
   */
  get(key: string): T | null {
    // 内存存储优先
    const entry = this.cache.get(key);
    if (entry) {
      // 检查过期
      if (Date.now() > entry.expires_at) {
        this.cache.delete(key);
        return null;
      }
      // 增加命中次数
      entry.hit_count++;
      return entry.value;
    }

    // 如果使用存储，尝试从存储获取
    if (this.useStorage && this.store) {
      try {
        // 同步方式获取 (内存缓存会先命中)
        return null; // Storage is async, keep memory-first for now
      } catch {
        // 存储获取失败
      }
    }

    return null;
  }

  /**
   * 异步获取 - 优先从存储获取，用于启动时加载缓存
   */
  async getAsync(key: string): Promise<T | null> {
    // 先检查内存
    const memEntry = this.cache.get(key);
    if (memEntry) {
      if (Date.now() > memEntry.expires_at) {
        this.cache.delete(key);
        return null;
      }
      memEntry.hit_count++;
      return memEntry.value;
    }

    // 从存储获取
    if (this.useStorage && this.store) {
      try {
        const stored = await this.store.get(key);
        if (stored) {
          const entry = JSON.parse(stored) as CacheEntry<T>;
          if (Date.now() > entry.expires_at) {
            await this.store.delete(key);
            return null;
          }
          // 同步到内存
          this.cache.set(key, entry);
          return entry.value;
        }
      } catch {
        // 存储失败
      }
    }

    return null;
  }

  /**
   * 异步设置 - 优先写入存储，用于确保持久化
   */
  async setAsync(key: string, value: T, ttl?: number): Promise<void> {
    const now = Date.now();
    const entry: CacheEntry<T> = {
      key,
      value,
      created_at: now,
      expires_at: now + (ttl || this.ttl),
      hit_count: 0,
    };

    // 内存更新
    if (this.cache.size >= this.maxSize) {
      this.evictLeastUsed();
    }
    this.cache.set(key, entry);

    // 同步写入存储
    if (this.useStorage && this.store) {
      await this.store.set(key, JSON.stringify(entry), ttl || this.ttl);
    }
  }

  /**
   * 设置 - 同步接口，Redis 写入在后台异步执行
   */
  set(key: string, value: T, ttl?: number): void {
    const now = Date.now();
    const entry: CacheEntry<T> = {
      key,
      value,
      created_at: now,
      expires_at: now + (ttl || this.ttl),
      hit_count: 0,
    };

    // 先写入内存
    if (this.cache.size >= this.maxSize) {
      this.evictLeastUsed();
    }
    this.cache.set(key, entry);

    // 异步写入存储 (fire-and-forget)
    if (this.useStorage && this.store) {
      this.store.set(key, JSON.stringify(entry), ttl || this.ttl).catch((err) => {
        writeLog('warn', 'Failed to persist cache entry', { error: err instanceof Error ? err.message : String(err) });
      });
    }
  }

  /**
   * 删除最少使用的条目
   */
  private evictLeastUsed(): void {
    let minKey: string | null = null;
    let minHits = Infinity;

    for (const [key, entry] of this.cache.entries()) {
      if (entry.hit_count < minHits) {
        minHits = entry.hit_count;
        minKey = key;
      }
    }

    if (minKey) {
      this.cache.delete(minKey);
    }
  }

  /**
   * 删除
   */
  delete(key: string): void {
    this.cache.delete(key);
  }

  /**
   * 清理过期条目
   */
  clean(): number {
    const now = Date.now();
    let count = 0;

    for (const [key, entry] of this.cache.entries()) {
      if (now > entry.expires_at) {
        this.cache.delete(key);
        count++;
      }
    }

    return count;
  }

  /**
   * 获取统计
   */
  getStats(): { size: number; hit_rate: number } {
    let totalHits = 0;
    for (const entry of this.cache.values()) {
      totalHits += entry.hit_count;
    }
    const size = this.cache.size;
    return {
      size,
      hit_rate: size > 0 ? totalHits / size : 0,
    };
  }
}

// 单例
let cacheStore = new CacheStore<string>();

/**
 * 初始化缓存（从配置加载）
 */
export function initCache(config?: { ttl?: number; max_size?: number }): void {
  const ttl = config?.ttl ?? 3600000;
  const maxSize = config?.max_size ?? 1000;
  cacheStore = new CacheStore<string>(maxSize, ttl);
}

/**
 * 重置缓存（用于测试隔离）
 */
export function resetCache(): void {
  cacheStore = new CacheStore<string>();
}

/**
 * 简化版缓存键生成（用于精确匹配）
 */
export function generateCacheKey(request: ChatCompletionRequest): string {
  return cacheStore.generateKey(request);
}

/**
 * 获取缓存
 */
export function getCache(request: ChatCompletionRequest): string | null {
  const key = generateCacheKey(request);
  return cacheStore.get(key);
}

/**
 * 设置缓存
 */
export function setCache(
  request: ChatCompletionRequest,
  response: string,
  ttl?: number
): void {
  const key = generateCacheKey(request);
  cacheStore.set(key, response, ttl);
}

/**
 * 删除缓存
 */
export function deleteCache(request: ChatCompletionRequest): void {
  const key = generateCacheKey(request);
  cacheStore.delete(key);
}

/**
 * 清理过期缓存
 */
export function cleanCache(): number {
  return cacheStore.clean();
}

/**
 * 获取缓存统计
 */
export function getCacheStats(): { size: number; hit_rate: number } {
  return cacheStore.getStats();
}

/**
 * 路由缓存配置
 */
export interface CacheConfig {
  enabled: boolean;
  ttl: number; // 毫秒
  max_size: number;
}

export function createCacheStore<T>(
  maxSize: number,
  ttl: number
): CacheStore<T> {
  return new CacheStore<T>(maxSize, ttl);
}