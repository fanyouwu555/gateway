/**
 * 工具函数库
 */
import { scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { v4 as uuidv4 } from 'uuid';
import type { ChatContentPart, RequestId } from '../types';

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

/** 一小时的毫秒数 */
export const HOUR_MS = 60 * 60 * 1000;

/** 一天的毫秒数 */
export const DAY_MS = 24 * HOUR_MS;

/** 四舍五入到3位小数 */
export function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** 四舍五入到4位小数 */
export function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
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

/**
 * 将消息内容转为字符串（处理多模态 content 数组）
 */
export function contentToString(content: string | ChatContentPart[] | undefined): string {
  if (!content) return '';
  if (typeof content === 'string') return content;
  return content
    .filter((p) => p.type === 'text' && p.text)
    .map((p) => (p as { text: string }).text)
    .join('\n');
}

/**
 * 从 data URL 解析 base64 图片数据
 */
export function parseImageDataUrl(url: string): { mimeType: string; data: string } | null {
  const match = url.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) return null;
  return { mimeType: match[1], data: match[2] };
}

/**
 * 下载图片并转为 base64（支持 data URL 和 http URL）
 */
export async function fetchImageAsBase64(url: string): Promise<{ mimeType: string; data: string }> {
  const dataUrlResult = parseImageDataUrl(url);
  if (dataUrlResult) {
    return dataUrlResult;
  }

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch image: ${response.status} ${response.statusText}`);
  }

  const blob = await response.blob();
  const arrayBuffer = await blob.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  const mimeType = blob.type || 'image/jpeg';

  return { mimeType, data: buffer.toString('base64') };
}

/**
 * 生成加密安全的随机字符串
 */
export function generateSecureRandomString(length = 16): string {
  return randomBytes(length).toString('base64url').slice(0, length);
}

// ===== API Key 安全存储 =====

/** 哈希配置 */
const HASH_CONFIG = {
  keyLength: 64,
  saltLength: 16,
  prefix: '$scrypt$',
  /** scrypt 参数 — 显式指定以保证跨 Node.js 版本一致性 */
  scryptOptions: {
    N: 32768, // 2^15 — 平衡安全性与验证性能
    r: 8,
    p: 1,
    maxmem: 128 * 1024 * 1024, // 128MB
  },
} as const;

/**
 * 对 API Key 进行哈希（使用 scrypt）
 */
export function hashApiKey(apiKey: string): string {
  const salt = randomBytes(HASH_CONFIG.saltLength).toString('hex');
  const derivedKey = scryptSync(apiKey, salt, HASH_CONFIG.keyLength, HASH_CONFIG.scryptOptions);
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

  const derivedKey = scryptSync(apiKey, salt, HASH_CONFIG.keyLength, HASH_CONFIG.scryptOptions);
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

/**
 * 统一判断是否应该使用 Redis 存储。
 * 优先级：模块级环境变量 > 全局 STORAGE_TYPE / REDIS_URL
 * @param moduleEnvVar 模块级环境变量名（如 'TENANT_STORAGE'）
 */
export function shouldUseRedis(moduleEnvVar?: string): boolean {
  // 如果模块显式设置了环境变量，以其为准
  if (moduleEnvVar && process.env[moduleEnvVar]) {
    return process.env[moduleEnvVar] === 'redis';
  }
  // 否则跟随全局配置
  return (
    process.env.STORAGE_TYPE === 'redis' ||
    !!process.env.REDIS_URL ||
    !!process.env.REDIS_HOST
  );
}