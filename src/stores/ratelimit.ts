/**
 * 限流存储实现
 * 内存令牌桶（单实例）和 Redis 滑动窗口（分布式）
 */
import { createHash } from 'node:crypto';
import type { Context } from 'hono';
import { createRedisConfigFromEnv } from './redis';
import type Redis from 'ioredis';
import { writeLog } from '../utils/logger';

/**
 * 限流存储接口
 */
export interface IRateLimitStore {
  consume(c: Context, tokens?: number): Promise<boolean> | boolean;
  getRemainingTokens(c: Context): Promise<number> | number;
  clean(maxAge?: number): void;
}

/**
 * 令牌桶状态
 */
interface TokenBucket {
  tokens: number;
  lastRefill: number;
}

/**
 * 内存限流存储（令牌桶算法）
 */
export class MemoryRateLimitStore implements IRateLimitStore {
  private buckets = new Map<string, TokenBucket>();
  private readonly qps: number;
  private readonly burst: number;

  constructor(qps: number, burst: number) {
    this.qps = qps;
    this.burst = burst;
  }

  private getClientKey(c: Context): string {
    const keyHash = c.get('key_hash') as string | undefined;
    if (keyHash) {
      return `key:${keyHash.substring(0, 16)}`;
    }
    const apiKey = c.get('api_key') as string | undefined;
    if (apiKey) {
      const hash = createHash('sha256').update(apiKey).digest('hex');
      return `key:${hash.substring(0, 16)}`;
    }
    const ip =
      c.req.header('x-forwarded-for') ||
      c.req.header('x-real-ip') ||
      'unknown';
    return `ip:${ip}`;
  }

  async consume(c: Context, tokens = 1): Promise<boolean> {
    const key = this.getClientKey(c);
    const keyQps = c.get('key_rate_limit_qps') as number | undefined;
    const keyBurst = c.get('key_rate_limit_burst') as number | undefined;
    const actualKey = keyQps ? `key-v:${key}` : key;
    let bucket = this.buckets.get(actualKey || key);

    if (!bucket) {
      bucket = {
        tokens: keyBurst ?? this.burst,
        lastRefill: Date.now(),
      };
      this.buckets.set(actualKey || key, bucket);
    }

    this.refillWith(bucket, keyQps ?? this.qps, keyBurst ?? this.burst);

    if (bucket.tokens >= tokens) {
      bucket.tokens -= tokens;
      return true;
    }

    return false;
  }

  private refillWith(bucket: TokenBucket, qps: number, burst: number): void {
    const now = Date.now();
    const timePassed = (now - bucket.lastRefill) / 1000;
    const tokensToAdd = timePassed * qps;

    bucket.tokens = Math.min(burst, bucket.tokens + tokensToAdd);
    bucket.lastRefill = now;
  }

  async getRemainingTokens(c: Context): Promise<number> {
    const key = this.getClientKey(c);
    const keyQps = c.get('key_rate_limit_qps') as number | undefined;
    const keyBurst = c.get('key_rate_limit_burst') as number | undefined;
    const actualKey = keyBurst ? `key-v:${key}` : key;
    const bucket = this.buckets.get(actualKey);

    if (!bucket) {
      return keyBurst ?? this.burst;
    }

    const bucketCopy = { ...bucket };
    this.refillWith(bucketCopy, keyQps ?? this.qps, keyBurst ?? this.burst);
    return Math.floor(bucketCopy.tokens);
  }

  clean(maxAge?: number): void {
    const now = Date.now();
    const age = maxAge ?? 60000;

    for (const [key, bucket] of this.buckets.entries()) {
      if (now - bucket.lastRefill > age) {
        this.buckets.delete(key);
      }
    }
  }
}

/**
 * Redis 限流存储（生产环境）
 * 基于精确滑动窗口计数器实现，支持跨多实例共享
 */
export class RedisRateLimitStore implements IRateLimitStore {
  private client: Redis | null = null;
  private readonly burst: number;
  private readonly failOpen: boolean;

  constructor(_qps: number, burst: number, failOpen = true) {
    this.burst = burst;
    this.failOpen = failOpen;
  }

  async connect(): Promise<void> {
    if (this.client) return;
    const config = createRedisConfigFromEnv();
    if (!config) {
      writeLog('warn', '[RateLimit] Redis not configured, rate limiting will be unavailable');
      return;
    }
    const { default: IORedis } = await import('ioredis');
    this.client = new IORedis({
      host: config.host || 'localhost',
      port: config.port || 6379,
      password: config.password,
      db: config.db || 0,
      keyPrefix: 'ratelimit:',
      lazyConnect: true,
      retryStrategy: (times: number) => {
        if (times > 3) return null;
        return Math.min(times * 200, 2000);
      },
    });
    await this.client.connect();
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      await this.client.quit();
      this.client = null;
    }
  }

  private getClientKey(c: Context): string {
    const keyHash = c.get('key_hash') as string | undefined;
    if (keyHash) {
      return `key:${keyHash.substring(0, 16)}`;
    }
    const apiKey = c.get('api_key') as string | undefined;
    if (apiKey) {
      const hash = createHash('sha256').update(apiKey).digest('hex');
      return `key:${hash.substring(0, 16)}`;
    }
    const ip = c.req.header('x-forwarded-for') || c.req.header('x-real-ip') || 'unknown';
    return `ip:${ip}`;
  }

  private getEffectiveKey(c: Context): { key: string; burst: number } {
    const key = this.getClientKey(c);
    const keyBurst = c.get('key_rate_limit_burst') as number | undefined;
    const keyQps = c.get('key_rate_limit_qps') as number | undefined;
    if (keyQps !== undefined) {
      return { key: `key-v:${key}`, burst: keyBurst ?? this.burst };
    }
    return { key, burst: this.burst };
  }

  async consume(c: Context, _tokens = 1): Promise<boolean> {
    if (!this.client) {
      return this.failOpen;
    }

    const { key, burst } = this.getEffectiveKey(c);
    const now = Date.now();
    const windowMs = 1000;

    const currentWindowIdx = Math.floor(now / windowMs);
    const previousWindowIdx = currentWindowIdx - 1;
    const windowProgress = (now % windowMs) / windowMs;

    const currentKey = `${key}:${currentWindowIdx}`;
    const previousKey = `${key}:${previousWindowIdx}`;

    try {
      const luaScript = `
        local currentKey = KEYS[1]
        local previousKey = KEYS[2]
        local windowProgress = tonumber(ARGV[1])
        local burst = tonumber(ARGV[2])
        local ttl = tonumber(ARGV[3])

        local previous = redis.call('get', previousKey)
        previous = previous and tonumber(previous) or 0
        local current = redis.call('get', currentKey)
        current = current and tonumber(current) or 0

        local slidingCount = previous * (1 - windowProgress) + current + 1

        if slidingCount <= burst then
          redis.call('incr', currentKey)
          redis.call('expire', currentKey, ttl)
          return 1
        else
          return 0
        end
      `;

      const result = await this.client.eval(luaScript, 2, currentKey, previousKey, windowProgress, burst, 2);
      return result === 1;
    } catch (err) {
      writeLog('warn', 'Redis consume error', { error: err instanceof Error ? err.message : String(err) });
      return this.failOpen;
    }
  }

  async getRemainingTokens(c: Context): Promise<number> {
    if (!this.client) return this.burst;
    const { key, burst } = this.getEffectiveKey(c);
    const now = Date.now();
    const windowMs = 1000;

    const currentWindowIdx = Math.floor(now / windowMs);
    const previousWindowIdx = currentWindowIdx - 1;
    const windowProgress = (now % windowMs) / windowMs;

    const currentKey = `${key}:${currentWindowIdx}`;
    const previousKey = `${key}:${previousWindowIdx}`;

    try {
      const results = await this.client.mget(currentKey, previousKey);
      const current = results[0] ? parseInt(results[0], 10) : 0;
      const previous = results[1] ? parseInt(results[1], 10) : 0;

      const slidingCount = previous * (1 - windowProgress) + current;
      return Math.max(0, Math.floor(burst - slidingCount));
    } catch (err) {
      writeLog('warn', 'Redis getRemainingTokens error', { error: err instanceof Error ? err.message : String(err) });
      return this.burst;
    }
  }

  clean(_maxAge?: number): void {
    // Redis 键会自动过期，不需要手动清理
  }
}
