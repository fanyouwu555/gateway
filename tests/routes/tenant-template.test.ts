/**
 * Tenant Template Routes Tests
 */
import { describe, it, expect, beforeEach } from '@jest/globals';
import { createApp } from '../../src/app';
import type { Hono } from 'hono';
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

describe('Tenant Template Routes', () => {
  let app: Hono;

  beforeAll(() => {
    app = createApp();
  });

  beforeEach(() => {
    resetTenantTemplateStore();
  });

  it('rejects non-admin requests', async () => {
    const res = await app.request('/v1/tenant-templates', {
      method: 'GET',
      headers: { Authorization: 'Bearer invalid' },
    });
    expect(res.status).toBe(401);
  });

  it('creates and lists templates', async () => {
    const createRes = await app.request('/v1/tenant-templates', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${ADMIN_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: 'Pro',
        tenant: { plan: 'pro', status: 'active' },
      }),
    });
    expect(createRes.status).toBe(201);

    const listRes = await app.request('/v1/tenant-templates', {
      headers: { Authorization: `Bearer ${ADMIN_KEY}` },
    });
    const data = await listRes.json() as { templates: Array<{ name: string }> };
    expect(data.templates).toHaveLength(1);
    expect(data.templates[0].name).toBe('Pro');
  });

  it('gets a template by id', async () => {
    const createRes = await app.request('/v1/tenant-templates', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${ADMIN_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: 'Pro',
        tenant: { plan: 'pro', status: 'active' },
      }),
    });
    const created = await createRes.json() as { template_id: string };

    const getRes = await app.request(`/v1/tenant-templates/${created.template_id}`, {
      headers: { Authorization: `Bearer ${ADMIN_KEY}` },
    });
    expect(getRes.status).toBe(200);
    const body = await getRes.json() as { template_id: string; name: string };
    expect(body.template_id).toBe(created.template_id);
    expect(body.name).toBe('Pro');
  });

  it('returns 404 for missing template', async () => {
    const res = await app.request('/v1/tenant-templates/missing-id', {
      headers: { Authorization: `Bearer ${ADMIN_KEY}` },
    });
    expect(res.status).toBe(404);
  });

  it('updates a template', async () => {
    const createRes = await app.request('/v1/tenant-templates', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${ADMIN_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: 'Pro',
        tenant: { plan: 'pro', status: 'active' },
      }),
    });
    const created = await createRes.json() as { template_id: string };

    const updateRes = await app.request(`/v1/tenant-templates/${created.template_id}`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${ADMIN_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: 'Enterprise' }),
    });
    expect(updateRes.status).toBe(200);
    const body = await updateRes.json() as { name: string };
    expect(body.name).toBe('Enterprise');
  });

  it('returns 404 when updating missing template', async () => {
    const res = await app.request('/v1/tenant-templates/missing-id', {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${ADMIN_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: 'Updated' }),
    });
    expect(res.status).toBe(404);
  });

  it('deletes a template', async () => {
    const createRes = await app.request('/v1/tenant-templates', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${ADMIN_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: 'Pro',
        tenant: { plan: 'pro', status: 'active' },
      }),
    });
    const created = await createRes.json() as { template_id: string };

    const deleteRes = await app.request(`/v1/tenant-templates/${created.template_id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${ADMIN_KEY}` },
    });
    expect(deleteRes.status).toBe(200);
    const body = await deleteRes.json() as { deleted: boolean };
    expect(body.deleted).toBe(true);
  });

  it('returns 404 when deleting missing template', async () => {
    const res = await app.request('/v1/tenant-templates/missing-id', {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${ADMIN_KEY}` },
    });
    expect(res.status).toBe(404);
  });

  it('rejects invalid template data', async () => {
    const res = await app.request('/v1/tenant-templates', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${ADMIN_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: '' }),
    });
    expect(res.status).toBe(400);
  });
});
