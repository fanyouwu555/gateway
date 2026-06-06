/**
 * 响应缓存服务
 * 基于请求内容生成缓存键，支持语义缓存
 * 支持内存/Redis 存储
 */
import type { ChatCompletionRequest } from '../types';
import type { IKVStore } from '../stores/interface';
import { createKVStore } from '../stores/factory';
import { writeLog } from '../utils/logger';
import { recordCacheHit, recordCacheMiss } from '../middleware/metrics';
import { getSemanticCache } from './semantic-cache';

/**
 * 语义缓存配置
 */
export interface SemanticCacheConfig {
  enabled: boolean;
  threshold: number; // Jaccard 相似度阈值，0-1
}

/**
 * 默认语义缓存配置
 */
const DEFAULT_SEMANTIC_CONFIG: SemanticCacheConfig = {
  enabled: true,
  threshold: 0.85,
};

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
  private semanticConfig: SemanticCacheConfig;
  private hits = 0;
  private misses = 0;

  constructor(maxSize = 1000, ttl = 3600000, semanticConfig?: Partial<SemanticCacheConfig>) {
    // 默认1小时TTL
    this.maxSize = maxSize;
    this.ttl = ttl;
    this.semanticConfig = { ...DEFAULT_SEMANTIC_CONFIG, ...semanticConfig };

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
  generateKey(request: ChatCompletionRequest, tenantId?: string): string {
    const parts = [
      tenantId || 'default',
      request.model,
      JSON.stringify(request.messages),
      String(request.temperature || ''),
      String(request.top_p || ''),
      String(request.max_tokens || ''),
      String(request.presence_penalty || ''),
      String(request.frequency_penalty || ''),
      JSON.stringify(request.stop || ''),
      JSON.stringify(request.tools || ''),
      JSON.stringify(request.tool_choice || ''),
      String(request.user || ''),
    ];
    return parts.join('|');
  }

  /**
   * 简单的 Token 分词（按空格和标点分割）
   */
  private tokenize(text: string): Set<string> {
    return new Set(
      text
        .toLowerCase()
        .replace(/[^\w\s]/g, ' ')
        .split(/\s+/)
        .filter((t) => t.length > 1)
    );
  }

  /**
   * 计算 Jaccard 相似度
   */
  private jaccardSimilarity(setA: Set<string>, setB: Set<string>): number {
    if (setA.size === 0 || setB.size === 0) return 0;

    let intersection = 0;
    for (const token of setA) {
      if (setB.has(token)) {
        intersection++;
      }
    }

    const union = setA.size + setB.size - intersection;
    return intersection / union;
  }

  /**
   * 从请求中提取文本内容
   */
  private extractTextFromRequest(request: ChatCompletionRequest): string {
    return request.messages.map((m) => m.content).join(' ');
  }

  /**
   * 语义查找 - 基于 Jaccard 相似度查找缓存
   * 搜索顺序：内存（快）→ Redis（慢但更完整）
   * Redis 命中时自动提升到内存缓存
   */
  async semanticFind(request: ChatCompletionRequest): Promise<T | null> {
    if (!this.semanticConfig.enabled) return null;

    const requestTokens = this.tokenize(this.extractTextFromRequest(request));

    let bestMatch: { entry: CacheEntry<T>; similarity: number } | null = null;
    const now = Date.now();

    for (const entry of this.cache.values()) {
      if (now > entry.expires_at) continue;

      const keyParts = entry.key.split('|');
      if (keyParts.length < 2) continue;

      const cachedModel = keyParts[1];
      if (cachedModel !== request.model) continue;

      try {
        const messages = JSON.parse(keyParts[2]);
        const cachedText = messages.map((m: { content: string }) => m.content).join(' ');
        const cachedTokens = this.tokenize(cachedText);
        const similarity = this.jaccardSimilarity(requestTokens, cachedTokens);

        if (similarity >= this.semanticConfig.threshold && (!bestMatch || similarity > bestMatch.similarity)) {
          bestMatch = { entry, similarity };
        }
      } catch {
        continue;
      }
    }

    if (this.useStorage && this.store) {
      try {
        const redisKeys = await this.store.keys('*');

        for (const key of redisKeys) {
          if (this.cache.has(key)) continue;

          const keyParts = key.split('|');
          if (keyParts.length < 2) continue;
          if (keyParts[1] !== request.model) continue;

          const stored = await this.store.get(key);
          if (!stored) continue;

          try {
            const entry = JSON.parse(stored) as CacheEntry<T>;
            if (now > entry.expires_at) continue;

            const messages = JSON.parse(keyParts[2]);
            const cachedText = messages.map((m: { content: string }) => m.content).join(' ');
            const cachedTokens = this.tokenize(cachedText);
            const similarity = this.jaccardSimilarity(requestTokens, cachedTokens);

            if (similarity >= this.semanticConfig.threshold && (!bestMatch || similarity > bestMatch.similarity)) {
              bestMatch = { entry, similarity };
            }
          } catch {
            continue;
          }
        }
      } catch {
        writeLog('warn', 'Redis semantic search failed, falling back to memory-only results');
      }
    }

    if (bestMatch) {
      bestMatch.entry.hit_count++;
      this.hits++;

      if (!this.cache.has(bestMatch.entry.key)) {
        if (this.cache.size >= this.maxSize) {
          this.evictLeastUsed();
        }
        this.cache.set(bestMatch.entry.key, bestMatch.entry);
      }

      writeLog('debug', 'Semantic cache hit', { similarity: bestMatch.similarity });
      return bestMatch.entry.value;
    }

    return null;
  }

  /**
   * 获取缓存条目（异步，支持 Redis 回源）
   */
  async get(key: string): Promise<T | null> {
    // 先检查内存
    const memEntry = this.cache.get(key);
    if (memEntry) {
      if (Date.now() > memEntry.expires_at) {
        this.cache.delete(key);
        this.misses++;
        return null;
      }
      memEntry.hit_count++;
      this.hits++;
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
            this.misses++;
            return null;
          }
          // 同步到内存
          this.cache.set(key, entry);
          this.hits++;
          return entry.value;
        }
      } catch {
        // 存储失败
      }
    }

    this.misses++;
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
   * hit_rate 为真正的缓存命中率：hits / (hits + misses)
   */
  getStats(): { size: number; hit_rate: number; hits: number; misses: number } {
    const total = this.hits + this.misses;
    return {
      size: this.cache.size,
      hits: this.hits,
      misses: this.misses,
      hit_rate: total > 0 ? this.hits / total : 0,
    };
  }
}

// 单例
let cacheStore = new CacheStore<string>();

let lastCacheHitType: 'exact' | 'semantic' | null = null;

/**
 * 获取最近一次缓存命中的类型
 */
export function getLastCacheHitType(): 'exact' | 'semantic' | null {
  return lastCacheHitType;
}

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
export function generateCacheKey(request: ChatCompletionRequest, tenantId?: string): string {
  return cacheStore.generateKey(request, tenantId);
}

/**
 * 获取缓存（异步，支持 Redis 和语义查找）
 * 查找顺序：精确匹配 → 嵌入向量语义匹配 → Jaccard 语义匹配
 */
export async function getCache(request: ChatCompletionRequest, tenantId?: string, useSemantic = true): Promise<string | null> {
  lastCacheHitType = null;

  const key = generateCacheKey(request, tenantId);

  // 1. 精确查找
  const exactMatch = await cacheStore.get(key);
  if (exactMatch) {
    lastCacheHitType = 'exact';
    writeLog('debug', 'Exact cache hit');
    recordCacheHit('exact');
    return exactMatch;
  }

  // 2. 语义查找
  if (useSemantic) {
    // 2a. 嵌入向量语义查找（更准确，需要 SemanticCacheService 已初始化）
    const semanticCache = getSemanticCache();
    if (semanticCache?.isInitialized()) {
      const embeddingMatch = await semanticCache.findSimilar(request, tenantId);
      if (embeddingMatch) {
        lastCacheHitType = 'semantic';
        recordCacheHit('semantic');
        return embeddingMatch;
      }
    }

    // 2b. Jaccard 语义查找（更快，无需 API 调用）
    const jaccardMatch = await cacheStore.semanticFind(request);
    if (jaccardMatch) {
      lastCacheHitType = 'semantic';
      recordCacheHit('semantic');
      return jaccardMatch;
    }
  }

  recordCacheMiss();
  return null;
}

/**
 * 设置缓存（异步，支持 Redis 和语义缓存）
 */
export async function setCache(
  request: ChatCompletionRequest,
  response?: string,
  tenantId?: string,
  ttl?: number
): Promise<void> {
  const key = generateCacheKey(request, tenantId);
  await cacheStore.setAsync(key, response || '', ttl);

  const semanticCache = getSemanticCache();
  if (semanticCache?.isInitialized()) {
    await semanticCache.storeEmbedding(request, response || '', tenantId);
  }
}

/**
 * 删除缓存
 */
export function deleteCache(request: ChatCompletionRequest, tenantId?: string): void {
  const key = generateCacheKey(request, tenantId);
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
export function getCacheStats(): { size: number; hit_rate: number; hits: number; misses: number } {
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