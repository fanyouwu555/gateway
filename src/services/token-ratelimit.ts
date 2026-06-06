/**
 * Token 级按模型限流服务
 *
 * 为每个模型配置每分钟 token 配额，
 * 使用令牌桶算法，在请求完成后消耗 tokens，
 * 超出配额的模型在下一次请求时被拒绝 (429)
 */
import { getConfig } from '../config';

interface TokenBucket {
  tokens: number;
  lastRefill: number;
}

/**
 * 令牌桶 Token 限流存储
 */
class TokenRateLimitStore {
  private buckets = new Map<string, TokenBucket>();

  /**
   * 获取模型的限流配置
   */
  private getModelConfig(model: string): { tokensPerMinute: number; burstTokens: number } | null {
    const limits = getConfig().model_rate_limits?.[model];
    if (!limits) return null; // 未配置 = 不限流
    return {
      tokensPerMinute: limits.tokens_per_minute,
      burstTokens: limits.burst_tokens ?? limits.tokens_per_minute,
    };
  }

  /**
   * 补充令牌
   */
  private refill(bucket: TokenBucket, tokensPerMinute: number, burstTokens: number): void {
    const now = Date.now();
    const timePassed = (now - bucket.lastRefill) / 1000;
    const tokensToAdd = timePassed * (tokensPerMinute / 60);
    bucket.tokens = Math.min(burstTokens, bucket.tokens + tokensToAdd);
    bucket.lastRefill = now;
  }

  /**
   * 消耗令牌
   * @returns true 如果消耗成功（未超限），false 如果超限
   */
  consume(model: string, tokenCount: number): boolean {
    if (tokenCount <= 0) return true;

    const cfg = this.getModelConfig(model);
    if (!cfg) return true; // 未配置 = 不限流

    const key = `model:${model}`;
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = { tokens: cfg.burstTokens, lastRefill: Date.now() };
      this.buckets.set(key, bucket);
    }

    this.refill(bucket, cfg.tokensPerMinute, cfg.burstTokens);

    if (bucket.tokens >= tokenCount) {
      bucket.tokens -= tokenCount;
      return true;
    }

    // 超限：仍然消耗剩余部分，但返回 false
    bucket.tokens = 0;
    return false;
  }

  /**
   * 获取模型的剩余 token 配额
   */
  getRemaining(model: string): number {
    const cfg = this.getModelConfig(model);
    if (!cfg) return Infinity;

    const key = `model:${model}`;
    const bucket = this.buckets.get(key);
    if (!bucket) return cfg.burstTokens;

    const copy: TokenBucket = { tokens: bucket.tokens, lastRefill: bucket.lastRefill };
    this.refill(copy, cfg.tokensPerMinute, cfg.burstTokens);
    return Math.max(0, Math.floor(copy.tokens));
  }

  /**
   * 清理过期桶
   */
  clean(maxAge = 60000): void {
    const now = Date.now();
    for (const [key, bucket] of this.buckets.entries()) {
      if (now - bucket.lastRefill > maxAge) {
        this.buckets.delete(key);
      }
    }
  }

  /**
   * 重置（用于测试隔离）
   */
  reset(): void {
    this.buckets.clear();
  }
}

// 单例
let _instance: TokenRateLimitStore | null = null;

/**
   * 获取 Token 限流存储实例
   */
export function getTokenRateLimit(): TokenRateLimitStore | null {
  const config = getConfig();
  if (!config.model_rate_limits || Object.keys(config.model_rate_limits).length === 0) {
    return null; // 禁用
  }
  if (!_instance) {
    _instance = new TokenRateLimitStore();
  }
  return _instance;
}

/**
 * 重置 Token 限流存储（用于测试隔离）
 */
export function resetTokenRateLimit(): void {
  _instance = null;
}

export { TokenRateLimitStore };