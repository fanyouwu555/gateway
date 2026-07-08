/**
 * Tenant Routes Tests
 */
import { describe, it, expect, beforeEach } from '@jest/globals';
import { createApp } from '../../src/app';
import type { Hono } from 'hono';
import { resetTenantStore } from '../../src/services/tenant';
import { resetTenantTemplateStore } from '../../src/services/tenant-template';

const ADMIN_KEY = 'admin-dashboard-key-456';

jest.mock('../../src/config', () => ({
  getConfig: jest.fn(() => ({
    port: 3000,
    host: '0.0.0.0',
    log_level: 'info',
    providers: {
      openai: { provider: 'openai', base_url: 'https://api.openai.com/v1', api_key: 'sk-test' },
    },
    routing: [{ name: 'default', rules: [{ model: 'gpt-4o', provider: 'openai' }] }],
    auth: {
      enabled: true,
      api_keys: [{
        key: 'admin-dashboard-key-456',
        tenant_id: 'default',
        name: 'Admin Key',
        created_at: Date.now(),
        is_admin: true,
      }],
    },
    rate_limit: { enabled: false, qps: 1000, burst: 1000 },
  })),
  getProviderConfig: jest.fn(() => ({ provider: 'openai', base_url: 'https://api.openai.com/v1', api_key: 'sk-test' })),
  getProviderForModel: jest.fn(() => 'openai'),
  getRoutingStrategy: jest.fn(() => ({ name: 'default', rules: [{ model: 'gpt-4o', provider: 'openai' }] })),
  setConfig: jest.fn(),
  isModelPool: jest.fn(() => false),
  getModelPool: jest.fn(() => undefined),
}));

jest.mock('../../src/utils', () => ({
  ...jest.requireActual('../../src/utils'),
  verifyApiKey: jest.fn((apiKey: string, hashed: string) => apiKey === hashed),
}));

describe('Tenant Routes', () => {
  let app: Hono;

  beforeAll(() => {
    app = createApp();
  });

  beforeEach(() => {
    resetTenantStore();
    resetTenantTemplateStore();
  });

  it('rejects non-admin requests', async () => {
    const res = await app.request('/v1/tenants', {
      method: 'POST',
      headers: { Authorization: 'Bearer invalid', 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Test', status: 'active', plan: 'free' }),
    });
    expect(res.status).toBe(401);
  });

  it('creates a basic tenant', async () => {
    const res = await app.request('/v1/tenants', {
      method: 'POST',
      headers: { Authorization: `Bearer ${ADMIN_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Basic Tenant', status: 'active', plan: 'free' }),
    });
    expect(res.status).toBe(201);
    const data = await res.json() as { tenant: { name: string; plan: string } };
    expect(data.tenant.name).toBe('Basic Tenant');
    expect(data.tenant.plan).toBe('free');
  });

  it('creates tenant from template with default key', async () => {
    const templateRes = await app.request('/v1/tenant-templates', {
      method: 'POST',
      headers: { Authorization: `Bearer ${ADMIN_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Pro Template',
        tenant: { plan: 'pro', status: 'active' },
        default_key: { name: 'default', billing_mode: 'competition' },
      }),
    });
    const template = await templateRes.json() as { template_id: string };

    const res = await app.request('/v1/tenants', {
      method: 'POST',
      headers: { Authorization: `Bearer ${ADMIN_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'From Template',
        template_id: template.template_id,
        create_default_key: true,
      }),
    });
    expect(res.status).toBe(201);
    const data = await res.json() as {
      tenant: { plan: string; name: string };
      default_key: { key: string; name: string };
    };
    expect(data.tenant.plan).toBe('pro');
    expect(data.default_key).toBeDefined();
    expect(data.default_key.key).toMatch(/^sk-v1-/);
    expect(data.default_key.name).toBe('default');
  });

  it('returns 404 for missing template', async () => {
    const res = await app.request('/v1/tenants', {
      method: 'POST',
      headers: { Authorization: `Bearer ${ADMIN_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Missing Template',
        template_id: 'tpl_nonexistent',
        create_default_key: true,
      }),
    });
    expect(res.status).toBe(404);
  });

  it('does not create default key when create_default_key is false', async () => {
    const templateRes = await app.request('/v1/tenant-templates', {
      method: 'POST',
      headers: { Authorization: `Bearer ${ADMIN_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Default Key Template',
        tenant: { plan: 'enterprise', status: 'active' },
        default_key: { name: 'default', billing_mode: 'competition' },
      }),
    });
    const template = await templateRes.json() as { template_id: string };

    const res = await app.request('/v1/tenants', {
      method: 'POST',
      headers: { Authorization: `Bearer ${ADMIN_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'No Default Key',
        template_id: template.template_id,
        create_default_key: false,
      }),
    });
    expect(res.status).toBe(201);
    const data = await res.json() as {
      tenant: { plan: string };
      default_key?: unknown;
      default_key_error?: unknown;
    };
    expect(data.tenant.plan).toBe('enterprise');
    expect(data.default_key).toBeUndefined();
    expect(data.default_key_error).toBeUndefined();
  });

  it('merges settings from template and request', async () => {
    const templateRes = await app.request('/v1/tenant-templates', {
      method: 'POST',
      headers: { Authorization: `Bearer ${ADMIN_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Settings Template',
        tenant: {
          plan: 'pro',
          status: 'active',
          settings: { default_provider: 'openai', allowed_models: ['gpt-4o'] },
        },
      }),
    });
    const template = await templateRes.json() as { template_id: string };

    const res = await app.request('/v1/tenants', {
      method: 'POST',
      headers: { Authorization: `Bearer ${ADMIN_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Merged Tenant',
        template_id: template.template_id,
        settings: { default_provider: 'deepseek' },
      }),
    });
    expect(res.status).toBe(201);
    const data = await res.json() as {
      tenant: {
        settings: { default_provider: string; allowed_models?: string[] };
      };
    };
    expect(data.tenant.settings.default_provider).toBe('deepseek');
    expect(data.tenant.settings.allowed_models).toEqual(['gpt-4o']);
  });
});
