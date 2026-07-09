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
import { ConcurrencyLimiter } from '../services/concurrency-limiter';
import { getTenant } from '../services/tenant';
import { shouldUseRedis } from '../utils';

// 限流存储实例
let rateLimitStore: IRateLimitStore | null = null;
let adminRateLimitStore: IRateLimitStore | null = null;

// 并发限制器
const concurrencyLimiter = new ConcurrencyLimiter();

/**
 * 限流检查输入
 */
export interface RateLimitCheckInfo {
  tenantId?: string;
  keyHash?: string;
  isAdminPath: boolean;
  model?: string;
  rateLimitQps?: number;
  rateLimitBurst?: number;
}

/**
 * 限流检查结果
 */
export interface RateLimitResult {
  allowed: boolean;
  remaining?: number;
  limit?: number;
  retryAfter?: number;
  reason?: string;
}

/**
 * 可编程限流检查
 * 返回检查结果与并发槽释放回调，供 HTTP 中间件和 WebSocket 复用
 */
export async function checkRateLimit(
  info: RateLimitCheckInfo
): Promise<{ result: RateLimitResult; release?: () => void }> {
  const config = getConfig();
  if (!config.rate_limit?.enabled) {
    return { result: { allowed: true } };
  }

  const tenantId = info.tenantId;
  const keyHash = info.keyHash;
  const concurrencyKey = keyHash || tenantId || 'global';
  let concurrencyLimit = 0;
  let acquired = false;

  if (tenantId) {
    const tenant = getTenant(tenantId);
    if (tenant?.limits?.concurrent_requests) {
      concurrencyLimit = tenant.limits.concurrent_requests;
    }
  }

  if (concurrencyLimit > 0) {
    acquired = concurrencyLimiter.acquire(concurrencyKey, concurrencyLimit);
    if (!acquired) {
      return { result: { allowed: false, reason: 'concurrent_limit_exceeded' } };
    }
  }

  const store = await getRateLimitStore(info.isAdminPath);
  const limit = info.isAdminPath
    ? (config.rate_limit.burst ?? 20) * 2
    : (config.rate_limit.burst ?? 20);

  const mockC = {
    req: { header: () => undefined },
    get: (key: string) => {
      if (key === 'tenant_id') return tenantId;
      if (key === 'key_hash') return keyHash;
      if (key === 'key_rate_limit_qps') return info.rateLimitQps;
      if (key === 'key_rate_limit_burst') return info.rateLimitBurst;
      return undefined;
    },
  } as unknown as Context;

  const allowed = await store.consume(mockC);
  const remaining = await store.getRemainingTokens(mockC);

  if (!allowed) {
    if (acquired) {
      concurrencyLimiter.release(concurrencyKey);
    }
    const qps = config.rate_limit.qps ?? 10;
    const retryAfter = Math.max(1, Math.ceil(1 / qps));
    return {
      result: { allowed: false, remaining: 0, limit, retryAfter, reason: 'rate_limit_exceeded' },
    };
  }

  return {
    result: { allowed: true, remaining, limit },
    release: acquired ? () => concurrencyLimiter.release(concurrencyKey) : () => {},
  };
}

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
  return shouldUseRedis('RATE_LIMIT_STORAGE');
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

  const isAdminPath =
    c.req.path.startsWith('/v1/tenants') ||
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

  const { result, release } = await checkRateLimit({
    tenantId: c.get('tenant_id'),
    keyHash: c.get('key_hash'),
    isAdminPath,
    rateLimitQps: c.get('key_rate_limit_qps'),
    rateLimitBurst: c.get('key_rate_limit_burst'),
  });

  if (!result.allowed) {
    if (result.retryAfter) {
      c.res.headers.set('Retry-After', String(result.retryAfter));
    }
    return c.json(
      {
        error: {
          message: 'Rate limit exceeded. Please try again later.',
          type: 'rate_limit_error',
          code: result.reason || 'rate_limit_exceeded',
        },
      },
      429
    );
  }

  c.res.headers.set('X-RateLimit-Remaining', String(result.remaining));
  c.res.headers.set('X-RateLimit-Limit', String(result.limit));

  try {
    await next();
  } finally {
    release?.();
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
