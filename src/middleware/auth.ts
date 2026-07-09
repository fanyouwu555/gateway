/**
 * API Key 鉴权中间件
 * 支持两种 API Key 来源：
 *   1. 配置文件中的 api_keys（哈希存储）
 *   2. 租户管理创建的 API Keys（通过 TenantStore）
 */
import type { Context, Next } from 'hono';
import { getConfig } from '../config';
import type { IAuthResult, IApiKeyMeta } from '../types';
import { verifyApiKey, hashApiKey, generateSecureRandomString } from '../utils';
import { findApiKeyByPrefix, findTenantApiKeyByHash, getTenant } from '../services/tenant';

function buildAuthResult(storedKey: IApiKeyMeta): IAuthResult {
  if (storedKey.expires_at && storedKey.expires_at < Date.now()) {
    return { valid: false, error: 'API key expired' };
  }
  if (storedKey.tenant_id) {
    const tenant = getTenant(storedKey.tenant_id);
    if (tenant && tenant.status !== 'active') {
      return { valid: false, error: 'Tenant is not active' };
    }
  }
  return {
    valid: true,
    tenant_id: storedKey.tenant_id,
    api_key_meta: storedKey,
  };
}

/**
 * 验证API Key
 */
function validateApiKey(apiKey: string): IAuthResult {
  const config = getConfig();

  if (!config.auth.enabled) {
    return { valid: true };
  }

  const configKeys = config.auth.api_keys || [];
  for (const keyMeta of configKeys) {
    if (verifyApiKey(apiKey, keyMeta.key)) {
      return buildAuthResult(keyMeta);
    }
  }

  const prefix = apiKey.slice(0, 10);
  const candidateHashes = findApiKeyByPrefix(prefix);
  for (const hashedKey of candidateHashes) {
    const keyMeta = findTenantApiKeyByHash(hashedKey);
    if (keyMeta && verifyApiKey(apiKey, keyMeta.key)) {
      return buildAuthResult(keyMeta);
    }
  }

  return { valid: false, error: 'Invalid API key' };
}

/**
 * 认证中间件
 */
export async function authMiddleware(c: Context, next: Next): Promise<Response | void> {
  const config = getConfig();

  // 如果未启用认证，跳过
  if (!config.auth.enabled) {
    await next();
    return;
  }

  // 从Header获取API Key（WebSocket优先使用Sec-WebSocket-Protocol）
  let apiKey = c.req.header('x-api-key') || c.req.header('Authorization')?.replace('Bearer ', '');
  if (!apiKey) {
    const wsProtocol = c.req.header('sec-websocket-protocol');
    if (wsProtocol) {
      const tokenProtocol = wsProtocol.split(',').map(p => p.trim()).find(p => p.startsWith('gateway-token-'));
      if (tokenProtocol) {
        apiKey = tokenProtocol.replace('gateway-token-', '');
      }
    }
  }
  if (!apiKey) {
    return c.json({
      error: {
        message: 'Missing API key. Provide it in x-api-key header or Authorization header.',
        type: 'authentication_error',
        code: 'missing_api_key',
      },
    }, 401);
  }

  const result = validateApiKey(apiKey);

  if (!result.valid) {
    return c.json({
      error: {
        message: result.error || 'Authentication failed',
        type: 'authentication_error',
        code: 'invalid_api_key',
      },
    }, 401);
  }

  // 保存鉴权信息到上下文
  if (result.tenant_id) {
    c.set('tenant_id', result.tenant_id);
  }
  if (result.api_key_meta) {
    c.set('api_key_meta', result.api_key_meta);
  }
  c.set('api_key', apiKey);

  await next();
}

/**
 * 管理员权限中间件
 * 要求当前请求的 API Key 具有 is_admin 权限
 */
export async function requireAdmin(c: Context, next: Next): Promise<Response | void> {
  const apiKeyMeta: IApiKeyMeta | undefined = c.get('api_key_meta');

  if (!apiKeyMeta || !apiKeyMeta.is_admin) {
    return c.json({
      error: {
        message: 'Admin privileges required. Use an admin API key.',
        type: 'authentication_error',
        code: 'admin_required',
      },
    }, 403);
  }

  await next();
}

/**
 * 生成测试用API Key（仅开发环境）
 * 返回的 key 字段已自动哈希
 */
export function generateTestApiKey(name: string = 'test-key'): IApiKeyMeta {
  const plaintext = `sk-test-${Date.now()}-${generateSecureRandomString(12)}`;
  return {
    key: hashApiKey(plaintext),
    tenant_id: 'default',
    name,
    created_at: Date.now(),
  };
}

/**
 * 生成测试用明文 API Key（配套 generateTestApiKey 使用）
 * 用于在测试请求中发送
 */
export function generateTestPlaintextKey(): string {
  return `sk-test-${Date.now()}-${generateSecureRandomString(12)}`;
}