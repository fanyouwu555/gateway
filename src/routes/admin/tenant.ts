/**
 * Admin API — 租户管理
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
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
} from '../../services/tenant';
import { getAllTenantsStats } from '../../services/metrics';
import { tenantConfigSchema, tenantUpdateSchema, createApiKeySchema, updateKeyPolicySchema } from '../../validation';
import { auditAdmin } from '../../utils/audit';
import { getKeyUsage } from '../../services/metrics';

const router = new Hono();

router.get('/v1/tenants', (c: Context) => {
  const tenants = listTenants();
  return c.json({ tenants });
});

router.post('/v1/tenants', async (c: Context) => {
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

router.get('/v1/tenants/:id', (c: Context) => {
  const id = c.req.param('id')!;
  const tenant = getTenant(id);
  if (!tenant) {
    return c.json({ error: { message: 'Tenant not found', type: 'invalid_request_error', code: 'not_found' } }, 404);
  }
  return c.json(tenant);
});

router.get('/v1/tenants/:id/stats', (c: Context) => {
  const id = c.req.param('id')!;
  const tenant = getTenantStats(id);
  if (!tenant) {
    return c.json({ error: { message: 'Tenant not found', type: 'invalid_request_error', code: 'not_found' } }, 404);
  }
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

router.get('/v1/tenants/:id/keys', (c: Context) => {
  const id = c.req.param('id')!;
  const keys = getTenantApiKeys(id);
  return c.json({ keys });
});

router.post('/v1/tenants/:id/keys', async (c: Context) => {
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

router.delete('/v1/keys/:key', (c: Context) => {
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

router.put('/v1/tenants/:id/keys/:keyHash', async (c: Context) => {
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

router.get('/v1/tenants/:id/keys/:keyHash/usage', (c: Context) => {
  const keyHash = c.req.param('keyHash')!;
  const keyMeta = findTenantApiKeyByHash(keyHash);
  if (!keyMeta) {
    return c.json({ error: { message: 'API key not found', type: 'invalid_request_error', code: 'not_found' } }, 404);
  }
  const usage = getKeyUsage(keyHash);
  return c.json({ key: keyMeta, usage });
});

router.put('/v1/tenants/:id', async (c: Context) => {
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

router.delete('/v1/tenants/:id', (c: Context) => {
  const id = c.req.param('id')!;
  const deleted = deleteTenant(id);
  if (!deleted) {
    return c.json({ error: { message: 'Cannot delete tenant', type: 'invalid_request_error', code: 'delete_failed' } }, 400);
  }
  return c.json({ deleted: true });
});

export default router;
