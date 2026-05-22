/**
 * 限流中间件
 * 支持内存令牌桶（单实例）和 Redis 滑动窗口（分布式）
 */
import type { Context, Next } from 'hono';
import { getConfig } from '../config';
import { createRedisConfigFromEnv } from '../stores/redis';
import type Redis from 'ioredis';
import { writeLog } from '../utils/logger';

/**
 * 限流存储接口
 */
interface IRateLimitStore {
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
 * 适合单实例部署场景
 */
class MemoryRateLimitStore implements IRateLimitStore {
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
   * 尝试消费令牌
   */
  async consume(c: Context, tokens = 1): Promise<boolean> {
    const key = this.getClientKey(c);

    // Key 级限流覆盖：当 context 中有 key 级别的 QPS/burst 时，使用独立 bucket
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

    // 补充令牌（使用 Key 级 QPS 或全局 QPS）
    this.refillWith(bucket, keyQps ?? this.qps, keyBurst ?? this.burst);

    // 检查令牌是否足够
    if (bucket.tokens >= tokens) {
      bucket.tokens -= tokens;
      return true;
    }

    return false;
  }

  /**
   * 补充令牌（带 QPS/Burst 参数）
   */
  private refillWith(bucket: TokenBucket, qps: number, burst: number): void {
    const now = Date.now();
    const timePassed = (now - bucket.lastRefill) / 1000;
    const tokensToAdd = timePassed * qps;

    bucket.tokens = Math.min(burst, bucket.tokens + tokensToAdd);
    bucket.lastRefill = now;
  }

  /**
   * 获取剩余令牌数（用于调试）
   */
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
 * 基于精确滑动窗口计数器实现，支持跨多实例共享
 */
class RedisRateLimitStore implements IRateLimitStore {
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
   * 使用精确滑动窗口：统计前一窗口的加权部分 + 当前窗口的请求数
   */
  async consume(c: Context, _tokens = 1): Promise<boolean> {
    if (!this.client) {
      // Redis 不可用时回退到允许通过
      return true;
    }

    const key = this.getClientKey(c);
    const now = Date.now();
    const windowMs = 1000; // 1 秒窗口

    const currentWindowIdx = Math.floor(now / windowMs);
    const previousWindowIdx = currentWindowIdx - 1;
    const windowProgress = (now % windowMs) / windowMs; // 0-1 当前窗口进度

    const currentKey = `${key}:${currentWindowIdx}`;
    const previousKey = `${key}:${previousWindowIdx}`;

    try {
      // 使用 Lua 脚本保证原子性
      const luaScript = `
        local currentKey = KEYS[1]
        local previousKey = KEYS[2]
        local windowProgress = tonumber(ARGV[1])
        local burst = tonumber(ARGV[2])
        local ttl = tonumber(ARGV[3])

        -- 获取前一窗口和当前窗口的计数
        local previous = redis.call('get', previousKey)
        previous = previous and tonumber(previous) or 0
        local current = redis.call('get', currentKey)
        current = current and tonumber(current) or 0

        -- 计算滑动窗口总数：前一窗口的剩余部分 + 当前窗口
        local slidingCount = previous * (1 - windowProgress) + current + 1

        if slidingCount <= burst then
          -- 允许通过，增加当前窗口计数
          redis.call('incr', currentKey)
          redis.call('expire', currentKey, ttl)
          return 1
        else
          return 0
        end
      `;

      const result = await this.client.eval(luaScript, 2, currentKey, previousKey, windowProgress, this.burst, 2);
      return result === 1;
    } catch (err) {
      writeLog('warn', 'Redis consume error', { error: err instanceof Error ? err.message : String(err) });
      return true; // Redis 出错时放行
    }
  }

  async getRemainingTokens(c: Context): Promise<number> {
    if (!this.client) return this.burst;
    const key = this.getClientKey(c);
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
      return Math.max(0, Math.floor(this.burst - slidingCount));
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
let rateLimitStore: IRateLimitStore | null = null;
let adminRateLimitStore: IRateLimitStore | null = null;

/**
 * 重置限流存储（用于测试隔离）
 */
export function resetRateLimitStore(): void {
  rateLimitStore = null;
  adminRateLimitStore = null;
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
async function getRateLimitStore(isAdmin = false): Promise<IRateLimitStore> {
  if (isAdmin) {
    if (!adminRateLimitStore) {
      const config = getConfig();
      // Admin 路由使用更宽松的限流（burst 翻倍）
      const adminQps = config.rate_limit.qps * 2;
      const adminBurst = config.rate_limit.burst * 2;

      if (useRedisRateLimit()) {
        const redisStore = new RedisRateLimitStore(adminQps, adminBurst);
        await redisStore.connect();
        adminRateLimitStore = redisStore;
      } else {
        adminRateLimitStore = new MemoryRateLimitStore(adminQps, adminBurst);
      }
    }
    return adminRateLimitStore;
  }

  if (!rateLimitStore) {
    const config = getConfig();

    if (useRedisRateLimit()) {
      const redisStore = new RedisRateLimitStore(
        config.rate_limit.qps,
        config.rate_limit.burst
      );
      await redisStore.connect();
      rateLimitStore = redisStore;
    } else {
      rateLimitStore = new MemoryRateLimitStore(
        config.rate_limit.qps,
        config.rate_limit.burst
      );
    }
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

  const isAdminPath = c.req.path.startsWith('/v1/tenants') ||
    c.req.path.startsWith('/v1/config') ||
    c.req.path.startsWith('/v1/plugins') ||
    c.req.path.startsWith('/v1/usage') ||
    c.req.path.startsWith('/v1/quota') ||
    c.req.path.startsWith('/v1/cache') ||
    c.req.path.startsWith('/v1/prompts') ||
    c.req.path.startsWith('/v1/alerts') ||
    c.req.path.startsWith('/v1/router') ||
    c.req.path.startsWith('/v1/sessions') ||
    c.req.path.startsWith('/v1/auth/verify');

  const store = await getRateLimitStore(isAdminPath);
  const limit = isAdminPath ? config.rate_limit.burst * 2 : config.rate_limit.burst;

  const allowed = await store.consume(c);
  const remaining = await store.getRemainingTokens(c);

  if (allowed) {
    // 添加响应头
    c.res.headers.set('X-RateLimit-Remaining', String(remaining));
    c.res.headers.set('X-RateLimit-Limit', String(limit));

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