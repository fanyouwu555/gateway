/**
 * 工具函数库
 */
import { scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { v4 as uuidv4 } from 'uuid';
import type { RequestId } from '../types';

/**
 * 生成请求ID
 */
export function generateRequestId(): RequestId {
  return `req_${uuidv4().replace(/-/g, '')}`;
}

/**
 * 获取当前时间戳（毫秒）
 */
export function getTimestamp(): number {
  return Date.now();
}

/**
 * 脱敏API Key (显示前4位和后4位)
 */
export function maskApiKey(key: string): string {
  if (key.length <= 8) {
    return '*'.repeat(key.length);
  }
  return `${key.slice(0, 4)}${'*'.repeat(key.length - 8)}${key.slice(-4)}`;
}

/**
 * 安全获取环境变量
 */
export function getEnv(key: string, defaultValue = ''): string {
  const value = process.env[key];
  return value || defaultValue;
}

/**
 * 解析Bearer Token
 */
export function parseBearerToken(authHeader: string | null): string | null {
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return null;
  }
  return authHeader.slice(7);
}

/**
 * 深度合并对象
 */
export function deepMerge<T extends Record<string, unknown>>(
  target: T,
  source: Partial<T>
): T {
  const result = { ...target };
  for (const key in source) {
    if (source[key] !== undefined) {
      if (
        typeof source[key] === 'object' &&
        source[key] !== null &&
        !Array.isArray(source[key])
      ) {
        result[key] = deepMerge(
          (result[key] as Record<string, unknown>) || {},
          source[key] as Record<string, unknown>
        ) as T[Extract<keyof T, string>];
      } else {
        result[key] = source[key] as T[Extract<keyof T, string>];
      }
    }
  }
  return result;
}

/**
 * 计算重试退避时间（指数退避）
 */
export function getRetryDelay(attempt: number, baseDelay = 1000): number {
  return Math.min(baseDelay * Math.pow(2, attempt), 30000);
}

/**
 * 格式化字节大小
 */
export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
}

/**
 * 安全解析JSON
 */
export function safeJsonParse<T>(
  json: string,
  fallback: T
): T {
  try {
    return JSON.parse(json) as T;
  } catch {
    return fallback;
  }
}

/**
 * 延迟函数
 */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ===== API Key 安全存储 =====

/** 哈希配置 */
const HASH_CONFIG = {
  keyLength: 64,
  saltLength: 16,
  prefix: '$scrypt$',
} as const;

/**
 * 对 API Key 进行哈希（使用 scrypt）
 */
export function hashApiKey(apiKey: string): string {
  const salt = randomBytes(HASH_CONFIG.saltLength).toString('hex');
  const derivedKey = scryptSync(apiKey, salt, HASH_CONFIG.keyLength);
  return `${HASH_CONFIG.prefix}${salt}:${derivedKey.toString('hex')}`;
}

/**
 * 验证 API Key 是否匹配哈希
 * 注意：存储的 key 必须是哈希格式（以 $scrypt$ 开头）
 */
export function verifyApiKey(apiKey: string, hashed: string): boolean {
  if (!hashed.startsWith(HASH_CONFIG.prefix)) {
    return false;
  }

  const stripped = hashed.slice(HASH_CONFIG.prefix.length);
  const [salt, keyHex] = stripped.split(':');
  if (!salt || !keyHex) return false;

  const derivedKey = scryptSync(apiKey, salt, HASH_CONFIG.keyLength);
  const keyBuf = Buffer.from(keyHex, 'hex');

  // 常量时间比较，防止时序攻击
  if (derivedKey.length !== keyBuf.length) return false;
  return timingSafeEqual(derivedKey, keyBuf);
}

/**
 * 判断字符串是否为哈希格式
 */
function isHashedKey(key: string): boolean {
  return key.startsWith(HASH_CONFIG.prefix);
}

/**
 * 将 API Key 哈希化（如尚未哈希）
 */
export function ensureKeyHashed(key: string): string {
  if (isHashedKey(key)) return key;
  return hashApiKey(key);
}