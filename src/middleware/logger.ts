/**
 * 请求日志中间件
 */
import type { Context, Next } from 'hono';
import { generateRequestId, getTimestamp, maskApiKey } from '../utils';
import type { IRequestLog } from '../types';

/**
 * 日志级别
 */
type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

/**
 * 获取当前日志级别
 */
function getCurrentLogLevel(): LogLevel {
  const level = (process.env.LOG_LEVEL?.toLowerCase() || 'info') as LogLevel;
  return LOG_LEVELS[level] !== undefined ? level : 'info';
}

/**
 * 写入结构化日志 (JSON格式)
 */
function writeLog(level: LogLevel, message: string, meta?: Record<string, unknown>): void {
  const currentLevelNum = LOG_LEVELS[getCurrentLogLevel()];
  const levelNum = LOG_LEVELS[level];
  if (levelNum < currentLevelNum) {
    return;
  }

  const logEntry = {
    timestamp: new Date().toISOString(),
    level: level.toUpperCase(),
    message,
    ...meta,
  };

  // 生产环境输出JSON，便于日志收集
  if (process.env.NODE_ENV === 'production') {
    console.log(JSON.stringify(logEntry));
  } else {
    // 开发环境友好格式
    console.log(
      `[${logEntry.timestamp}] [${logEntry.level}] ${logEntry.message}`,
      meta ? meta : ''
    );
  }
}

/**
 * 日志中间件
 */
export async function loggerMiddleware(c: Context, next: Next): Promise<void> {
  const startTime = getTimestamp();
  const requestId = generateRequestId();

  // 保存requestId到上下文
  c.set('request_id', requestId);

  // 记录请求开始
  writeLog('info', 'Request started', {
    request_id: requestId,
    method: c.req.method,
    path: c.req.path,
    ip: c.req.header('x-forwarded-for') || c.req.header('x-real-ip') || 'unknown',
  });

  await next();

  const duration = getTimestamp() - startTime;
  const status = c.res.status;
  const provider = c.get('provider');
  const model = c.get('model');
  const tenantId = c.get('tenant_id');

  // 构建日志数据
  const logData: IRequestLog = {
    request_id: requestId,
    tenant_id: tenantId,
    timestamp: startTime,
    method: c.req.method,
    path: c.req.path,
    provider,
    model,
    status_code: status,
    duration_ms: duration,
  };

  // 记录请求完成
  const level: LogLevel = status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info';
  writeLog(level, 'Request completed', logData as unknown as Record<string, unknown>);
}

/**
 * 请求错误日志
 */
export function logError(requestId: string, error: Error, context?: Record<string, unknown>): void {
  writeLog('error', 'Request error', {
    request_id: requestId,
    error: error.message,
    stack: error.stack,
    ...context,
  });
}

/**
 * 敏感信息脱敏辅助函数
 */
export function sanitizeLogData(data: Record<string, unknown>): Record<string, unknown> {
  const sanitized = { ...data };
  const sensitiveKeys = ['api_key', 'authorization', 'password', 'token', 'secret'];

  for (const key of sensitiveKeys) {
    if (sanitized[key] && typeof sanitized[key] === 'string') {
      sanitized[key] = maskApiKey(sanitized[key] as string);
    }
  }

  return sanitized;
}