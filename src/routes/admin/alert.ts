/**
 * Admin API — 告警规则管理
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import {
  listAlertRules,
  addAlertRule,
  removeAlertRule,
  setAlertEnabled,
  evaluateAlerts,
} from '../../services/alert';
import { alertRuleSchema } from '../../validation';

const router = new Hono();

router.get('/v1/alerts', (c: Context) => {
  return c.json({ rules: listAlertRules() });
});

router.post('/v1/alerts', async (c: Context) => {
  const parsed = alertRuleSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({
      error: {
        message: parsed.error.errors[0]?.message || 'Invalid alert rule',
        type: 'invalid_request_error',
        code: 'invalid_request',
        param: parsed.error.errors[0]?.path?.join('.'),
      },
    }, 400);
  }

  addAlertRule({
    id: parsed.data.id,
    name: parsed.data.name,
    metric: parsed.data.metric,
    threshold: parsed.data.threshold,
    condition: parsed.data.condition,
    webhook_url: parsed.data.webhook_url,
    enabled: parsed.data.enabled,
    cooldown_seconds: parsed.data.cooldown_seconds,
  });

  return c.json({ created: true }, 201);
});

router.delete('/v1/alerts/:id', (c: Context) => {
  const id = c.req.param('id') || '';
  if (!id) {
    return c.json({
      error: { message: 'Alert id is required', type: 'invalid_request_error', code: 'invalid_request' },
    }, 400);
  }
  const removed = removeAlertRule(id);
  if (!removed) {
    return c.json({
      error: { message: `Alert rule not found: ${id}`, type: 'invalid_request_error', code: 'not_found' },
    }, 404);
  }
  return c.json({ removed: true, id });
});

router.post('/v1/alerts/:id/enable', (c: Context) => {
  const id = c.req.param('id') || '';
  if (!id) {
    return c.json({
      error: { message: 'Alert id is required', type: 'invalid_request_error', code: 'invalid_request' },
    }, 400);
  }
  const ok = setAlertEnabled(id, true);
  if (!ok) {
    return c.json({
      error: { message: `Alert rule not found: ${id}`, type: 'invalid_request_error', code: 'not_found' },
    }, 404);
  }
  return c.json({ enabled: true, id });
});

router.post('/v1/alerts/:id/disable', (c: Context) => {
  const id = c.req.param('id') || '';
  if (!id) {
    return c.json({
      error: { message: 'Alert id is required', type: 'invalid_request_error', code: 'invalid_request' },
    }, 400);
  }
  const ok = setAlertEnabled(id, false);
  if (!ok) {
    return c.json({
      error: { message: `Alert rule not found: ${id}`, type: 'invalid_request_error', code: 'not_found' },
    }, 404);
  }
  return c.json({ disabled: true, id });
});

router.post('/v1/alerts/evaluate', (c: Context) => {
  evaluateAlerts();
  return c.json({ evaluated: true });
});

export default router;
