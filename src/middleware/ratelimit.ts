/**
 * 限流中间件
 * 基于令牌桶算法实现
 */
import type { Context, Next } from 'hono';
import { getConfig } from '../config';

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
  clean(): void {
    const now = Date.now();
    const maxAge = 60000; // 1分钟

    for (const [key, bucket] of this.buckets.entries()) {
      if (now - bucket.lastRefill > maxAge) {
        this.buckets.delete(key);
      }
    }
  }
}

// 限流存储实例
let rateLimitStore: RateLimitStore | null = null;

/**
 * 获取限流存储实例
 */
function getRateLimitStore(): RateLimitStore {
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
): Promise<void> {
  const config = getConfig();

  // 如果未启用限流，跳过
  if (!config.rate_limit.enabled) {
    await next();
    return;
  }

  const store = getRateLimitStore();

  if (store.consume(c)) {
    // 添加响应头
    const remaining = store.getRemainingTokens(c);
    c.res.headers.set('X-RateLimit-Remaining', String(remaining));
    c.res.headers.set('X-RateLimit-Limit', String(config.rate_limit.burst));

    await next();
  } else {
    c.status(429);
    c.json({
      error: {
        message: 'Rate limit exceeded. Please try again later.',
        type: 'rate_limit_error',
        code: 'rate_limit_exceeded',
      },
    });
  }
}

/**
 * 清理限流存储（定时任务调用）
 */
export function cleanRateLimitStore(): void {
  rateLimitStore?.clean();
}

// 设置定期清理
if (typeof setInterval !== 'undefined') {
  setInterval(cleanRateLimitStore, 60000);
}