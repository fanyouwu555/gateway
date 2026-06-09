/**
 * Admin API — 插件管理
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import {
  listPlugins,
  registerPlugin,
  unregisterPlugin,
  setPluginEnabled,
} from '../../plugins';
import { loadPluginInSandbox } from '../../plugins/loader';
import { pluginRegisterSchema } from '../../validation';

const router = new Hono();

router.get('/v1/plugins', (c: Context) => {
  return c.json({ plugins: listPlugins() });
});

router.post('/v1/plugins/register', async (c: Context) => {
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

router.delete('/v1/plugins/:id', (c: Context) => {
  const id = c.req.param('id') || '';
  if (!id) {
    return c.json({
      error: { message: 'Plugin id is required', type: 'invalid_request_error', code: 'invalid_request' },
    }, 400);
  }
  const removed = unregisterPlugin(id);
  if (!removed) {
    return c.json({
      error: { message: `Plugin not found: ${id}`, type: 'invalid_request_error', code: 'plugin_not_found' },
    }, 404);
  }
  return c.json({ unregistered: true, id });
});

router.post('/v1/plugins/:id/enable', (c: Context) => {
  const id = c.req.param('id') || '';
  if (!id) {
    return c.json({
      error: { message: 'Plugin id is required', type: 'invalid_request_error', code: 'invalid_request' },
    }, 400);
  }
  const ok = setPluginEnabled(id, true);
  if (!ok) {
    return c.json({
      error: { message: `Plugin not found: ${id}`, type: 'invalid_request_error', code: 'plugin_not_found' },
    }, 404);
  }
  return c.json({ enabled: true, id });
});

router.post('/v1/plugins/:id/disable', (c: Context) => {
  const id = c.req.param('id') || '';
  if (!id) {
    return c.json({
      error: { message: 'Plugin id is required', type: 'invalid_request_error', code: 'invalid_request' },
    }, 400);
  }
  const ok = setPluginEnabled(id, false);
  if (!ok) {
    return c.json({
      error: { message: `Plugin not found: ${id}`, type: 'invalid_request_error', code: 'plugin_not_found' },
    }, 404);
  }
  return c.json({ disabled: true, id });
});

export default router;
