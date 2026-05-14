/**
 * AI Gateway 应用配置
 * 纯 Hono 应用工厂，不涉及 HTTP 服务器生命周期
 * 可被测试和 server 模块共用
 */
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { loggerMiddleware } from './middleware/logger';
import { authMiddleware, requireAdmin } from './middleware/auth';
import { rateLimitMiddleware } from './middleware/ratelimit';
import { metricsMiddleware, metricsHandler } from './middleware/metrics';
import chatRouter from './routes/chat';
import embedRouter from './routes/embed';
import modelRouter from './routes/model';
import adminRouter from './routes/admin';
import { GatewayError } from './middleware/error';
import { writeLog } from './middleware/logger';
import { getProviderNames } from './providers';
import { getCacheStats } from './services/cache';
import { getSessionStats } from './services/history';

/**
 * 创建 Hono 应用实例
 */
export function createApp(): Hono {
  const app = new Hono();

  // ===== 全局中间件 =====
  app.use('*', cors());
  app.use('*', loggerMiddleware);
  app.use('*', metricsMiddleware);

  // 认证中间件（排除健康检查）
  app.use('*', async (c, next) => {
    if (c.req.path === '/health' || c.req.path === '/') {
      await next();
    } else {
      await authMiddleware(c, next);
    }
  });

  // 限流中间件（排除健康检查）
  app.use('*', async (c, next) => {
    if (c.req.path === '/health' || c.req.path === '/') {
      await next();
    } else {
      await rateLimitMiddleware(c, next);
    }
  });

  // 管理 API 权限中间件（需要 admin API Key）
  app.use('/v1/tenants*', requireAdmin);
  app.use('/v1/config*', requireAdmin);
  app.use('/v1/plugins*', requireAdmin);
  app.use('/v1/usage*', requireAdmin);
  app.use('/v1/quota*', requireAdmin);
  app.use('/v1/cache*', requireAdmin);
  app.use('/v1/ws/*', requireAdmin);

  // ===== 路由 =====
  app.route('/', chatRouter);
  app.route('/', embedRouter);
  app.route('/', modelRouter);

  // ===== 全局错误处理 =====
  app.onError((err, c) => {
    const requestId = c.get('request_id') || 'unknown';

    if (err instanceof GatewayError) {
      writeLog('error', `Gateway error: ${err.errorType}`, {
        request_id: requestId,
        status: err.statusCode,
        code: err.code,
      });
      return c.json(err.toResponse(), err.statusCode as 400);
    }

    // 未知错误
    writeLog('error', 'Internal error', {
      request_id: requestId,
      status: 500,
      error: err.message,
    });
    return c.json(
      { error: { message: 'An internal error occurred', type: 'internal_error', code: 'internal_error' } },
      500
    );
  });

  // ===== 404 处理 =====
  app.notFound((c) =>
    c.json(
      {
        error: {
          message: `Route not found: ${c.req.method} ${c.req.path}`,
          type: 'invalid_request_error',
          code: 'not_found',
        },
      },
      404
    )
  );

  // ===== 健康检查 =====
  app.get('/health', (c) => {
    const providers = getProviderNames();
    const cacheStats = getCacheStats();
    const sessionStats = getSessionStats();

    return c.json({
      status: 'ok',
      timestamp: Date.now(),
      uptime: process.uptime(),
      version: '1.0.0',
      services: {
        providers: providers.map((p) => ({ name: p, status: 'active' })),
        cache: { size: cacheStats.size, hit_rate: cacheStats.hit_rate },
        sessions: { total: sessionStats.total_sessions },
      },
    });
  });

  // ===== Prometheus 指标端点 =====
  app.get('/metrics', metricsHandler);

  // ===== 根路径 =====
  app.get('/', (c) => {
    return c.json({
      name: 'AI Gateway',
      version: '1.0.0',
      endpoints: {
        health: '/health',
        chat: '/v1/chat/completions',
        embed: '/v1/embeddings',
        models: '/v1/models',
      },
    });
  });

  // ===== 管理 API 路由（最后注册，避免覆盖前面的路由） =====
  app.route('/', adminRouter);

  return app;
}

export default createApp;
