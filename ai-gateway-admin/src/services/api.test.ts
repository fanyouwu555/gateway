import { describe, it, expect, beforeEach } from 'vitest'
import { http, HttpResponse } from 'msw'
import { server } from '@/test/server'
import {
  getHealth,
  getUsage,
  getQuota,
  getCacheStats,
  cleanCache,
  getTenants,
  getTenant,
  createTenant,
  updateTenant,
  deleteTenant,
  getConfig,
  updateConfig,
  getUsageByTimeRange,
  getDashboardOverview,
  getProviderStats,
  getPrometheusMetrics,
} from './api'

describe('API Service', () => {
  beforeEach(() => {
    localStorage.setItem('api_token', 'admin-dashboard-key-456')
  })

  describe('Health', () => {
    it('getHealth fetches /health with auth header', async () => {
      let authHeader = ''
      server.use(
        http.get('/api/health', ({ request }) => {
          authHeader = request.headers.get('authorization') || ''
          return HttpResponse.json({ status: 'ok', timestamp: Date.now() })
        })
      )

      const result = await getHealth()
      expect(authHeader).toBe('Bearer admin-dashboard-key-456')
      expect(result).toEqual({ status: 'ok', timestamp: expect.any(Number) })
    })
  })

  describe('Usage & Quota', () => {
    it('getUsage calls /v1/usage with tenant_id', async () => {
      server.use(
        http.get('/api/v1/usage', ({ request }) => {
          const url = new URL(request.url)
          expect(url.searchParams.get('tenant_id')).toBe('test-tenant')
          return HttpResponse.json({ total_requests: 100, total_tokens: 5000 })
        })
      )

      const result = await getUsage('test-tenant')
      expect(result).toEqual({ total_requests: 100, total_tokens: 5000 })
    })

    it('getQuota calls /v1/quota', async () => {
      server.use(
        http.get('/api/v1/quota', () =>
          HttpResponse.json({ allowed: true, remaining: 500 })
        )
      )

      const result = await getQuota('default')
      expect(result).toEqual({ allowed: true, remaining: 500 })
    })
  })

  describe('Cache', () => {
    it('getCacheStats calls /v1/cache', async () => {
      server.use(
        http.get('/api/v1/cache', () =>
          HttpResponse.json({ size: 42, hit_rate: 0.85 })
        )
      )

      const result = await getCacheStats()
      expect(result).toEqual({ size: 42, hit_rate: 0.85 })
    })

    it('cleanCache calls POST /v1/cache/clean', async () => {
      server.use(
        http.post('/api/v1/cache/clean', () =>
          HttpResponse.json({ cleaned: true })
        )
      )

      const result = await cleanCache()
      expect(result).toEqual({ cleaned: true })
    })
  })

  describe('Tenants', () => {
    it('getTenants calls /v1/tenants', async () => {
      server.use(
        http.get('/api/v1/tenants', () =>
          HttpResponse.json({ tenants: [{ tenant_id: 't1', name: 'A' }] })
        )
      )

      const result = await getTenants()
      expect(result).toEqual({ tenants: [{ tenant_id: 't1', name: 'A' }] })
    })

    it('getTenant calls /v1/tenants/:id', async () => {
      server.use(
        http.get('/api/v1/tenants/t1', () =>
          HttpResponse.json({ tenant_id: 't1', name: 'Test' })
        )
      )

      const result = await getTenant('t1')
      expect(result).toEqual({ tenant_id: 't1', name: 'Test' })
    })

    it('createTenant POSTs correct payload', async () => {
      let body: Record<string, unknown> = {}
      server.use(
        http.post('/api/v1/tenants', async ({ request }) => {
          body = (await request.json()) as Record<string, unknown>
          return HttpResponse.json({ tenant_id: 'new', ...body })
        })
      )

      const result = await createTenant({ name: 'NewCo', plan: 'pro', status: 'active' })
      expect(body).toEqual({ name: 'NewCo', plan: 'pro', status: 'active' })
      expect(result).toMatchObject({ tenant_id: 'new', name: 'NewCo' })
    })

    it('updateTenant PUTs correct payload', async () => {
      let body: Record<string, unknown> = {}
      server.use(
        http.put('/api/v1/tenants/t1', async ({ request }) => {
          body = (await request.json()) as Record<string, unknown>
          return HttpResponse.json({ tenant_id: 't1', ...body })
        })
      )

      const result = await updateTenant('t1', { name: 'Updated' })
      expect(body).toEqual({ name: 'Updated' })
      expect(result).toMatchObject({ tenant_id: 't1', name: 'Updated' })
    })

    it('deleteTenant calls DELETE /v1/tenants/:id', async () => {
      server.use(
        http.delete('/api/v1/tenants/t1', () =>
          HttpResponse.json({ deleted: true })
        )
      )

      const result = await deleteTenant('t1')
      expect(result).toEqual({ deleted: true })
    })
  })

  describe('Config', () => {
    it('getConfig calls /v1/config', async () => {
      server.use(
        http.get('/api/v1/config', () =>
          HttpResponse.json({ port: 3000, log_level: 'info' })
        )
      )

      const result = await getConfig()
      expect(result).toEqual({ port: 3000, log_level: 'info' })
    })

    it('updateConfig PUTs correct payload', async () => {
      let body: Record<string, unknown> = {}
      server.use(
        http.put('/api/v1/config', async ({ request }) => {
          body = (await request.json()) as Record<string, unknown>
          return HttpResponse.json({ updated: true })
        })
      )

      const result = await updateConfig({ log_level: 'debug' })
      expect(body).toEqual({ log_level: 'debug' })
      expect(result).toEqual({ updated: true })
    })
  })

  describe('Metrics (Phase 1)', () => {
    it('getUsageByTimeRange builds correct query params', async () => {
      let search = ''
      server.use(
        http.get('/api/v1/usage/range', ({ request }) => {
          search = new URL(request.url).search
          return HttpResponse.json({ total_requests: 10 })
        })
      )

      const result = await getUsageByTimeRange(1000, 2000)
      expect(search).toContain('start=1000')
      expect(search).toContain('end=2000')
      expect(result).toEqual({ total_requests: 10 })
    })

    it('getDashboardOverview fetches overview', async () => {
      server.use(
        http.get('/api/v1/usage/overview', () =>
          HttpResponse.json({ requests: 100, tokens: 1000 })
        )
      )

      const result = await getDashboardOverview()
      expect(result).toEqual({ requests: 100, tokens: 1000 })
    })

    it('getProviderStats fetches provider stats', async () => {
      server.use(
        http.get('/api/v1/usage/providers', () =>
          HttpResponse.json({ openai: 50, deepseek: 30 })
        )
      )

      const result = await getProviderStats()
      expect(result).toEqual({ openai: 50, deepseek: 30 })
    })

    it('getPrometheusMetrics fetches /metrics', async () => {
      server.use(
        http.get('/api/metrics', () =>
          HttpResponse.text('# HELP gateway_requests_total')
        )
      )

      const result = await getPrometheusMetrics()
      expect(result).toContain('gateway_requests_total')
    })
  })

  describe('Error handling', () => {
    it('rejects on 500 error', async () => {
      server.use(
        http.get('/api/health', () =>
          HttpResponse.json({ error: 'Internal error' }, { status: 500 })
        )
      )

      await expect(getHealth()).rejects.toThrow()
    })
  })

  describe('401 interceptor', () => {
    it('clears token and redirects on 401', async () => {
      const originalLocation = window.location
      const mockLocation = { href: 'http://localhost/dashboard' }
      Object.defineProperty(window, 'location', {
        value: mockLocation,
        writable: true,
        configurable: true,
      })

      server.use(
        http.get('/api/health', () =>
          HttpResponse.json({ error: 'Unauthorized' }, { status: 401 })
        )
      )

      await expect(getHealth()).rejects.toThrow()
      expect(localStorage.getItem('api_token')).toBeNull()
      expect(window.location.href).toBe('/login')

      Object.defineProperty(window, 'location', {
        value: originalLocation,
        writable: true,
        configurable: true,
      })
    })
  })
})
