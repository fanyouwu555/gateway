/**
 * 限流中间件
 * 基于令牌桶算法实现
 */
import type { Context, Next } from 'hono';
import { getConfig } from '../config';
import { createRedisConfigFromEnv } from '../stores/redis';
import type Redis from 'ioredis';
import { writeLog } from '../utils/logger';

/**
 * 令牌桶状态
 */
interface TokenBucket {
  tokens: number;
  lastRefill: number;
}

/**
 * 限流存储（生产环境应使用 Redis）
 */
class RateLimitStore {
  private buckets = new Map<string, TokenBucket>();
  private readonly qps: number;
  private readonly burst: number;

  constructor(qps: number, burst: number) {
    this.qps = qps;
    this.burst = burst;
  }

  /**
   * 获取客户端标识（API Key 或 IP）
   */
  private getClientKey(c: Context): string {
    // 优先使用 API Key
    const apiKey = c.get('api_key');
    if (apiKey) {
      return `key:${apiKey}`;
    }

    // 使用 IP
    const ip =
      c.req.header('x-forwarded-for') ||
      c.req.header('x-real-ip') ||
      'unknown';
    return `ip:${ip}`;
  }

  /**
   * 补充令牌
   */
  private refill(bucket: TokenBucket): void {
    const now = Date.now();
    const timePassed = (now - bucket.lastRefill) / 1000;
    const tokensToAdd = timePassed * this.qps;

    bucket.tokens = Math.min(this.burst, bucket.tokens + tokensToAdd);
    bucket.lastRefill = now;
  }

  /**
   * 尝试消费令牌
   */
  consume(c: Context, tokens = 1): boolean {
    const key = this.getClientKey(c);
    let bucket = this.buckets.get(key);

    if (!bucket) {
      bucket = {
        tokens: this.burst,
        lastRefill: Date.now(),
      };
      this.buckets.set(key, bucket);
    }

    // 补充令牌
    this.refill(bucket);

    // 检查令牌是否足够
    if (bucket.tokens >= tokens) {
      bucket.tokens -= tokens;
      return true;
    }

    return false;
  }

  /**
   * 获取剩余令牌数（用于调试）
   */
  getRemainingTokens(c: Context): number {
    const key = this.getClientKey(c);
    const bucket = this.buckets.get(key);

    if (!bucket) {
      return this.burst;
    }

    const bucketCopy = { ...bucket };
    this.refill(bucketCopy);
    return Math.floor(bucketCopy.tokens);
  }

  /**
   * 清理过期条目
   */
  clean(maxAge?: number): void {
    const now = Date.now();
    const age = maxAge ?? 60000; // 默认1分钟

    for (const [key, bucket] of this.buckets.entries()) {
      if (now - bucket.lastRefill > age) {
        this.buckets.delete(key);
      }
    }
  }
}

/**
 * Redis 限流存储（生产环境）
 * 基于滑动窗口计数器实现，支持跨实例共享
 */
class RedisRateLimitStore {
  private client: Redis | null = null;
  private readonly burst: number;

  constructor(_qps: number, burst: number) {
    this.burst = burst;
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
    const apiKey = c.get('api_key');
    if (apiKey) {
      return `key:${apiKey}`;
    }
    const ip = c.req.header('x-forwarded-for') || c.req.header('x-real-ip') || 'unknown';
    return `ip:${ip}`;
  }

  /**
   * 尝试消费令牌（原子操作）
   * 使用滑动窗口：每秒一个窗口，统计前 1s + 当前窗口的请求数
   */
  async consume(c: Context, _tokens = 1): Promise<boolean> {
    if (!this.client) {
      // Redis 不可用时回退到允许通过
      return true;
    }

    const key = this.getClientKey(c);
    const now = Date.now();
    const windowMs = 1000; // 1 秒窗口
    const windowKey = `${key}:${Math.floor(now / windowMs)}`;

    try {
      // 使用 MULTI 事务原子操作
      const multi = this.client.multi();
      multi.incr(windowKey);
      multi.expire(windowKey, 2); // 2 秒过期
      const results = await multi.exec();
      if (!results) return true;

      const count = results[0][1] as number;
      return count <= this.burst;
    } catch (err) {
      writeLog('warn', 'Redis consume error', { error: err instanceof Error ? err.message : String(err) });
      return true;
    }
  }

  async getRemainingTokens(c: Context): Promise<number> {
    if (!this.client) return this.burst;
    const key = this.getClientKey(c);
    const now = Date.now();
    const windowMs = 1000;
    const windowKey = `${key}:${Math.floor(now / windowMs)}`;

    try {
      const count = await this.client.get(windowKey);
      const current = count ? parseInt(count, 10) : 0;
      return Math.max(0, this.burst - current);
    } catch (err) {
      writeLog('warn', 'Redis getRemainingTokens error', { error: err instanceof Error ? err.message : String(err) });
      return this.burst;
    }
  }

  clean(_maxAge?: number): void {
    // Redis 键会自动过期，不需要手动清理
  }
}

// 限流存储实例
let rateLimitStore: RateLimitStore | null = null;
let redisRateLimitStore: RedisRateLimitStore | null = null;

/**
 * 重置限流存储（用于测试隔离）
 */
export function resetRateLimitStore(): void {
  rateLimitStore = null;
  redisRateLimitStore = null;
}

/**
 * 是否使用 Redis 限流
 */
function useRedisRateLimit(): boolean {
  return process.env.RATE_LIMIT_STORAGE === 'redis' || !!process.env.REDIS_URL || !!process.env.REDIS_HOST;
}

/**
 * 获取限流存储实例
 */
async function getRateLimitStore(): Promise<RateLimitStore | RedisRateLimitStore> {
  if (useRedisRateLimit()) {
    if (!redisRateLimitStore) {
      const config = getConfig();
      redisRateLimitStore = new RedisRateLimitStore(
        config.rate_limit.qps,
        config.rate_limit.burst
      );
      await redisRateLimitStore.connect();
    }
    return redisRateLimitStore;
  }

  if (!rateLimitStore) {
    const config = getConfig();
    rateLimitStore = new RateLimitStore(
      config.rate_limit.qps,
      config.rate_limit.burst
    );
  }
  return rateLimitStore;
}

/**
 * 限流中间件
 */
export async function rateLimitMiddleware(
  c: Context,
  next: Next
): Promise<Response | void> {
  const config = getConfig();

  // 如果未启用限流，跳过
  if (!config.rate_limit.enabled) {
    await next();
    return;
  }

  const store = await getRateLimitStore();

  let allowed: boolean;
  let remaining: number;

  if (store instanceof RedisRateLimitStore) {
    allowed = await store.consume(c);
    remaining = await store.getRemainingTokens(c);
  } else {
    allowed = store.consume(c);
    remaining = store.getRemainingTokens(c);
  }

  if (allowed) {
    // 添加响应头
    c.res.headers.set('X-RateLimit-Remaining', String(remaining));
    c.res.headers.set('X-RateLimit-Limit', String(config.rate_limit.burst));

    await next();
  } else {
    return c.json({
      error: {
        message: 'Rate limit exceeded. Please try again later.',
        type: 'rate_limit_error',
        code: 'rate_limit_exceeded',
      },
    }, 429);
  }
}

/**
 * 清理限流存储（定时任务调用）
 */
export function cleanRateLimitStore(maxAge?: number): void {
  rateLimitStore?.clean(maxAge);
  redisRateLimitStore?.clean(maxAge);
}

let _cleanInterval: ReturnType<typeof setInterval> | null = null;

/**
 * 设置限流清理间隔（从配置读取）
 */
export function initRateLimitCleanInterval(ms?: number): void {
  if (_cleanInterval !== null) {
    clearInterval(_cleanInterval);
  }
  const interval = ms ?? 60000;
  _cleanInterval = setInterval(() => {
    cleanRateLimitStore(interval);
  }, interval);
}

// 设置定期清理（默认值）
if (typeof setInterval !== 'undefined') {
  _cleanInterval = setInterval(() => {
    cleanRateLimitStore(60000);
  }, 60000);
}