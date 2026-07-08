import { Hono } from 'hono';
import type { Context } from 'hono';
import {
  createTenantTemplate,
  getTenantTemplate,
  updateTenantTemplate,
  deleteTenantTemplate,
  listTenantTemplates,
} from '../../services/tenant-template';
import { tenantTemplateSchema, tenantTemplateUpdateSchema } from '../../validation';
import { auditAdmin } from '../../utils/audit';

const router = new Hono();

router.get('/v1/tenant-templates', (c: Context) => {
  return c.json({ templates: listTenantTemplates() });
});

router.get('/v1/tenant-templates/:id', (c: Context) => {
  const id = c.req.param('id')!;
  const template = getTenantTemplate(id);
  if (!template) {
    return c.json({ error: { message: 'Template not found', type: 'invalid_request_error', code: 'not_found' } }, 404);
  }
  return c.json(template);
});

router.post('/v1/tenant-templates', async (c: Context) => {
  const parsed = tenantTemplateSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({
      error: {
        message: parsed.error.errors[0]?.message || 'Invalid template',
        type: 'invalid_request_error',
        code: 'invalid_request',
      },
    }, 400);
  }
  const template = createTenantTemplate(parsed.data);
  auditAdmin({
    ruleId: 'admin.template_created',
    action: 'allow',
    metadata: { template_id: template.template_id, name: template.name },
    severity: 'low',
  });
  return c.json(template, 201);
});

router.put('/v1/tenant-templates/:id', async (c: Context) => {
  const id = c.req.param('id')!;
  const parsed = tenantTemplateUpdateSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({
      error: {
        message: parsed.error.errors[0]?.message || 'Invalid template update',
        type: 'invalid_request_error',
        code: 'invalid_request',
      },
    }, 400);
  }
  const template = await updateTenantTemplate(id, parsed.data);
  if (!template) {
    return c.json({ error: { message: 'Template not found', type: 'invalid_request_error', code: 'not_found' } }, 404);
  }
  auditAdmin({
    ruleId: 'admin.template_updated',
    action: 'allow',
    metadata: { template_id: id, name: template.name },
    severity: 'low',
  });
  return c.json(template);
});

router.delete('/v1/tenant-templates/:id', async (c: Context) => {
  const id = c.req.param('id')!;
  const deleted = await deleteTenantTemplate(id);
  if (!deleted) {
    return c.json({ error: { message: 'Template not found', type: 'invalid_request_error', code: 'not_found' } }, 404);
  }
  auditAdmin({
    ruleId: 'admin.template_deleted',
    action: 'allow',
    metadata: { template_id: id },
    severity: 'low',
  });
  return c.json({ deleted: true });
});

export default router;
