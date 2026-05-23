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
import {
  listTemplates,
  getTemplate,
  createTemplate,
  updateTemplate,
  deleteTemplate,
  renderTemplate,
  parseTemplate,
} from '../services/prompt';
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
  findTenantApiKeyByHash,
  updateTenantApiKeyPolicy,
} from '../services/tenant';
import { getWebSocketStats, cleanWebSocketConnections } from '../middleware/websocket';
import {
  listAlertRules,
  addAlertRule,
  removeAlertRule,
  setAlertEnabled,
  evaluateAlerts,
} from '../services/alert';
import {
  listPlugins,
  registerPlugin,
  unregisterPlugin,
  setPluginEnabled,
} from '../plugins';
import { loadPluginInSandbox } from '../plugins/loader';
import { configUpdateSchema, tenantConfigSchema, tenantUpdateSchema, createApiKeySchema, updateKeyPolicySchema } from '../validation';
import { requireAdmin } from '../middleware/auth';
import { auditAdmin } from '../utils/audit';
import { getKeyUsage } from '../services/metrics';

const adminRouter = new Hono();
adminRouter.use('*', requireAdmin);

// === 认证验证（用于前端登录校验）===
adminRouter.get('/v1/auth/verify', (c: Context) => {
  const apiKeyMeta = c.get('api_key_meta');
  return c.json({
    valid: true,
    is_admin: apiKeyMeta?.is_admin || false,
    tenant_id: apiKeyMeta?.tenant_id || 'default',
  });
});

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

adminRouter.get('/v1/prompts/:id', (c: Context) => {
  const id = c.req.param('id') || '';
  if (!id) {
    return c.json({ error: { message: 'Template id is required', type: 'invalid_request_error', code: 'invalid_request' } }, 400);
  }
  const template = getTemplate(id);
  if (!template) {
    return c.json({ error: { message: `Template not found: ${id}`, type: 'invalid_request_error', code: 'not_found' } }, 404);
  }
  return c.json(template);
});

adminRouter.post('/v1/prompts', async (c: Context) => {
  const body = await c.req.json();
  if (!body.id || !body.name || !body.template) {
    return c.json({
      error: { message: 'Missing required fields: id, name, template', type: 'invalid_request_error', code: 'invalid_request' },
    }, 400);
  }

  const variables = body.variables || parseTemplate(body.template);
  const template = createTemplate({
    id: body.id,
    name: body.name,
    description: body.description || '',
    template: body.template,
    variables,
    default_values: body.default_values || {},
  });

  return c.json(template, 201);
});

adminRouter.put('/v1/prompts/:id', async (c: Context) => {
  const id = c.req.param('id') || '';
  if (!id) {
    return c.json({ error: { message: 'Template id is required', type: 'invalid_request_error', code: 'invalid_request' } }, 400);
  }

  const body = await c.req.json();
  const updates: Parameters<typeof updateTemplate>[1] = {};
  if (body.name !== undefined) updates.name = body.name;
  if (body.description !== undefined) updates.description = body.description;
  if (body.template !== undefined) {
    updates.template = body.template;
    if (body.variables === undefined) {
      updates.variables = parseTemplate(body.template);
    }
  }
  if (body.variables !== undefined) updates.variables = body.variables;
  if (body.default_values !== undefined) updates.default_values = body.default_values;

  const updated = updateTemplate(id, updates);
  if (!updated) {
    return c.json({ error: { message: `Template not found: ${id}`, type: 'invalid_request_error', code: 'not_found' } }, 404);
  }
  return c.json(updated);
});

adminRouter.delete('/v1/prompts/:id', (c: Context) => {
  const id = c.req.param('id') || '';
  if (!id) {
    return c.json({ error: { message: 'Template id is required', type: 'invalid_request_error', code: 'invalid_request' } }, 400);
  }
  const removed = deleteTemplate(id);
  if (!removed) {
    return c.json({ error: { message: `Template not found: ${id}`, type: 'invalid_request_error', code: 'not_found' } }, 404);
  }
  return c.json({ deleted: true, id });
});

adminRouter.post('/v1/prompts/:id/render', async (c: Context) => {
  const id = c.req.param('id') || '';
  if (!id) {
    return c.json({ error: { message: 'Template id is required', type: 'invalid_request_error', code: 'invalid_request' } }, 400);
  }

  const body = await c.req.json().catch(() => ({}));
  const rendered = renderTemplate(id, body.variables || {});
  if (rendered === null) {
    return c.json({ error: { message: `Template not found: ${id}`, type: 'invalid_request_error', code: 'not_found' } }, 404);
  }
  return c.json({ rendered });
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
  const { name, expires_at, allowed_models, rate_limit_qps, rate_limit_burst, monthly_budget, max_tokens_per_request, metadata } = parsed.data;
  const key = createTenantApiKey(tenantId, name, expires_at, {
    allowed_models,
    rate_limit_qps,
    rate_limit_burst,
    monthly_budget,
    max_tokens_per_request,
    metadata,
  });
  if (!key) {
    return c.json({ error: { message: 'Failed to create API key', type: 'invalid_request_error' } }, 400);
  }
  auditAdmin({
    tenantId,
    ruleId: 'admin.key_created',
    action: 'allow',
    metadata: { key_name: key.name },
    severity: 'low',
  });
  return c.json(key, 201);
});

adminRouter.delete('/v1/keys/:key', (c: Context) => {
  const key = c.req.param('key')!;
  const deleted = deleteTenantApiKey(key);
  if (!deleted) {
    return c.json({ error: { message: 'API key not found', type: 'invalid_request_error' } }, 404);
  }
  auditAdmin({
    ruleId: 'admin.key_deleted',
    action: 'allow',
    metadata: { key_id: key },
    severity: 'low',
  });
  return c.json({ deleted: true });
});

// 更新 API Key 策略（通过哈希值定位）
adminRouter.put('/v1/tenants/:id/keys/:keyHash', async (c: Context) => {
  const keyHash = c.req.param('keyHash')!;
  const parsed = updateKeyPolicySchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({
      error: {
        message: parsed.error.errors[0]?.message || 'Invalid key policy',
        type: 'invalid_request_error',
        code: 'invalid_request',
      },
    }, 400);
  }
  const updated = updateTenantApiKeyPolicy(keyHash, parsed.data);
  if (!updated) {
    return c.json({ error: { message: 'API key not found', type: 'invalid_request_error', code: 'not_found' } }, 404);
  }
  return c.json(updated);
});

// 获取 API Key 的使用统计
adminRouter.get('/v1/tenants/:id/keys/:keyHash/usage', (c: Context) => {
  const keyHash = c.req.param('keyHash')!;
  const keyMeta = findTenantApiKeyByHash(keyHash);
  if (!keyMeta) {
    return c.json({ error: { message: 'API key not found', type: 'invalid_request_error', code: 'not_found' } }, 404);
  }
  const usage = getKeyUsage(keyHash);
  return c.json({ key: keyMeta, usage });
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
    auth: { enabled: config.auth.enabled, api_key_count: config.auth.api_keys?.length || 0 },
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
  auditAdmin({
    ruleId: 'admin.config_updated',
    action: 'allow',
    metadata: { updated_fields: Object.keys(parsed.data) },
    severity: 'medium',
  });
  return c.json({ updated: true });
});

// 模型别名管理
adminRouter.get('/v1/config/aliases', (c: Context) => {
  const config = getConfig();
  return c.json({ aliases: config.model_aliases || {} });
});

adminRouter.put('/v1/config/aliases', async (c: Context) => {
  const body = await c.req.json();
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return c.json({
      error: { message: 'Invalid aliases format', type: 'invalid_request_error', code: 'invalid_request' },
    }, 400);
  }
  setConfig({ model_aliases: body as Record<string, string> });
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

// 注册插件（从代码字符串加载）
adminRouter.post('/v1/plugins/register', async (c: Context) => {
  const body = await c.req.json();
  if (typeof body.code !== 'string' || !body.code) {
    return c.json({
      error: {
        message: 'Plugin code is required',
        type: 'invalid_request_error',
        code: 'invalid_request',
      },
    }, 400);
  }

  const result = loadPluginInSandbox(body.code);
  if (!result.success || !result.plugin) {
    return c.json({
      error: {
        message: result.error || 'Failed to load plugin',
        type: 'invalid_request_error',
        code: 'plugin_load_failed',
      },
    }, 400);
  }

  registerPlugin(result.plugin);
  return c.json({ registered: true, plugin: result.plugin.config }, 201);
});

// 卸载插件
adminRouter.delete('/v1/plugins/:id', (c: Context) => {
  const id = c.req.param('id') || '';
  if (!id) {
    return c.json({
      error: {
        message: 'Plugin id is required',
        type: 'invalid_request_error',
        code: 'invalid_request',
      },
    }, 400);
  }
  const removed = unregisterPlugin(id);
  if (!removed) {
    return c.json({
      error: {
        message: `Plugin not found: ${id}`,
        type: 'invalid_request_error',
        code: 'plugin_not_found',
      },
    }, 404);
  }
  return c.json({ unregistered: true, id });
});

// 启用插件
adminRouter.post('/v1/plugins/:id/enable', (c: Context) => {
  const id = c.req.param('id') || '';
  if (!id) {
    return c.json({
      error: {
        message: 'Plugin id is required',
        type: 'invalid_request_error',
        code: 'invalid_request',
      },
    }, 400);
  }
  const ok = setPluginEnabled(id, true);
  if (!ok) {
    return c.json({
      error: {
        message: `Plugin not found: ${id}`,
        type: 'invalid_request_error',
        code: 'plugin_not_found',
      },
    }, 404);
  }
  return c.json({ enabled: true, id });
});

// 禁用插件
adminRouter.post('/v1/plugins/:id/disable', (c: Context) => {
  const id = c.req.param('id') || '';
  if (!id) {
    return c.json({
      error: {
        message: 'Plugin id is required',
        type: 'invalid_request_error',
        code: 'invalid_request',
      },
    }, 400);
  }
  const ok = setPluginEnabled(id, false);
  if (!ok) {
    return c.json({
      error: {
        message: `Plugin not found: ${id}`,
        type: 'invalid_request_error',
        code: 'plugin_not_found',
      },
    }, 404);
  }
  return c.json({ disabled: true, id });
});

// === 告警规则 ===
adminRouter.get('/v1/alerts', (c: Context) => {
  return c.json({ rules: listAlertRules() });
});

adminRouter.post('/v1/alerts', async (c: Context) => {
  const body = await c.req.json();
  if (!body.id || !body.name || !body.metric || body.threshold === undefined || !body.webhook_url) {
    return c.json({
      error: {
        message: 'Missing required fields: id, name, metric, threshold, webhook_url',
        type: 'invalid_request_error',
        code: 'invalid_request',
      },
    }, 400);
  }

  addAlertRule({
    id: body.id,
    name: body.name,
    metric: body.metric,
    threshold: body.threshold,
    condition: body.condition || 'gt',
    webhook_url: body.webhook_url,
    enabled: body.enabled !== false,
    cooldown_seconds: body.cooldown_seconds || 300,
  });

  return c.json({ created: true }, 201);
});

adminRouter.delete('/v1/alerts/:id', (c: Context) => {
  const id = c.req.param('id') || '';
  if (!id) {
    return c.json({
      error: { message: 'Alert id is required', type: 'invalid_request_error', code: 'invalid_request' },
    }, 400);
  }
  const removed = removeAlertRule(id);
  if (!removed) {
    return c.json({
      error: { message: `Alert rule not found: ${id}`, type: 'invalid_request_error', code: 'not_found' },
    }, 404);
  }
  return c.json({ removed: true, id });
});

adminRouter.post('/v1/alerts/:id/enable', (c: Context) => {
  const id = c.req.param('id') || '';
  if (!id) {
    return c.json({
      error: { message: 'Alert id is required', type: 'invalid_request_error', code: 'invalid_request' },
    }, 400);
  }
  const ok = setAlertEnabled(id, true);
  if (!ok) {
    return c.json({
      error: { message: `Alert rule not found: ${id}`, type: 'invalid_request_error', code: 'not_found' },
    }, 404);
  }
  return c.json({ enabled: true, id });
});

adminRouter.post('/v1/alerts/:id/disable', (c: Context) => {
  const id = c.req.param('id') || '';
  if (!id) {
    return c.json({
      error: { message: 'Alert id is required', type: 'invalid_request_error', code: 'invalid_request' },
    }, 400);
  }
  const ok = setAlertEnabled(id, false);
  if (!ok) {
    return c.json({
      error: { message: `Alert rule not found: ${id}`, type: 'invalid_request_error', code: 'not_found' },
    }, 404);
  }
  return c.json({ disabled: true, id });
});

adminRouter.post('/v1/alerts/evaluate', (c: Context) => {
  evaluateAlerts();
  return c.json({ evaluated: true });
});

export default adminRouter;
