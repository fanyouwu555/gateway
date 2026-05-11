/**
 * API Key 鉴权中间件
 */
import type { Context, Next } from 'hono';
import { getConfig } from '../config';
import type { IAuthResult, IApiKeyMeta } from '../types';

/**
 * 验证API Key
 */
function validateApiKey(apiKey: string): IAuthResult {
  const config = getConfig();

  if (!config.auth.enabled) {
    return { valid: true };
  }

  const storedKey = config.auth.api_keys.find((k) => k.key === apiKey);

  if (!storedKey) {
    return {
      valid: false,
      error: 'Invalid API key',
    };
  }

  // 检查是否过期
  if (storedKey.expires_at && storedKey.expires_at < Date.now()) {
    return {
      valid: false,
      error: 'API key expired',
    };
  }

  return {
    valid: true,
    tenant_id: storedKey.tenant_id,
    api_key_meta: storedKey,
  };
}

/**
 * 认证中间件
 */
export async function authMiddleware(c: Context, next: Next): Promise<void> {
  const config = getConfig();

  // 如果未启用认证，跳过
  if (!config.auth.enabled) {
    await next();
    return;
  }

  // 从Header获取API Key
  const apiKey = c.req.header('x-api-key') || c.req.header('Authorization')?.replace('Bearer ', '');

  if (!apiKey) {
    c.status(401);
    c.json({
      error: {
        message: 'Missing API key. Provide it in x-api-key header or Authorization header.',
        type: 'authentication_error',
        code: 'missing_api_key',
      },
    });
    return;
  }

  const result = validateApiKey(apiKey);

  if (!result.valid) {
    c.status(401);
    c.json({
      error: {
        message: result.error || 'Authentication failed',
        type: 'authentication_error',
        code: 'invalid_api_key',
      },
    });
    return;
  }

  // 保存鉴权信息到上下文
  if (result.tenant_id) {
    c.set('tenant_id', result.tenant_id);
  }
  c.set('api_key', apiKey);

  await next();
}

/**
 * 生成测试用API Key（仅开发环境）
 */
export function generateTestApiKey(name: string = 'test-key'): IApiKeyMeta {
  const key = `sk-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return {
    key,
    tenant_id: 'default',
    name,
    created_at: Date.now(),
  };
}