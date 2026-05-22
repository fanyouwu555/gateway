/**
 * AI Gateway 应用配置
 * 纯 Hono 应用工厂，不涉及 HTTP 服务器生命周期
 * 可被测试和 server 模块共用
 */
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { loggerMiddleware } from './middleware/logger';
import { authMiddleware } from './middleware/auth';
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
import { getConfig } from './config';
import { failoverManager } from './services/failover';

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
  const corsOrigin = process.env.CORS_ORIGIN;
  app.use('*', cors({
    origin: corsOrigin || '*',
    allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization', 'x-api-key'],
  }));
  app.use('*', loggerMiddleware);
  app.use('*', metricsMiddleware);

  // ===== 公共路由（不受 auth / ratelimit 影响） =====
  // WebSocket 升级认证端点 - 用于在升级前验证 API Key
  app.get('/v1/ws', authMiddleware, (c) => {
    // 认证通过，在 header 中返回 tenant_id 供 index.ts 使用
    c.header('x-tenant-id', c.get('tenant_id') || 'default');
    return c.json({ authenticated: true });
  });

  app.get('/health', (c) => {
    const providers = getProviderNames();
    const cacheStats = getCacheStats();
    const sessionStats = getSessionStats();
    const config = getConfig();
    const providerHealth = failoverManager.getProviderHealthStatus();

    return c.json({
      status: 'ok',
      timestamp: Date.now(),
      uptime: process.uptime(),
      version: '1.0.0',
      services: {
        providers: providers.map((p) => ({
          name: p,
          status: providerHealth[p]?.isHealthy !== false ? 'active' : 'degraded',
          has_api_key: !!config.providers[p]?.api_key,
          base_url: config.providers[p]?.base_url,
          health: providerHealth[p] || { isHealthy: true, totalRequests: 0, errorRate: 0, avgLatencyMs: 0 },
        })),
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
