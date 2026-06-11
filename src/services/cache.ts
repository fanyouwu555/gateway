/**
 * 响应缓存服务
 * 基于请求内容生成缓存键，支持语义缓存
 * 支持内存/Redis 存储
 */
import { createHash } from 'crypto';
import type { ChatCompletionRequest } from '../types';
import type { IKVStore } from '../stores/interface';
import { createKVStore } from '../stores/factory';
import { writeLog } from '../utils/logger';
import { recordCacheHit, recordCacheMiss } from '../middleware/metrics';
import { getSemanticCache } from './semantic-cache';
import { shouldUseRedis } from '../utils';

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
 * 从请求中提取文本内容（独立函数，供 CacheStore 外部使用）
 */
function extractTextFromRequest(request: ChatCompletionRequest): string {
  return request.messages.map((m) => m.content).join(' ');
}

/**
 * 缓存条目
 */
interface CacheEntry<T> {
  key: string;
  value: T;
  /** 请求文本，用于语义匹配 */
  request_text: string;
  /** 模型名称，用于语义匹配时过滤 */
  model: string;
  created_at: number;
  expires_at: number;
  hit_count: number;
  last_accessed_at: number;
}

/**
 * 缓存元数据
 */
interface CacheEntryMetadata {
  request_text: string;
  model: string;
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
    this.useStorage = shouldUseRedis('CACHE_STORAGE');

    if (this.useStorage) {
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
   * 生成缓存键（SHA-256 哈希，固定长度，避免 key 污染和过长）
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
    // 使用不可见分隔符避免与用户内容冲突
    const normalized = parts.join('\0');
    return createHash('sha256').update(normalized).digest('hex');
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
   * 语义查找 - 基于 Jaccard 相似度在内存缓存中查找
   * 注意：不再扫描 Redis，避免 keys('*') 性能问题。
   * 跨存储的语义匹配由向量语义缓存（SemanticCacheService）负责。
   */
  async semanticFind(request: ChatCompletionRequest): Promise<T | null> {
    if (!this.semanticConfig.enabled) return null;

    const requestTokens = this.tokenize(extractTextFromRequest(request));

    let bestMatch: { entry: CacheEntry<T>; similarity: number } | null = null;
    const now = Date.now();

    for (const entry of this.cache.values()) {
      if (now > entry.expires_at) continue;
      if (entry.model !== request.model) continue;

      const cachedTokens = this.tokenize(entry.request_text);
      const similarity = this.jaccardSimilarity(requestTokens, cachedTokens);

      if (similarity >= this.semanticConfig.threshold && (!bestMatch || similarity > bestMatch.similarity)) {
        bestMatch = { entry, similarity };
      }
    }

    if (bestMatch) {
      bestMatch.entry.hit_count++;
      bestMatch.entry.last_accessed_at = Date.now();
      this.hits++;

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
      memEntry.last_accessed_at = Date.now();
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
          entry.last_accessed_at = Date.now();
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
  async setAsync(key: string, value: T, metadata: CacheEntryMetadata, ttl?: number): Promise<void> {
    const now = Date.now();
    const entry: CacheEntry<T> = {
      key,
      value,
      request_text: metadata.request_text,
      model: metadata.model,
      created_at: now,
      expires_at: now + (ttl || this.ttl),
      hit_count: 0,
      last_accessed_at: now,
    };

    // 内存更新
    if (this.cache.size >= this.maxSize) {
      this.evictLRU();
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
  set(key: string, value: T, metadata: CacheEntryMetadata, ttl?: number): void {
    const now = Date.now();
    const entry: CacheEntry<T> = {
      key,
      value,
      request_text: metadata.request_text,
      model: metadata.model,
      created_at: now,
      expires_at: now + (ttl || this.ttl),
      hit_count: 0,
      last_accessed_at: now,
    };

    // 先写入内存
    if (this.cache.size >= this.maxSize) {
      this.evictLRU();
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
   * 删除最久未访问的条目（LRU）
   */
  private evictLRU(): void {
    let oldestKey: string | null = null;
    let oldestTime = Infinity;

    for (const [key, entry] of this.cache.entries()) {
      if (entry.last_accessed_at < oldestTime) {
        oldestTime = entry.last_accessed_at;
        oldestKey = key;
      }
    }

    if (oldestKey) {
      this.cache.delete(oldestKey);
    }
  }

  /**
   * 删除
   */
  delete(key: string): void {
    this.cache.delete(key);
  }

  /**
   * 清理过期条目（内存层）
   * Redis 中的过期条目由其 TTL 机制自动处理。
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
   * 清空所有缓存条目（内存 + Redis），并重置统计
   */
  async flushAsync(): Promise<number> {
    let count = this.cache.size;
    this.cache.clear();

    if (this.useStorage && this.store) {
      try {
        const redisCount = await this.store.delByPattern('*');
        count += redisCount;
      } catch {
        writeLog('warn', 'Failed to flush Redis cache entries');
      }
    }

    // 重置统计
    this.hits = 0;
    this.misses = 0;

    return count;
  }

  /**
   * 获取统计
   * hit_rate 为真正的缓存命中率：hits / (hits + misses)
   * 注意：hits/misses 为进程级内存计数器，多实例部署时仅反映当前进程。
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
 * @returns 创建的 CacheStore 实例，方便调用方连接 Redis
 */
export function initCache(config?: { ttl?: number; max_size?: number }): CacheStore<string> {
  const ttl = config?.ttl ?? 3600000;
  const maxSize = config?.max_size ?? 1000;
  cacheStore = new CacheStore<string>(maxSize, ttl);
  return cacheStore;
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

    // 2b. Jaccard 语义查找（更快，无需 API 调用，仅在内存层）
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
  const metadata: CacheEntryMetadata = {
    request_text: extractTextFromRequest(request),
    model: request.model,
  };
  await cacheStore.setAsync(key, response || '', metadata, ttl);

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
 * 清理过期缓存（仅内存层；Redis 过期由 TTL 自动处理）
 */
export function cleanCache(): number {
  return cacheStore.clean();
}

/**
 * 清空所有缓存（内存 + Redis）
 */
export async function flushCache(): Promise<number> {
  return cacheStore.flushAsync();
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
