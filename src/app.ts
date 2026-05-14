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
import { writeLog } from './utils/logger';
import { getProviderNames } from './providers';
import { getCacheStats } from './services/cache';
import { getSessionStats } from './services/history';

/**
 * 创建 Hono 应用实例
 * 路由注册顺序利用 Hono 中间件作用域实现：
 *   - 公共路由（/health, /, /metrics）直接在 app 上注册，不受 auth/ratelimit 影响
 *   - 受保护路由通过 Hono sub-app 分组，统一应用 auth + ratelimit 中间件
 *   - 全局中间件（cors, logger, metrics）仍然作用于所有路由
 */
export function createApp(): Hono {
  const app = new Hono();
  const protectedApi = new Hono();

  // ===== 全局中间件（作用于所有路由，包括 sub-app） =====
  app.use('*', cors());
  app.use('*', loggerMiddleware);
  app.use('*', metricsMiddleware);

  // ===== 公共路由（不受 auth / ratelimit 影响） =====
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

  app.get('/metrics', metricsHandler);

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

  // ===== 受保护路由（需要 auth + ratelimit） =====
  protectedApi.use('*', authMiddleware);
  protectedApi.use('*', rateLimitMiddleware);

  // 管理 API 权限中间件（需要 admin API Key）
  protectedApi.use('/v1/tenants*', requireAdmin);
  protectedApi.use('/v1/config*', requireAdmin);
  protectedApi.use('/v1/plugins*', requireAdmin);
  protectedApi.use('/v1/usage*', requireAdmin);
  protectedApi.use('/v1/quota*', requireAdmin);
  protectedApi.use('/v1/cache*', requireAdmin);
  protectedApi.use('/v1/ws/*', requireAdmin);

  // 注册路由处理器
  protectedApi.route('/', chatRouter);
  protectedApi.route('/', embedRouter);
  protectedApi.route('/', modelRouter);
  protectedApi.route('/', adminRouter);

  // 挂载受保护路由到主应用
  app.route('/', protectedApi);

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

  return app;
}

export default createApp;
