/**
 * 虚拟 Key 策略中间件
 * 在 auth 之后、rate limit 之前执行
 * 从 api_key_meta 读取策略配置并应用到 context
 */
import type { Context, Next } from 'hono';
import type { IApiKeyMeta } from '../types';

export async function virtualKeyMiddleware(c: Context, next: Next): Promise<Response | void> {
  const keyMeta: IApiKeyMeta | undefined = c.get('api_key_meta');
  if (!keyMeta) {
    await next();
    return;
  }

  // 存储 Key 哈希值供后续链条使用
  c.set('key_hash', keyMeta.key);

  // 如果有 Key 级 rate limit 设置，存入 context 供 ratelimit middleware 使用
  if (keyMeta.rate_limit_qps !== undefined) {
    c.set('key_rate_limit_qps', keyMeta.rate_limit_qps);
  }
  if (keyMeta.rate_limit_burst !== undefined) {
    c.set('key_rate_limit_burst', keyMeta.rate_limit_burst);
  }

  // 存储 metadata 供日志和用量记录
  if (keyMeta.metadata) {
    c.set('key_metadata', keyMeta.metadata);
  }

  // 存储策略字段供 chat handler 使用
  if (keyMeta.allowed_models) {
    c.set('key_allowed_models', keyMeta.allowed_models);
  }
  if (keyMeta.monthly_budget !== undefined) {
    c.set('key_monthly_budget', keyMeta.monthly_budget);
  }
  if (keyMeta.max_tokens_per_request !== undefined) {
    c.set('key_max_tokens_per_request', keyMeta.max_tokens_per_request);
  }

  await next();
}