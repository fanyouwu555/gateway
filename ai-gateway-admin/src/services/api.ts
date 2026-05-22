import axios from 'axios'

const api = axios.create({
  baseURL: import.meta.env.VITE_API_BASE_URL || '/api',
  timeout: 10000,
})

// Request interceptor — read from localStorage, no fallback
api.interceptors.request.use(
  (config) => {
    const token = localStorage.getItem('api_token')
    if (token) {
      config.headers.Authorization = `Bearer ${token}`
    }
    return config
  },
  (error) => Promise.reject(error)
)

// Response interceptor — handle 401
api.interceptors.response.use(
  (response) => response.data,
  (error) => {
    if (error.response?.status === 401) {
      localStorage.removeItem('api_token')
      window.location.href = '/login'
    }
    return Promise.reject(error)
  }
)

// ============ 健康检查 ============
export async function getHealth() {
  return api.get('/health')
}

// ============ 用量统计 ============
export async function getUsage(tenantId = 'default') {
  return api.get(`/v1/usage?tenant_id=${tenantId}`)
}

export async function getQuota(tenantId = 'default') {
  return api.get(`/v1/quota?tenant_id=${tenantId}`)
}

// ============ 缓存 ============
export async function getCacheStats() {
  return api.get('/v1/cache')
}

export async function cleanCache() {
  return api.post('/v1/cache/clean')
}

// ============ 会话 ============
export async function getSessions() {
  return api.get('/v1/sessions')
}

export async function cleanSessions() {
  return api.post('/v1/sessions/clean')
}

// ============ 路由 ============
export async function getRouterStatus() {
  return api.get('/v1/router/status')
}

// ============ 租户 ============
export async function getTenants() {
  return api.get('/v1/tenants')
}

export async function getTenant(id: string) {
  return api.get(`/v1/tenants/${id}`)
}

export async function getTenantStats(id: string) {
  return api.get(`/v1/tenants/${id}/stats`)
}

export async function createTenant(data: {
  name: string
  plan: string
  status: string
}) {
  return api.post('/v1/tenants', data)
}

export async function updateTenant(id: string, data: unknown) {
  return api.put(`/v1/tenants/${id}`, data)
}

export async function deleteTenant(id: string) {
  return api.delete(`/v1/tenants/${id}`)
}

// ============ API Keys ============
export async function getTenantKeys(tenantId: string) {
  return api.get(`/v1/tenants/${tenantId}/keys`)
}

export async function createTenantKey(tenantId: string, data: {
  name: string
  expires_at?: number
  allowed_models?: string[]
  rate_limit_qps?: number
  rate_limit_burst?: number
  monthly_budget?: number
  max_tokens_per_request?: number
  metadata?: Record<string, string>
}) {
  return api.post(`/v1/tenants/${tenantId}/keys`, data)
}

export async function updateKeyPolicy(tenantId: string, keyHash: string, data: {
  name?: string
  expires_at?: number
  allowed_models?: string[]
  rate_limit_qps?: number
  rate_limit_burst?: number
  monthly_budget?: number
  max_tokens_per_request?: number
  metadata?: Record<string, string>
}) {
  return api.put(`/v1/tenants/${tenantId}/keys/${encodeURIComponent(keyHash)}`, data)
}

export async function deleteApiKey(key: string) {
  return api.delete(`/v1/keys/${key}`)
}

// ============ Provider ============
export async function getProviders() {
  // 从 health 或 config 接口获取 Provider 信息
  return api.get('/v1/config')
}

// ============ 配置 ============
export async function getConfig() {
  return api.get('/v1/config')
}

export async function updateConfig(data: unknown) {
  return api.put('/v1/config', data)
}

// ============ WebSocket ============
export async function getWsStats() {
  return api.get('/v1/ws')
}

export async function cleanWs() {
  return api.post('/v1/ws/clean')
}

// ============ 插件 ============
export async function getPlugins() {
  return api.get('/v1/plugins')
}

// ============ Prometheus 指标 ============
export async function getPrometheusMetrics() {
  return api.get('/metrics')
}

// ============ 增强型指标 API (Phase 1) ============

/**
 * 获取时间范围内的用量统计
 */
export async function getUsageByTimeRange(start?: number, end?: number) {
  const params = new URLSearchParams()
  if (start) params.append('start', start.toString())
  if (end) params.append('end', end.toString())
  return api.get(`/v1/usage/range?${params}`)
}

/**
 * 获取时间序列聚合数据
 * @param granularity - 'hour' | 'day' | 'week' | 'month'
 */
export async function getTimeSeriesMetrics(
  granularity?: 'hour' | 'day' | 'week' | 'month',
  start?: number,
  end?: number
) {
  const params = new URLSearchParams()
  if (granularity) params.append('granularity', granularity)
  if (start) params.append('start', start.toString())
  if (end) params.append('end', end.toString())
  return api.get(`/v1/usage/timeseries?${params}`)
}

/**
 * 获取 Dashboard 概览统计
 */
export async function getDashboardOverview(start?: number, end?: number) {
  const params = new URLSearchParams()
  if (start) params.append('start', start.toString())
  if (end) params.append('end', end.toString())
  return api.get(`/v1/usage/overview?${params}`)
}

/**
 * 获取 Provider 维度统计
 */
export async function getProviderStats(start?: number, end?: number) {
  const params = new URLSearchParams()
  if (start) params.append('start', start.toString())
  if (end) params.append('end', end.toString())
  return api.get(`/v1/usage/providers?${params}`)
}

/**
 * 获取所有租户统计
 */
export async function getAllTenantsStats(start?: number, end?: number) {
  const params = new URLSearchParams()
  if (start) params.append('start', start.toString())
  if (end) params.append('end', end.toString())
  return api.get(`/v1/usage/tenants?${params}`)
}

/**
 * 获取状态码分布统计
 */
export async function getStatusCodeStats(start?: number, end?: number) {
  const params = new URLSearchParams()
  if (start) params.append('start', start.toString())
  if (end) params.append('end', end.toString())
  return api.get(`/v1/usage/status-codes?${params}`)
}

export default api