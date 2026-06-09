/**
 * Admin API 路由
 * 管理 API：用量、配额、缓存、会话、租户、配置等
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import { getConfig, setConfig, getProviderConfig } from '../config';
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
import { getRequestLogStore } from '../services/request-log';
import { getConversationLogService } from '../services/conversation-log';
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
import { getProvider, getProviderNames } from '../providers';
import type { IModelInfo } from '../types';
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
import {
  configUpdateSchema, tenantConfigSchema, tenantUpdateSchema,
  createApiKeySchema, updateKeyPolicySchema,
  promptTemplateSchema, promptTemplateUpdateSchema,
  alertRuleSchema, pluginRegisterSchema, modelAliasesSchema,
} from '../validation';
import { requireAdmin } from '../middleware/auth';
import { auditAdmin } from '../utils/audit';
import { getKeyUsage } from '../services/metrics';
import { getPricingService } from '../services/pricing';
import type { IConversationFilter } from '../types';

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
  const tenantId = c.req.query('tenant_id') || 'default';
  const status = getQuotaStatus(tenantId);
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
  const parsed = promptTemplateSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({
      error: {
        message: parsed.error.errors[0]?.message || 'Invalid prompt template',
        type: 'invalid_request_error',
        code: 'invalid_request',
        param: parsed.error.errors[0]?.path?.join('.'),
      },
    }, 400);
  }

  const variables = parsed.data.variables || parseTemplate(parsed.data.template);
  const template = createTemplate({
    id: parsed.data.id,
    name: parsed.data.name,
    description: parsed.data.description,
    template: parsed.data.template,
    variables,
    default_values: parsed.data.default_values || {},
  });

  return c.json(template, 201);
});

adminRouter.put('/v1/prompts/:id', async (c: Context) => {
  const id = c.req.param('id') || '';
  if (!id) {
    return c.json({ error: { message: 'Template id is required', type: 'invalid_request_error', code: 'invalid_request' } }, 400);
  }

  const parsed = promptTemplateUpdateSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({
      error: {
        message: parsed.error.errors[0]?.message || 'Invalid template update',
        type: 'invalid_request_error',
        code: 'invalid_request',
        param: parsed.error.errors[0]?.path?.join('.'),
      },
    }, 400);
  }

  const updates: Parameters<typeof updateTemplate>[1] = { ...parsed.data };
  if (parsed.data.template !== undefined && parsed.data.variables === undefined) {
    updates.variables = parseTemplate(parsed.data.template);
  }

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
    return c.json({ error: { message: 'Failed to create tenant', type: 'invalid_request_error', code: 'create_failed' } }, 400);
  }
  return c.json(tenant, 201);
});

adminRouter.get('/v1/tenants/:id', (c: Context) => {
  const id = c.req.param('id')!;
  const tenant = getTenant(id);
  if (!tenant) {
    return c.json({ error: { message: 'Tenant not found', type: 'invalid_request_error', code: 'not_found' } }, 404);
  }
  return c.json(tenant);
});

adminRouter.get('/v1/tenants/:id/stats', (c: Context) => {
  const id = c.req.param('id')!;
  const tenant = getTenantStats(id);
  if (!tenant) {
    return c.json({ error: { message: 'Tenant not found', type: 'invalid_request_error', code: 'not_found' } }, 404);
  }
  // 获取该租户的使用统计（最近 30 天）
  const end = Date.now();
  const start = end - 30 * 24 * 60 * 60 * 1000;
  const allStats = getAllTenantsStats(start, end);
  const usage = allStats.find((t) => t.tenant_id === id);

  return c.json({
    ...tenant,
    total_requests: usage?.total_requests || 0,
    total_tokens: usage?.total_tokens || 0,
    total_cost: usage?.total_cost || 0,
    avg_duration_ms: usage?.avg_duration_ms || 0,
    success_rate: usage?.success_rate || 0,
    by_provider: usage?.by_provider || {},
    by_model: usage?.by_model || {},
  });
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
  const { name, expires_at, allowed_models, default_model, rate_limit_qps, rate_limit_burst, monthly_budget, max_tokens_per_request, metadata } = parsed.data;
  const key = createTenantApiKey(tenantId, name, expires_at, {
    allowed_models,
    default_model,
    rate_limit_qps,
    rate_limit_burst,
    monthly_budget,
    max_tokens_per_request,
    metadata,
  });
  if (!key) {
    return c.json({ error: { message: 'Failed to create API key', type: 'invalid_request_error', code: 'create_failed' } }, 400);
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
    return c.json({ error: { message: 'API key not found', type: 'invalid_request_error', code: 'not_found' } }, 404);
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
    return c.json({ error: { message: 'Tenant not found', type: 'invalid_request_error', code: 'not_found' } }, 404);
  }
  return c.json(tenant);
});

adminRouter.delete('/v1/tenants/:id', (c: Context) => {
  const id = c.req.param('id')!;
  const deleted = deleteTenant(id);
  if (!deleted) {
    return c.json({ error: { message: 'Cannot delete tenant', type: 'invalid_request_error', code: 'delete_failed' } }, 400);
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
  const parsed = modelAliasesSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({
      error: { message: 'Invalid aliases format', type: 'invalid_request_error', code: 'invalid_request' },
    }, 400);
  }
  setConfig({ model_aliases: parsed.data });
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
  const parsed = pluginRegisterSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({
      error: {
        message: parsed.error.errors[0]?.message || 'Invalid plugin registration',
        type: 'invalid_request_error',
        code: 'invalid_request',
      },
    }, 400);
  }

  const result = loadPluginInSandbox(parsed.data.code);
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
  const parsed = alertRuleSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({
      error: {
        message: parsed.error.errors[0]?.message || 'Invalid alert rule',
        type: 'invalid_request_error',
        code: 'invalid_request',
        param: parsed.error.errors[0]?.path?.join('.'),
      },
    }, 400);
  }

  addAlertRule({
    id: parsed.data.id,
    name: parsed.data.name,
    metric: parsed.data.metric,
    threshold: parsed.data.threshold,
    condition: parsed.data.condition,
    webhook_url: parsed.data.webhook_url,
    enabled: parsed.data.enabled,
    cooldown_seconds: parsed.data.cooldown_seconds,
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

// === 模型定价 ===
adminRouter.get('/v1/pricing', (c: Context) => {
  const prices = getPricingService().getAllPrices();
  const overrides = getPricingService().getOverrides();
  return c.json({ prices, overrides });
});

adminRouter.put('/v1/pricing/:model', async (c: Context) => {
  const model = c.req.param('model')!;
  let body: { input?: number; output?: number };
  try {
    body = await c.req.json();
  } catch {
    return c.json({
      error: { message: 'Invalid JSON body', type: 'invalid_request_error', code: 'parse_error' },
    }, 400);
  }
  const input = body.input;
  const output = body.output;
  if (typeof input !== 'number' || !Number.isFinite(input) || input < 0 ||
      typeof output !== 'number' || !Number.isFinite(output) || output < 0) {
    return c.json({
      error: { message: 'input and output must be non-negative numbers', type: 'invalid_request_error', code: 'validation_error' },
    }, 400);
  }
  getPricingService().setPrice(model, input, output);
  auditAdmin({
    ruleId: 'admin.pricing_set',
    action: 'allow',
    metadata: { model, input, output },
    severity: 'low',
  });
  return c.json({ model, input, output });
});

adminRouter.delete('/v1/pricing/:model', (c: Context) => {
  const model = c.req.param('model')!;
  const deleted = getPricingService().deletePrice(model);
  if (!deleted) {
    return c.json({
      error: { message: `No runtime override found for model: ${model}`, type: 'invalid_request_error', code: 'not_found' },
    }, 404);
  }
  auditAdmin({
    ruleId: 'admin.pricing_delete',
    action: 'allow',
    metadata: { model },
    severity: 'low',
  });
  return c.json({ deleted: true, model });
});

// === 请求日志 ===
adminRouter.get('/v1/request-logs', (c: Context) => {
  const store = getRequestLogStore();
  const start = c.req.query('start');
  const end = c.req.query('end');
  const tenantId = c.req.query('tenant_id');
  const model = c.req.query('model');
  const statusCode = c.req.query('status_code');
  const limit = c.req.query('limit');
  const offset = c.req.query('offset');
  const logs = store.getLogs({
    start: start ? parseInt(start, 10) : undefined,
    end: end ? parseInt(end, 10) : undefined,
    tenant_id: tenantId || undefined,
    model: model || undefined,
    status_code: statusCode ? parseInt(statusCode, 10) : undefined,
    limit: limit ? parseInt(limit, 10) : 50,
    offset: offset ? parseInt(offset, 10) : 0,
  });
  return c.json({ logs, total: store.getTotalCount() });
});

// ===== 会话管理 API（基于对话日志的统计视图） =====

/** GET /v1/sessions — 会话统计 */
adminRouter.get('/v1/sessions', async (c: Context) => {
  const service = getConversationLogService();
  const { sessions } = await service.listSessions({ limit: 10000 });
  const totalSessions = sessions.length;
  const totalMessages = sessions.reduce((sum, s) => sum + (s.turn_count || 0), 0);
  const byTenant: Record<string, number> = {};
  for (const s of sessions) {
    const tid = s.tenant_id || 'default';
    byTenant[tid] = (byTenant[tid] || 0) + 1;
  }
  return c.json({ total_sessions: totalSessions, total_messages: totalMessages, by_tenant: byTenant });
});

/** POST /v1/sessions/clean — 清理所有会话 */
adminRouter.post('/v1/sessions/clean', async (c: Context) => {
  const service = getConversationLogService();
  await service.clearAll();
  return c.json({ cleaned: true });
});

// ===== 会话日志管理 API =====

/** GET /v1/conversations — 列出会话 */
adminRouter.get('/v1/conversations', async (c: Context) => {
  const query = c.req.query();
  const parseNum = (v: string | undefined): number | undefined => {
    if (!v) return undefined;
    const n = parseInt(v, 10);
    return Number.isNaN(n) ? undefined : n;
  };

  const filter: IConversationFilter = {
    start: parseNum(query.start),
    end: parseNum(query.end),
    tenant_id: query.tenant_id || undefined,
    model: query.model || undefined,
    client: query.client || undefined,
    session_id: query.session_id || undefined,
    limit: parseNum(query.limit),
    offset: parseNum(query.offset),
  };

  const service = getConversationLogService();
  const result = await service.listSessions(filter);

  return c.json({
    sessions: result.sessions,
    total: result.total,
    limit: filter.limit ?? 50,
    offset: filter.offset ?? 0,
  }, 200);
});

/** GET /v1/conversations/:session_id — 获取会话完整轮次 */
adminRouter.get('/v1/conversations/:session_id', async (c: Context) => {
  const sessionId = c.req.param('session_id')!;
  const service = getConversationLogService();

  const [meta, turns] = await Promise.all([
    service.getSessionMeta(sessionId),
    service.getSessionTurns(sessionId),
  ]);

  if (!meta) {
    return c.json({ error: { message: 'Session not found', type: 'invalid_request_error', code: 'not_found' } }, 404);
  }

  return c.json({ session: meta, turns }, 200);
});

/** GET /v1/conversations/:session_id/stats — 获取会话统计 */
adminRouter.get('/v1/conversations/:session_id/stats', async (c: Context) => {
  const sessionId = c.req.param('session_id')!;
  const service = getConversationLogService();

  const meta = await service.getSessionMeta(sessionId);
  if (!meta) {
    return c.json({ error: { message: 'Session not found', type: 'not_found' } }, 404);
  }

  return c.json(meta, 200);
});

/** DELETE /v1/conversations/:session_id — 删除会话 */
adminRouter.delete('/v1/conversations/:session_id', async (c: Context) => {
  const sessionId = c.req.param('session_id')!;
  const service = getConversationLogService();

  const meta = await service.getSessionMeta(sessionId);
  if (!meta) {
    return c.json({ error: { message: 'Session not found', type: 'invalid_request_error', code: 'not_found' } }, 404);
  }

  await service.deleteSession(sessionId);
  return c.json({ success: true }, 200);
});

// ===== 模型发现 API =====

const discoverCache = new Map<string, { data: IModelInfo[]; expiresAt: number }>();
const DISCOVER_CACHE_TTL = 5 * 60 * 1000;

adminRouter.get('/v1/admin/discover-models', async (c: Context) => {
  const providerName = c.req.query('provider');

  if (providerName) {
    const cached = discoverCache.get(providerName);
    if (cached && cached.expiresAt > Date.now()) {
      return c.json({ provider: providerName, models: cached.data, cached: true });
    }

    const provider = getProvider(providerName);
    if (!provider) {
      return c.json({ error: { message: `Provider "${providerName}" not registered`, type: 'not_found', code: 'provider_not_found' } }, 404);
    }
    if (!provider.listModels) {
      return c.json({ error: { message: `Provider "${providerName}" does not support model discovery`, type: 'not_supported', code: 'discovery_not_supported' } }, 501);
    }

    const providerConfig = getProviderConfig(providerName) || { provider: providerName, base_url: '' };

    try {
      const models = await provider.listModels(providerConfig);
      discoverCache.set(providerName, { data: models, expiresAt: Date.now() + DISCOVER_CACHE_TTL });
      return c.json({ provider: providerName, models });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      return c.json({ error: { message, type: 'provider_error', code: 'discovery_failed' } }, 502);
    }
  }

  const results: Record<string, { models?: IModelInfo[]; error?: string; cached?: boolean }> = {};
  const config = getConfig();

  for (const name of getProviderNames()) {
    const cached = discoverCache.get(name);
    if (cached && cached.expiresAt > Date.now()) {
      results[name] = { models: cached.data, cached: true };
      continue;
    }

    const provider = getProvider(name);
    if (!provider?.listModels) {
      results[name] = { error: 'Discovery not supported' };
      continue;
    }

    const providerConfig = config.providers[name] || { provider: name, base_url: '' };

    try {
      const models = await provider.listModels(providerConfig);
      discoverCache.set(name, { data: models, expiresAt: Date.now() + DISCOVER_CACHE_TTL });
      results[name] = { models };
    } catch (err) {
      results[name] = { error: err instanceof Error ? err.message : 'Unknown error' };
    }
  }

  return c.json(results);
});

export default adminRouter;
