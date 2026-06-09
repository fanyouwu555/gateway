/**
 * Admin API — Prompt 模板管理
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import {
  listTemplates,
  getTemplate,
  createTemplate,
  updateTemplate,
  deleteTemplate,
  renderTemplate,
  parseTemplate,
} from '../../services/prompt';
import { promptTemplateSchema, promptTemplateUpdateSchema } from '../../validation';

const router = new Hono();

router.get('/v1/prompts', (c: Context) => {
  const templates = listTemplates();
  return c.json({ templates });
});

router.get('/v1/prompts/:id', (c: Context) => {
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

router.post('/v1/prompts', async (c: Context) => {
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

router.put('/v1/prompts/:id', async (c: Context) => {
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

router.delete('/v1/prompts/:id', (c: Context) => {
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

router.post('/v1/prompts/:id/render', async (c: Context) => {
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

export default router;
