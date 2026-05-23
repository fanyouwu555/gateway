/**
 * Tracing 中间件
 * 解析 traceparent header，创建 Root Span，存入 Hono Context
 */
import type { Context, Next } from 'hono';
import { createRootSpan, endSpan, parseTraceParent } from '../utils/tracing';
import type { Span } from '@opentelemetry/api';

/**
 * Tracing 中间件
 * 在请求开始时创建 Root Span，在请求结束时结束 Span
 */
export async function tracingMiddleware(c: Context, next: Next): Promise<void> {
  const traceParentHeader = c.req.header('traceparent');
  const parentContext = traceParentHeader ? parseTraceParent(traceParentHeader) : undefined;

  const span = createRootSpan(`${c.req.method} ${c.req.path}`, parentContext);
  if (span) {
    c.set('span', span);
    span.setAttribute('http.method', c.req.method);
    span.setAttribute('http.path', c.req.path);
  }

  try {
    await next();
  } finally {
    if (span) {
      span.setAttribute('http.status_code', c.res.status);
      endSpan(span);
    }
  }
}

/**
 * 从 Context 获取当前 Span
 */
export function getSpan(c: Context): Span | undefined {
  return c.get('span') as Span | undefined;
}
