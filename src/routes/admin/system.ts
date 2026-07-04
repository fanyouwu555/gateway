/**
 * Admin API — 系统管理
 * 认证、路由状态、WebSocket、定价、日志、会话、模型发现
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import { getConfig, getProviderConfig } from '../../config';
import { getRouterStatus } from '../../services/router';
import { getWebSocketStats, cleanWebSocketConnections } from '../../middleware/websocket';
import { getPricingService } from '../../services/pricing';
import { getRequestLogStore } from '../../services/request-log';
import { getConversationLogService } from '../../services/conversation-log';
import { getProvider, getProviderNames } from '../../providers';
import { auditAdmin, readAuditLogs } from '../../utils/audit';
import type { IModelInfo, IConversationFilter } from '../../types';

const router = new Hono();

// === 认证验证 ===
router.get('/v1/auth/verify', (c: Context) => {
  const apiKeyMeta = c.get('api_key_meta');
  return c.json({
    valid: true,
    is_admin: apiKeyMeta?.is_admin || false,
    tenant_id: apiKeyMeta?.tenant_id || 'default',
  });
});

// === 路由状态 ===
router.get('/v1/router/status', (c: Context) => {
  const status = getRouterStatus();
  return c.json(status);
});

// === WebSocket 统计 ===
router.get('/v1/ws/stats', (c: Context) => {
  return c.json(getWebSocketStats());
});

router.post('/v1/ws/clean', (c: Context) => {
  const cleaned = cleanWebSocketConnections();
  return c.json({ cleaned });
});

// === 模型定价 ===
router.get('/v1/pricing', (c: Context) => {
  const prices = getPricingService().getAllPrices();
  const overrides = getPricingService().getOverrides();
  return c.json({ prices, overrides });
});

router.put('/v1/pricing/:model', async (c: Context) => {
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

router.delete('/v1/pricing/:model', (c: Context) => {
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
router.get('/v1/request-logs', (c: Context) => {
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

// === 会话管理（基于对话日志的统计视图） ===
router.get('/v1/sessions', async (c: Context) => {
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

router.post('/v1/sessions/clean', async (c: Context) => {
  const service = getConversationLogService();
  await service.clearAll();
  return c.json({ cleaned: true });
});

// === 会话日志管理 ===
router.get('/v1/conversations', async (c: Context) => {
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

router.get('/v1/conversations/:session_id', async (c: Context) => {
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

router.get('/v1/conversations/:session_id/stats', async (c: Context) => {
  const sessionId = c.req.param('session_id')!;
  const service = getConversationLogService();

  const meta = await service.getSessionMeta(sessionId);
  if (!meta) {
    return c.json({ error: { message: 'Session not found', type: 'not_found' } }, 404);
  }

  return c.json(meta, 200);
});

router.delete('/v1/conversations/:session_id', async (c: Context) => {
  const sessionId = c.req.param('session_id')!;
  const service = getConversationLogService();

  const meta = await service.getSessionMeta(sessionId);
  if (!meta) {
    return c.json({ error: { message: 'Session not found', type: 'invalid_request_error', code: 'not_found' } }, 404);
  }

  await service.deleteSession(sessionId);
  return c.json({ success: true }, 200);
});

// === 审计日志 ===
router.get('/v1/audit/logs', (c: Context) => {
  const tenantId = c.req.query('tenant_id');
  const eventType = c.req.query('event_type');
  const start = c.req.query('start') ? parseInt(c.req.query('start')!, 10) : undefined;
  const end = c.req.query('end') ? parseInt(c.req.query('end')!, 10) : undefined;
  const limit = c.req.query('limit') ? parseInt(c.req.query('limit')!, 10) : 50;
  const offset = c.req.query('offset') ? parseInt(c.req.query('offset')!, 10) : 0;

  const result = readAuditLogs({
    tenant_id: tenantId,
    event_type: eventType,
    start,
    end,
    limit: Math.min(limit, 500),
    offset,
  });

  return c.json(result);
});

// === 模型发现 ===
const discoverCache = new Map<string, { data: IModelInfo[]; expiresAt: number }>();
const DISCOVER_CACHE_TTL = 5 * 60 * 1000;

router.get('/v1/admin/discover-models', async (c: Context) => {
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

export default router;
