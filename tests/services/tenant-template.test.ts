import { describe, it, expect, beforeEach } from '@jest/globals';
import {
  createTenantTemplate,
  getTenantTemplate,
  updateTenantTemplate,
  deleteTenantTemplate,
  listTenantTemplates,
  getDefaultTenantTemplate,
  resetTenantTemplateStore,
} from '../../src/services/tenant-template';

describe('TenantTemplateService', () => {
  beforeEach(() => {
    resetTenantTemplateStore();
  });

  it('creates and retrieves a template', () => {
    const created = createTenantTemplate({
      name: 'Pro Template',
      tenant: {
        plan: 'pro',
        status: 'active',
        limits: { daily_requests: 10000, daily_tokens: 1000000, max_api_keys: 20, concurrent_requests: 50 },
      },
    });
    expect(created.template_id).toMatch(/^tpl_/);
    expect(getTenantTemplate(created.template_id)?.name).toBe('Pro Template');
  });

  it('lists templates', () => {
    createTenantTemplate({ name: 'A', tenant: { plan: 'free', status: 'active' } });
    createTenantTemplate({ name: 'B', tenant: { plan: 'pro', status: 'active' } });
    expect(listTenantTemplates()).toHaveLength(2);
  });

  it('updates a template', async () => {
    const created = createTenantTemplate({ name: 'Old', tenant: { plan: 'free', status: 'active' } });
    const updated = await updateTenantTemplate(created.template_id, { name: 'New' });
    expect(updated?.name).toBe('New');
  });

  it('deletes a template', async () => {
    const created = createTenantTemplate({ name: 'ToDelete', tenant: { plan: 'free', status: 'active' } });
    expect(await deleteTenantTemplate(created.template_id)).toBe(true);
    expect(getTenantTemplate(created.template_id)).toBeNull();
  });

  it('returns default template', () => {
    createTenantTemplate({ name: 'Default', is_default: true, tenant: { plan: 'free', status: 'active' } });
    createTenantTemplate({ name: 'Other', tenant: { plan: 'pro', status: 'active' } });
    expect(getDefaultTenantTemplate()?.name).toBe('Default');
  });
});
