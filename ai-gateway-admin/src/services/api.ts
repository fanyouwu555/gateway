import axios from 'axios'

const api = axios.create({
  baseURL: import.meta.env.VITE_API_BASE_URL || '/api',
  timeout: 10000,
})

// 请求拦截器
api.interceptors.request.use(
  (config) => {
    // 可以添加认证 token
    const token = localStorage.getItem('api_token')
    if (token) {
      config.headers.Authorization = `Bearer ${token}`
    }
    return config
  },
  (error) => {
    return Promise.reject(error)
  }
)

// 响应拦截器
api.interceptors.response.use(
  (response) => response.data,
  (error) => {
    console.error('API Error:', error)
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

export async function updateTenant(id: string, data: any) {
  return api.put(`/v1/tenants/${id}`, data)
}

export async function deleteTenant(id: string) {
  return api.delete(`/v1/tenants/${id}`)
}

// ============ API Keys ============
export async function getTenantKeys(tenantId: string) {
  return api.get(`/v1/tenants/${tenantId}/keys`)
}

export async function createTenantKey(tenantId: string, data: { name: string; expires_at?: number }) {
  return api.post(`/v1/tenants/${tenantId}/keys`, data)
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

export async function updateConfig(data: any) {
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

export default api