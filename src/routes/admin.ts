/**
 * Admin API 路由
 * 管理 API：用量、配额、缓存、会话、租户、配置等
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import { getConfig, setConfig } from '../config';
import {
  getTenantUsage,
  getUsageByTimeRange,
  getTimeSeriesMetrics,
  getProviderStats,
  getAllTenantsStats,
  getDashboardOverview,
  getStatusCodeStats,
  type AggregationGranularity,
} from '../services/metrics';
import { getQuotaStatus } from '../services/quota';
import { getCacheStats, cleanCache } from '../services/cache';
import { getSessionStats, cleanSessions } from '../services/history';
import { listTemplates } from '../services/prompt';
import { getRouterStatus } from '../services/router';
import {
  listTenants,
  getTenant,
  createTenant,
  updateTenant,
  deleteTenant,
  getTenantStats,
  getTenantApiKeys,
  createTenantApiKey,
  deleteTenantApiKey,
} from '../services/tenant';
import { getWebSocketStats, cleanWebSocketConnections } from '../middleware/websocket';
import { listPlugins } from '../plugins';
import { configUpdateSchema, tenantConfigSchema, tenantUpdateSchema, createApiKeySchema } from '../validation';

const adminRouter = new Hono();

// === 用量统计 ===
adminRouter.get('/v1/usage', (c: Context) => {
  const tenantId = c.req.query('tenant_id') || 'default';
  const usage = getTenantUsage(tenantId);
  return c.json(usage);
});

// 时间范围内的用量统计
adminRouter.get('/v1/usage/range', (c: Context) => {
  const startQuery = c.req.query('start');
  const endQuery = c.req.query('end');

  const end = endQuery ? parseInt(endQuery, 10) : Date.now();
  const start = startQuery ? parseInt(startQuery, 10) : end - 24 * 60 * 60 * 1000; // 默认过去 24 小时

  const usage = getUsageByTimeRange(start, end);
  return c.json(usage);
});

// 时间序列统计（支持按小时/天/周/月聚合）
adminRouter.get('/v1/usage/timeseries', (c: Context) => {
  const startQuery = c.req.query('start');
  const endQuery = c.req.query('end');
  const granularity = c.req.query('granularity') || 'hour';

  const end = endQuery ? parseInt(endQuery, 10) : Date.now();
  const start = startQuery ? parseInt(startQuery, 10) : end - 24 * 60 * 60 * 1000;

  const series = getTimeSeriesMetrics(start, end, granularity as AggregationGranularity);
  return c.json(series);
});

// Dashboard 概览统计
adminRouter.get('/v1/usage/overview', (c: Context) => {
  const startQuery = c.req.query('start');
  const endQuery = c.req.query('end');

  const end = endQuery ? parseInt(endQuery, 10) : Date.now();
  const start = startQuery ? parseInt(startQuery, 10) : end - 24 * 60 * 60 * 1000;

  const overview = getDashboardOverview(start, end);
  return c.json(overview);
});

// Provider 维度统计
adminRouter.get('/v1/usage/providers', (c: Context) => {
  const startQuery = c.req.query('start');
  const endQuery = c.req.query('end');

  const end = endQuery ? parseInt(endQuery, 10) : Date.now();
  const start = startQuery ? parseInt(startQuery, 10) : end - 24 * 60 * 60 * 1000;

  const stats = getProviderStats(start, end);
  return c.json(stats);
});

// 所有租户统计
adminRouter.get('/v1/usage/tenants', (c: Context) => {
  const startQuery = c.req.query('start');
  const endQuery = c.req.query('end');

  const end = endQuery ? parseInt(endQuery, 10) : Date.now();
  const start = startQuery ? parseInt(startQuery, 10) : end - 24 * 60 * 60 * 1000;

  const stats = getAllTenantsStats(start, end);
  return c.json(stats);
});

// 状态码分布统计
adminRouter.get('/v1/usage/status-codes', (c: Context) => {
  const startQuery = c.req.query('start');
  const endQuery = c.req.query('end');

  const end = endQuery ? parseInt(endQuery, 10) : Date.now();
  const start = startQuery ? parseInt(startQuery, 10) : end - 24 * 60 * 60 * 1000;

  const stats = getStatusCodeStats(start, end);
  return c.json(stats);
});

// === 配额状态 ===
adminRouter.get('/v1/quota', (c: Context) => {
  const status = getQuotaStatus('default');
  return c.json(status);
});

// === 缓存管理 ===
adminRouter.get('/v1/cache', (c: Context) => {
  const stats = getCacheStats();
  return c.json(stats);
});

adminRouter.post('/v1/cache/clean', (c: Context) => {
  cleanCache();
  return c.json({ cleaned: true });
});

// === 会话管理 ===
adminRouter.get('/v1/sessions', (c: Context) => {
  const stats = getSessionStats();
  return c.json(stats);
});

adminRouter.post('/v1/sessions/clean', (c: Context) => {
  const cleaned = cleanSessions();
  return c.json({ cleaned });
});

// === 路由状态 ===
adminRouter.get('/v1/router/status', (c: Context) => {
  const status = getRouterStatus();
  return c.json(status);
});

// === 提示词模板 ===
adminRouter.get('/v1/prompts', (c: Context) => {
  const templates = listTemplates();
  return c.json({ templates });
});

// === 租户管理 ===
adminRouter.get('/v1/tenants', (c: Context) => {
  const tenants = listTenants();
  return c.json({ tenants });
});

adminRouter.post('/v1/tenants', async (c: Context) => {
  const parsed = tenantConfigSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({
      error: {
        message: parsed.error.errors[0]?.message || 'Invalid tenant config',
        type: 'invalid_request_error',
        code: 'invalid_request',
      },
    }, 400);
  }
  const tenant = createTenant(parsed.data);
  if (!tenant) {
    return c.json({ error: { message: 'Failed to create tenant', type: 'invalid_request_error' } }, 400);
  }
  return c.json(tenant, 201);
});

adminRouter.get('/v1/tenants/:id', (c: Context) => {
  const id = c.req.param('id')!;
  const tenant = getTenant(id);
  if (!tenant) {
    return c.json({ error: { message: 'Tenant not found', type: 'invalid_request_error' } }, 404);
  }
  return c.json(tenant);
});

adminRouter.get('/v1/tenants/:id/stats', (c: Context) => {
  const id = c.req.param('id')!;
  const stats = getTenantStats(id);
  return c.json(stats);
});

adminRouter.get('/v1/tenants/:id/keys', (c: Context) => {
  const id = c.req.param('id')!;
  const keys = getTenantApiKeys(id);
  return c.json({ keys });
});

adminRouter.post('/v1/tenants/:id/keys', async (c: Context) => {
  const tenantId = c.req.param('id')!;
  const parsed = createApiKeySchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({
      error: {
        message: parsed.error.errors[0]?.message || 'Invalid API key config',
        type: 'invalid_request_error',
        code: 'invalid_request',
      },
    }, 400);
  }
  const key = createTenantApiKey(tenantId, parsed.data.name, parsed.data.expires_at);
  if (!key) {
    return c.json({ error: { message: 'Failed to create API key', type: 'invalid_request_error' } }, 400);
  }
  return c.json(key, 201);
});

adminRouter.delete('/v1/keys/:key', (c: Context) => {
  const key = c.req.param('key')!;
  const deleted = deleteTenantApiKey(key);
  if (!deleted) {
    return c.json({ error: { message: 'API key not found', type: 'invalid_request_error' } }, 404);
  }
  return c.json({ deleted: true });
});

adminRouter.put('/v1/tenants/:id', async (c: Context) => {
  const id = c.req.param('id')!;
  const parsed = tenantUpdateSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({
      error: {
        message: parsed.error.errors[0]?.message || 'Invalid tenant update',
        type: 'invalid_request_error',
        code: 'invalid_request',
      },
    }, 400);
  }
  const tenant = updateTenant(id, parsed.data);
  if (!tenant) {
    return c.json({ error: { message: 'Tenant not found', type: 'invalid_request_error' } }, 404);
  }
  return c.json(tenant);
});

adminRouter.delete('/v1/tenants/:id', (c: Context) => {
  const id = c.req.param('id')!;
  const deleted = deleteTenant(id);
  if (!deleted) {
    return c.json({ error: { message: 'Cannot delete tenant', type: 'invalid_request_error' } }, 400);
  }
  return c.json({ deleted: true });
});

// === 配置管理 ===
adminRouter.get('/v1/config', (c: Context) => {
  const config = getConfig();
  const safe = {
    port: config.port,
    host: config.host,
    log_level: config.log_level,
    routing: config.routing,
    auth: { enabled: config.auth.enabled, api_key_count: config.auth.api_keys.length },
    rate_limit: config.rate_limit,
    failover: config.failover,
    loadBalance: config.loadBalance,
    providers: Object.fromEntries(
      Object.entries(config.providers || {}).map(([k, v]) => [
        k,
        { provider: v.provider, base_url: v.base_url, timeout: v.timeout },
      ])
    ),
  };
  return c.json(safe);
});

adminRouter.put('/v1/config', async (c: Context) => {
  const parsed = configUpdateSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({
      error: {
        message: parsed.error.errors[0]?.message || 'Invalid config update',
        type: 'invalid_request_error',
        code: 'invalid_request',
      },
    }, 400);
  }
  setConfig(parsed.data);
  return c.json({ updated: true });
});

// === WebSocket 统计 ===
adminRouter.get('/v1/ws', (c: Context) => {
  return c.json(getWebSocketStats());
});

adminRouter.post('/v1/ws/clean', (c: Context) => {
  const cleaned = cleanWebSocketConnections();
  return c.json({ cleaned });
});

// === 插件列表 ===
adminRouter.get('/v1/plugins', (c: Context) => {
  return c.json({ plugins: listPlugins() });
});

export default adminRouter;
