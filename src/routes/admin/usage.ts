/**
 * Admin API — 用量统计、配额、缓存
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import {
  getTenantUsage,
  getUsageByTimeRange,
  getTimeSeriesMetrics,
  getProviderStats,
  getAllTenantsStats,
  getDashboardOverview,
  getStatusCodeStats,
  type AggregationGranularity,
} from '../../services/metrics';
import { getQuotaStatus } from '../../services/quota';
import { getCacheStats, flushCache } from '../../services/cache';

const router = new Hono();

// === 用量统计 ===
router.get('/v1/usage', (c: Context) => {
  const tenantId = c.req.query('tenant_id') || 'default';
  const usage = getTenantUsage(tenantId);
  return c.json(usage);
});

router.get('/v1/usage/range', (c: Context) => {
  const startQuery = c.req.query('start');
  const endQuery = c.req.query('end');
  const end = endQuery ? parseInt(endQuery, 10) : Date.now();
  const start = startQuery ? parseInt(startQuery, 10) : end - 24 * 60 * 60 * 1000;
  const usage = getUsageByTimeRange(start, end);
  return c.json(usage);
});

router.get('/v1/usage/timeseries', (c: Context) => {
  const startQuery = c.req.query('start');
  const endQuery = c.req.query('end');
  const granularity = c.req.query('granularity') || 'hour';
  const end = endQuery ? parseInt(endQuery, 10) : Date.now();
  const start = startQuery ? parseInt(startQuery, 10) : end - 24 * 60 * 60 * 1000;
  const series = getTimeSeriesMetrics(start, end, granularity as AggregationGranularity);
  return c.json(series);
});

router.get('/v1/usage/overview', (c: Context) => {
  const end = parseInt(c.req.query('end') || String(Date.now()), 10);
  const start = parseInt(c.req.query('start') || String(end - 24 * 60 * 60 * 1000), 10);
  const overview = getDashboardOverview(start, end);
  return c.json(overview);
});

router.get('/v1/usage/providers', (c: Context) => {
  const end = parseInt(c.req.query('end') || String(Date.now()), 10);
  const start = parseInt(c.req.query('start') || String(end - 24 * 60 * 60 * 1000), 10);
  const stats = getProviderStats(start, end);
  return c.json(stats);
});

router.get('/v1/usage/tenants', (c: Context) => {
  const end = parseInt(c.req.query('end') || String(Date.now()), 10);
  const start = parseInt(c.req.query('start') || String(end - 24 * 60 * 60 * 1000), 10);
  const stats = getAllTenantsStats(start, end);
  return c.json(stats);
});

router.get('/v1/usage/status-codes', (c: Context) => {
  const end = parseInt(c.req.query('end') || String(Date.now()), 10);
  const start = parseInt(c.req.query('start') || String(end - 24 * 60 * 60 * 1000), 10);
  const stats = getStatusCodeStats(start, end);
  return c.json(stats);
});

// === 配额状态 ===
router.get('/v1/quota', (c: Context) => {
  const tenantId = c.req.query('tenant_id') || 'default';
  const status = getQuotaStatus(tenantId);
  return c.json(status);
});

// === 缓存管理 ===
router.get('/v1/cache', (c: Context) => {
  const stats = getCacheStats();
  return c.json(stats);
});

router.post('/v1/cache/clean', async (c: Context) => {
  const count = await flushCache();
  return c.json({ cleaned: true, count });
});

export default router;
