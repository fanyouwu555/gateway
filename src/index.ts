/**
 * AI Gateway 入口文件
 */
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import './types/context'; // 类型扩展
import { loggerMiddleware } from './middleware/logger';
import { authMiddleware } from './middleware/auth';
import { rateLimitMiddleware } from './middleware/ratelimit';
import chatRouter from './routes/chat';
import embedRouter from './routes/embed';
import modelRouter from './routes/model';
import { getConfig } from './config';
import { initProviders } from './providers/registry';
import { getTenantUsage } from './services/metrics';
import { getQuotaStatus } from './services/quota';
import { getCacheStats, cleanCache } from './services/cache';
import { getSessionStats, cleanSessions } from './services/history';
import { listTemplates } from './services/prompt';
import { getRouterStatus } from './services/router';
import {
  listTenants,
  getTenant,
  createTenant,
  getTenantStats,
  getTenantApiKeys,
  createTenantApiKey,
  deleteTenantApiKey,
  type TenantConfig,
} from './services/tenant';
import { getWebSocketStats, cleanWebSocketConnections } from './middleware/websocket';
import { listPlugins, createSensitiveWordFilterPlugin, registerPlugin } from './plugins';
import { GatewayError } from './middleware/error';
import { getProviderNames } from './providers';

// 创建Hono应用
const app = new Hono();

// 全局中间件
app.use('*', cors());
app.use('*', loggerMiddleware);

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

// 路由
app.route('/', chatRouter);
app.route('/', embedRouter);
app.route('/', modelRouter);

// 全局错误处理
app.onError((err, c) => {
  const requestId = c.get('request_id') || 'unknown';

  if (err instanceof GatewayError) {
    console.error(`[Error] ${err.errorType} | request_id=${requestId} | status=${err.statusCode}`, {
      message: err.message,
      code: err.code,
    });
    return c.json(err.toResponse(), err.statusCode as 400);
  }

  // 未知错误
  console.error(`[Error] internal_error | request_id=${requestId} | status=500`, {
    message: err.message,
  });
  return c.json(
    { error: { message: 'An internal error occurred', type: 'internal_error', code: 'internal_error' } },
    500
  );
});

// 404处理
app.notFound((c) =>
  c.json(
    { error: { message: `Route not found: ${c.req.method} ${c.req.path}`, type: 'invalid_request_error', code: 'not_found' } },
    404
  )
);

// 健康检查 - 增强版
app.get('/health', (c) => {
  const providers = getProviderNames();
  const cacheStats = getCacheStats();
  const sessionStats = getSessionStats();

  // 简单的服务状态检查
  const services = {
    providers: providers.map((p) => ({ name: p, status: 'active' })),
    cache: { size: cacheStats.size, status: 'ok' },
    sessions: { total: sessionStats.total_sessions, status: 'ok' },
  };

  // 如果任何服务不健康，返回 503
  const allHealthy = services.providers.length > 0;

  return c.json(
    {
      status: allHealthy ? 'ok' : 'degraded',
      timestamp: Date.now(),
      uptime: process.uptime ? Math.floor(process.uptime()) : 0,
      version: '1.0.0',
      services,
    },
    allHealthy ? 200 : 503
  );
});

// 根路由
app.get('/', (c) => {
  return c.json({
    name: 'AI Gateway',
    version: '1.0.0',
    endpoints: {
      chat: '/v1/chat/completions',
      embed: '/v1/embeddings',
      models: '/v1/models',
    },
  });
});

// 用量统计 API
app.get('/v1/stats', (c) => {
  const tenantId = c.get('tenant_id') ?? 'default';
  const usage = getTenantUsage(tenantId as string);

  return c.json({
    tenant_id: tenantId,
    total_requests: usage.total_requests,
    total_tokens: usage.total_tokens,
    total_cost: usage.total_cost,
    avg_duration_ms: usage.avg_duration_ms,
  });
});

// 配额状态 API
app.get('/v1/quota', (c) => {
  const tenantId = c.get('tenant_id') ?? 'default';
  const status = getQuotaStatus(tenantId as string);

  return c.json(status);
});

// 缓存统计 API
app.get('/v1/cache', (c) => {
  return c.json(getCacheStats());
});

// 清理缓存 API
app.post('/v1/cache/clean', (c) => {
  const cleaned = cleanCache();
  return c.json({ cleaned });
});

// 会话统计 API
app.get('/v1/sessions', (c) => {
  return c.json(getSessionStats());
});

// 清理会话 API
app.post('/v1/sessions/clean', (c) => {
  const cleaned = cleanSessions();
  return c.json({ cleaned });
});

// Prompt模板列表 API
app.get('/v1/templates', (c) => {
  const templates = listTemplates();
  return c.json({ templates });
});

// 路由器状态 API
app.get('/v1/router', (c) => {
  return c.json(getRouterStatus());
});

// 租户管理 API
app.get('/v1/tenants', (c) => {
  const tenants = listTenants();
  return c.json({ tenants });
});

app.get('/v1/tenants/:id', (c) => {
  const tenantId = c.req.param('id');
  const tenant = getTenant(tenantId);
  if (!tenant) {
    return c.json({ error: { message: 'Tenant not found', type: 'invalid_request_error' } }, 404);
  }
  return c.json(tenant);
});

app.post('/v1/tenants', async (c) => {
  const body = await c.req.json() as Omit<TenantConfig, 'tenant_id' | 'created_at' | 'updated_at'>;
  const tenant = createTenant(body);
  return c.json(tenant, 201);
});

app.get('/v1/tenants/:id/stats', (c) => {
  const tenantId = c.req.param('id');
  const stats = getTenantStats(tenantId);
  if (!stats) {
    return c.json({ error: { message: 'Tenant not found', type: 'invalid_request_error' } }, 404);
  }
  return c.json(stats);
});

app.get('/v1/tenants/:id/keys', (c) => {
  const tenantId = c.req.param('id');
  const keys = getTenantApiKeys(tenantId);
  return c.json({ keys });
});

app.post('/v1/tenants/:id/keys', async (c) => {
  const tenantId = c.req.param('id');
  const body = await c.req.json() as { name: string; expires_at?: number };
  const key = createTenantApiKey(tenantId, body.name, body.expires_at);
  if (!key) {
    return c.json({ error: { message: 'Failed to create API key', type: 'invalid_request_error' } }, 400);
  }
  return c.json(key, 201);
});

app.delete('/v1/keys/:key', (c) => {
  const key = c.req.param('key');
  const deleted = deleteTenantApiKey(key);
  if (!deleted) {
    return c.json({ error: { message: 'API key not found', type: 'invalid_request_error' } }, 404);
  }
  return c.json({ deleted: true });
});

// WebSocket 统计 API
app.get('/v1/ws', (c) => {
  return c.json(getWebSocketStats());
});

app.post('/v1/ws/clean', (c) => {
  const cleaned = cleanWebSocketConnections();
  return c.json({ cleaned });
});

// 插件 API
app.get('/v1/plugins', (c) => {
  return c.json({ plugins: listPlugins() });
});

// 初始化
async function startServer() {
  // 初始化Providers
  initProviders();

  // 注册内置插件
  const sensitiveFilter = createSensitiveWordFilterPlugin(['xxx', 'test-bad-word']);
  registerPlugin(sensitiveFilter);

  // 获取配置
  const config = getConfig();

  console.log(`
╔═══════════════════════════════════════════════════╗
║           AI Gateway Server                       ║
║                                                  ║
║   Port: ${config.port}                               ║
║   Host: ${config.host}                               ║
║   Log:  ${config.log_level}                             ║
║   Auth: ${config.auth.enabled ? 'enabled' : 'disabled'}                          ║
╚═══════════════════════════════════════════════════╝
  `);

  // 启动服务器
  // 注意: 生产环境应使用 node HTTP服务器或容器化部署
  // 这里为了开发方便使用 Hono 的 serve
  const { serve } = await import('@hono/node-server');
  serve({
    fetch: app.fetch,
    port: config.port,
    hostname: config.host,
  });
}

startServer().catch(console.error);

export default app;