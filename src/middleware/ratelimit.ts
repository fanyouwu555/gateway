/**
 * 限流中间件
 * 支持内存令牌桶（单实例）和 Redis 滑动窗口（分布式）
 */
import type { Context, Next } from 'hono';
import { getConfig } from '../config';
import {
  type IRateLimitStore,
  MemoryRateLimitStore,
  RedisRateLimitStore,
} from '../stores/ratelimit';

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
  const failOpen = process.env.RATE_LIMIT_FAIL_OPEN !== 'false';

  if (isAdmin) {
    if (!adminRateLimitStore) {
      const config = getConfig();
      const adminQps = (config.rate_limit.qps ?? 10) * 2;
      const adminBurst = (config.rate_limit.burst ?? 20) * 2;

      if (useRedisRateLimit()) {
        const redisStore = new RedisRateLimitStore(adminQps, adminBurst, failOpen);
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
        config.rate_limit.qps ?? 10,
        config.rate_limit.burst ?? 20,
        failOpen
      );
      await redisStore.connect();
      rateLimitStore = redisStore;
    } else {
      rateLimitStore = new MemoryRateLimitStore(
        config.rate_limit.qps ?? 10,
        config.rate_limit.burst ?? 20
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
  const limit = isAdminPath ? (config.rate_limit.burst ?? 20) * 2 : (config.rate_limit.burst ?? 20);

  const allowed = await store.consume(c);
  const remaining = await store.getRemainingTokens(c);

  if (allowed) {
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
  if (_cleanInterval.unref) _cleanInterval.unref();
}
