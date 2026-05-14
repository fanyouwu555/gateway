/**
 * 请求日志中间件
 * 日志核心功能在 src/utils/logger.ts
 */
import type { Context, Next } from 'hono';
import { generateRequestId, getTimestamp } from '../utils';
import { writeLog } from '../utils/logger';
import type { IRequestLog } from '../types';

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

  // 将请求ID注入响应头
  try {
    c.res.headers.set('X-Request-Id', requestId);
  } catch {
    writeLog('warn', 'Failed to set X-Request-Id header', { request_id: requestId });
  }

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
  const level: 'error' | 'warn' | 'info' = status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info';
  writeLog(level, 'Request completed', logData as unknown as Record<string, unknown>);
}

// 重新导出核心日志功能，方便其他模块统一引用
export { writeLog, logError, sanitizeLogData } from '../utils/logger';
export type { LogLevel } from '../utils/logger';
