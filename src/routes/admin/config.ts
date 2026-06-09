/**
 * Admin API — 配置管理、模型别名
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import { getConfig, setConfig } from '../../config';
import { configUpdateSchema, modelAliasesSchema } from '../../validation';
import { auditAdmin } from '../../utils/audit';

const router = new Hono();

router.get('/v1/config', (c: Context) => {
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

router.put('/v1/config', async (c: Context) => {
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

router.get('/v1/config/aliases', (c: Context) => {
  const config = getConfig();
  return c.json({ aliases: config.model_aliases || {} });
});

router.put('/v1/config/aliases', async (c: Context) => {
  const parsed = modelAliasesSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({
      error: { message: 'Invalid aliases format', type: 'invalid_request_error', code: 'invalid_request' },
    }, 400);
  }
  setConfig({ model_aliases: parsed.data });
  return c.json({ updated: true });
});

export default router;
