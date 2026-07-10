/**
 * Admin API — 租户管理
 */
import { Hono } from 'hono';
import { DAY_MS } from '../../utils';
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
  getAllTenantApiKeys,
  updateTenantApiKeyPolicy,
} from '../../services/tenant';
import { verifyApiKey } from '../../utils';
import { getTenantTemplate } from '../../services/tenant-template';
import { getAllTenantsStats } from '../../services/metrics';
import { tenantUpdateSchema, createApiKeySchema, updateKeyPolicySchema, createTenantWithTemplateSchema } from '../../validation';
import { auditAdmin } from '../../utils/audit';
import { getKeyUsage } from '../../services/metrics';
import { getBalance, rechargeBalance, getTransactions } from '../../services/wallet';

const router = new Hono();

router.get('/v1/tenants', (c: Context) => {
  const tenants = listTenants();
  return c.json({ tenants });
});

router.post('/v1/tenants', async (c: Context) => {
  const parsed = createTenantWithTemplateSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({
      error: {
        message: parsed.error.errors[0]?.message || 'Invalid tenant config',
        type: 'invalid_request_error',
        code: 'invalid_request',
      },
    }, 400);
  }

  const { template_id, create_default_key, ...tenantInput } = parsed.data;

  let template: ReturnType<typeof getTenantTemplate> = null;
  if (template_id) {
    template = getTenantTemplate(template_id);
    if (!template) {
      return c.json({ error: { message: 'Template not found', type: 'invalid_request_error', code: 'not_found' } }, 404);
    }
  }

  const mergedTenant = {
    name: tenantInput.name,
    plan: tenantInput.plan ?? template?.tenant.plan ?? 'free',
    status: tenantInput.status ?? template?.tenant.status ?? 'active',
    settings: { ...template?.tenant.settings, ...tenantInput.settings },
    limits: { ...template?.tenant.limits, ...tenantInput.limits },
  };

  const tenant = await createTenant(mergedTenant);
  if (!tenant) {
    return c.json({ error: { message: 'Failed to create tenant', type: 'invalid_request_error', code: 'create_failed' } }, 400);
  }

  const response: {
    tenant: typeof tenant;
    default_key?: Awaited<ReturnType<typeof createTenantApiKey>>;
    default_key_error?: { message: string; code: string };
  } = { tenant };

  if (create_default_key) {
    const keyPolicy = template?.default_key;
    const keyName = keyPolicy?.name ?? 'default';
    const key = await createTenantApiKey(
      tenant.tenant_id,
      keyName,
      keyPolicy?.expires_at,
      {
        allowed_models: keyPolicy?.allowed_models,
        default_model: keyPolicy?.default_model,
        rate_limit_qps: keyPolicy?.rate_limit_qps,
        rate_limit_burst: keyPolicy?.rate_limit_burst,
        monthly_budget: keyPolicy?.monthly_budget,
        max_tokens_per_request: keyPolicy?.max_tokens_per_request,
        metadata: keyPolicy?.metadata,
        billing_mode: keyPolicy?.billing_mode ?? 'competition',
        subscription_expires_at: keyPolicy?.subscription_expires_at,
      },
      keyPolicy?.balance
    );

    if (key) {
      response.default_key = key;
      auditAdmin({
        tenantId: tenant.tenant_id,
        ruleId: 'admin.key_created',
        action: 'allow',
        metadata: { key_name: key.name, source: 'template_default', template_id },
        severity: 'low',
      });
    } else {
      response.default_key_error = {
        message: 'Failed to create default API key. The tenant was created successfully; please create a key manually.',
        code: 'default_key_failed',
      };
    }
  }

  auditAdmin({
    ruleId: 'admin.tenant_created',
    action: 'allow',
    tenantId: tenant.tenant_id,
    metadata: { template_id, create_default_key },
    severity: 'low',
  });

  return c.json(response, 201);
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
  const start = end - 30 * DAY_MS;
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
  const enriched = keys.map((k) => ({
    ...k,
    ...(k.billing_mode === 'prepaid' ? { balance: getBalance(k.key) } : {}),
  }));
  return c.json({ keys: enriched });
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
  const { name, expires_at, allowed_models, default_model, rate_limit_qps, rate_limit_burst, monthly_budget, max_tokens_per_request, metadata, billing_mode, balance, subscription_expires_at } = parsed.data;
  const key = await createTenantApiKey(
    tenantId,
    name,
    expires_at,
    {
      allowed_models,
      default_model,
      rate_limit_qps,
      rate_limit_burst,
      monthly_budget,
      max_tokens_per_request,
      metadata,
      billing_mode,
      subscription_expires_at,
    },
    balance
  );
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
  const { balance, ...policyUpdates } = parsed.data;
  const updated = await updateTenantApiKeyPolicy(keyHash, policyUpdates, balance);
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
  const tenant = await updateTenant(id, parsed.data);
  if (!tenant) {
    return c.json({ error: { message: 'Tenant not found', type: 'invalid_request_error', code: 'not_found' } }, 404);
  }
  return c.json(tenant);
});

router.delete('/v1/tenants/:id', async (c: Context) => {
  const id = c.req.param('id')!;
  const deleted = await deleteTenant(id);
  if (!deleted) {
    return c.json({ error: { message: 'Cannot delete tenant', type: 'invalid_request_error', code: 'delete_failed' } }, 400);
  }
  return c.json({ deleted: true });
});

// ===== Wallet / Billing Routes =====

function resolveKeyHash(param: string): string | undefined {
  const keyMeta = findTenantApiKeyByHash(param);
  if (keyMeta) return param;
  // 参数不是 hash，尝试作为明文 key 验证并找到对应 hash
  for (const k of getAllTenantApiKeys()) {
    if (verifyApiKey(param, k.key)) {
      return k.key;
    }
  }
  return undefined;
}

router.get('/v1/tenants/:id/keys/:keyHash/balance', (c: Context) => {
  const keyHash = resolveKeyHash(c.req.param('keyHash')!);
  if (!keyHash) {
    return c.json({ error: { message: 'API key not found', type: 'invalid_request_error', code: 'not_found' } }, 404);
  }
  const keyMeta = findTenantApiKeyByHash(keyHash)!;
  const balance = getBalance(keyHash);
  return c.json({ key: keyMeta, balance_micro_yuan: balance });
});

router.post('/v1/tenants/:id/keys/:keyHash/recharge', async (c: Context) => {
  const tenantId = c.req.param('id')!;
  const keyHash = resolveKeyHash(c.req.param('keyHash')!);
  if (!keyHash) {
    return c.json({ error: { message: 'API key not found', type: 'invalid_request_error', code: 'not_found' } }, 404);
  }
  const keyMeta = findTenantApiKeyByHash(keyHash)!;

  const body = await c.req.json();
  const amountYuan = body.amount;
  if (typeof amountYuan !== 'number' || amountYuan <= 0 || !Number.isFinite(amountYuan)) {
    return c.json({ error: { message: 'Invalid recharge amount', type: 'invalid_request_error', code: 'invalid_amount' } }, 400);
  }

  const amountMicroYuan = Math.round(amountYuan * 1_000_000);
  const result = await rechargeBalance(keyHash, amountMicroYuan, body.reason, body.metadata);

  auditAdmin({
    tenantId,
    ruleId: 'admin.key_recharged',
    action: 'allow',
    metadata: { key_hash: keyHash, amount_micro_yuan: amountMicroYuan, new_balance: result.new_balance_micro_yuan },
    severity: 'low',
  });

  return c.json({
    key: keyMeta,
    new_balance_micro_yuan: result.new_balance_micro_yuan,
    transaction: result.transaction,
  });
});

router.get('/v1/tenants/:id/keys/:keyHash/transactions', (c: Context) => {
  const keyHash = resolveKeyHash(c.req.param('keyHash')!);
  if (!keyHash) {
    return c.json({ error: { message: 'API key not found', type: 'invalid_request_error', code: 'not_found' } }, 404);
  }
  const keyMeta = findTenantApiKeyByHash(keyHash)!;
  const limit = parseInt(c.req.query('limit') || '50', 10);
  const transactions = getTransactions(keyHash, limit);
  return c.json({ key: keyMeta, transactions });
});

export default router;
