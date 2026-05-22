/**
 * 请求日志中间件
 * 日志核心功能在 src/utils/logger.ts
 */
import type { Context, Next } from 'hono';
import { generateRequestId, getTimestamp } from '../utils';
import { writeLog } from '../utils/logger';
import { recordMetric } from '../services/metrics';
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

  // 记录指标并广播（只对聊天和嵌入请求）
  if (c.req.path.includes('/chat/completions') || c.req.path.includes('/embeddings')) {
    // 从响应上下文获取 token 使用量
    const promptTokens = c.get('prompt_tokens') || 0;
    const completionTokens = c.get('completion_tokens') || 0;

    try {
      recordMetric(
        requestId,
        tenantId,
        provider || 'unknown',
        model || 'unknown',
        duration,
        status,
        {
          prompt_tokens: promptTokens,
          completion_tokens: completionTokens,
          total_tokens: promptTokens + completionTokens,
        },
        c.get('key_hash'),
        c.get('key_metadata')
      );
    } catch (err) {
      writeLog('warn', 'Failed to record metric', {
        request_id: requestId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

