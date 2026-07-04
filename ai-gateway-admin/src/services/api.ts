import axios from 'axios'
import type { AxiosRequestConfig } from 'axios'
import type {
  TenantUpdateData,
  ConfigUpdateData,
  Tenant,
  TenantStats,
  ApiKey,
  DashboardOverview,
  TimeSeriesPoint,
  ProviderStats,
  TenantStatsDetail,
  RequestLogItem,
  ConversationSession,
  ConversationDetail,
  HealthData,
  PluginItem,
  AlertRuleItem,
  PromptItem,
  RouterStatusData,
  AuthVerifyResponse,
  CacheStats,
  GatewayConfig,
  DiscoverModelsResponse,
  DiscoverAllResponse,
  ModelListItem,
} from '@/types'

const api = axios.create({
  baseURL: import.meta.env.VITE_API_BASE_URL || '/api',
  timeout: 10000,
})

api.interceptors.request.use(
  (config) => {
    const token = sessionStorage.getItem('api_token')
    if (token && !config.headers.Authorization) {
      config.headers.Authorization = `Bearer ${token}`
    }
    return config
  },
  (error) => Promise.reject(error)
)

api.interceptors.response.use(
  (response) => response.data,
  (error) => {
    if (error.response?.status === 401) {
      sessionStorage.removeItem('api_token')
      if (window.location.pathname !== '/login') {
        window.location.href = '/login'
      }
    }
    return Promise.reject(error)
  }
)

async function get<T>(url: string, config?: AxiosRequestConfig): Promise<T> {
  const response: unknown = await api.get(url, config)
  return response as T
}

async function post<T>(url: string, data?: unknown, config?: AxiosRequestConfig): Promise<T> {
  const response: unknown = await api.post(url, data, config)
  return response as T
}

async function put<T>(url: string, data?: unknown, config?: AxiosRequestConfig): Promise<T> {
  const response: unknown = await api.put(url, data, config)
  return response as T
}

async function del<T>(url: string, config?: AxiosRequestConfig): Promise<T> {
  const response: unknown = await api.delete(url, config)
  return response as T
}

// ============ 健康检查 ============
export async function getHealth(): Promise<HealthData> {
  return get<HealthData>('/health')
}

// ============ 用量统计 ============
export async function getUsage(tenantId = 'default'): Promise<Record<string, unknown>> {
  return get<Record<string, unknown>>(`/v1/usage?tenant_id=${tenantId}`)
}

export async function getQuota(tenantId = 'default'): Promise<Record<string, unknown>> {
  return get<Record<string, unknown>>(`/v1/quota?tenant_id=${tenantId}`)
}

// ============ 缓存 ============
export async function getCacheStats(): Promise<CacheStats> {
  return get<CacheStats>('/v1/cache')
}

export async function cleanCache(): Promise<Record<string, unknown>> {
  return post<Record<string, unknown>>('/v1/cache/clean')
}

// ============ 告警规则 ============
export async function getAlerts(): Promise<{ rules?: AlertRuleItem[] }> {
  return get<{ rules?: AlertRuleItem[] }>('/v1/alerts')
}

export async function createAlert(data: {
  id: string
  name: string
  metric: 'error_rate' | 'avg_latency_ms' | 'total_requests'
  threshold: number
  condition?: 'gt' | 'lt'
  webhook_url: string
  enabled?: boolean
  cooldown_seconds?: number
}): Promise<Record<string, unknown>> {
  return post<Record<string, unknown>>('/v1/alerts', data)
}

export async function deleteAlert(id: string): Promise<Record<string, unknown>> {
  return del<Record<string, unknown>>(`/v1/alerts/${id}`)
}

export async function toggleAlert(id: string, enabled: boolean): Promise<Record<string, unknown>> {
  return post<Record<string, unknown>>(`/v1/alerts/${id}/${enabled ? 'enable' : 'disable'}`)
}

// ============ 提示词模板 ============
export async function getPrompts(): Promise<{ templates?: PromptItem[] }> {
  return get<{ templates?: PromptItem[] }>('/v1/prompts')
}

export async function getPrompt(id: string): Promise<PromptItem> {
  return get<PromptItem>(`/v1/prompts/${id}`)
}

export async function createPrompt(data: {
  id: string
  name: string
  description?: string
  template: string
  variables?: string[]
  default_values?: Record<string, string>
}): Promise<Record<string, unknown>> {
  return post<Record<string, unknown>>('/v1/prompts', data)
}

export async function updatePrompt(id: string, data: {
  name?: string
  description?: string
  template?: string
  variables?: string[]
  default_values?: Record<string, string>
}): Promise<Record<string, unknown>> {
  return put<Record<string, unknown>>(`/v1/prompts/${id}`, data)
}

export async function deletePrompt(id: string): Promise<Record<string, unknown>> {
  return del<Record<string, unknown>>(`/v1/prompts/${id}`)
}

export async function renderPrompt(id: string, variables: Record<string, string>): Promise<{ rendered?: string }> {
  return post<{ rendered?: string }>(`/v1/prompts/${id}/render`, { variables })
}

// ============ 会话 ============
export async function getSessions(): Promise<Record<string, unknown>> {
  return get<Record<string, unknown>>('/v1/sessions')
}

export async function cleanSessions(): Promise<Record<string, unknown>> {
  return post<Record<string, unknown>>('/v1/sessions/clean')
}

// ============ 路由 ============
export async function getRouterStatus(): Promise<RouterStatusData> {
  return get<RouterStatusData>('/v1/router/status')
}

// ============ 租户 ============
export async function getTenants(): Promise<{ tenants?: Tenant[] }> {
  return get<{ tenants?: Tenant[] }>('/v1/tenants')
}

export async function getTenant(id: string): Promise<Tenant> {
  return get<Tenant>(`/v1/tenants/${id}`)
}

export async function getTenantStats(id: string): Promise<TenantStats> {
  return get<TenantStats>(`/v1/tenants/${id}/stats`)
}

export async function createTenant(data: {
  name: string
  plan: string
  status: string
  settings?: {
    default_provider?: string
    allowed_providers?: string[]
    allowed_models?: string[]
    webhook_url?: string
  }
  limits?: {
    daily_requests?: number
    daily_tokens?: number
    monthly_cost?: number
    max_api_keys?: number
    concurrent_requests?: number
  }
}): Promise<Tenant> {
  return post<Tenant>('/v1/tenants', data)
}

export async function updateTenant(id: string, data: TenantUpdateData): Promise<Tenant> {
  return put<Tenant>(`/v1/tenants/${id}`, data)
}

export async function deleteTenant(id: string): Promise<Record<string, unknown>> {
  return del<Record<string, unknown>>(`/v1/tenants/${id}`)
}

// ============ API Keys ============
export async function getTenantKeys(tenantId: string): Promise<{ keys?: ApiKey[] }> {
  return get<{ keys?: ApiKey[] }>(`/v1/tenants/${tenantId}/keys`)
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
}): Promise<{ key?: string }> {
  return post<{ key?: string }>(`/v1/tenants/${tenantId}/keys`, data)
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
}): Promise<Record<string, unknown>> {
  return put<Record<string, unknown>>(`/v1/tenants/${tenantId}/keys/${encodeURIComponent(keyHash)}`, data)
}

export async function deleteApiKey(key: string): Promise<Record<string, unknown>> {
  return del<Record<string, unknown>>(`/v1/keys/${key}`)
}

// ============ Provider ============
export async function getProviders(): Promise<GatewayConfig> {
  return get<GatewayConfig>('/v1/config')
}

// ============ 配置 ============
export async function getConfig(): Promise<GatewayConfig> {
  return get<GatewayConfig>('/v1/config')
}

export async function updateConfig(data: ConfigUpdateData): Promise<GatewayConfig> {
  return put<GatewayConfig>('/v1/config', data)
}

// ============ WebSocket ============
export async function getWsStats(): Promise<Record<string, unknown>> {
  return get<Record<string, unknown>>('/v1/ws')
}

export async function cleanWs(): Promise<Record<string, unknown>> {
  return post<Record<string, unknown>>('/v1/ws/clean')
}

// ============ 插件 ============
export async function getPlugins(): Promise<{ plugins?: PluginItem[] }> {
  return get<{ plugins?: PluginItem[] }>('/v1/plugins')
}

export async function registerPlugin(code: string): Promise<Record<string, unknown>> {
  return post<Record<string, unknown>>('/v1/plugins/register', { code })
}

export async function togglePlugin(id: string, enable: boolean): Promise<Record<string, unknown>> {
  return post<Record<string, unknown>>(`/v1/plugins/${id}/${enable ? 'enable' : 'disable'}`)
}

export async function deletePlugin(id: string): Promise<Record<string, unknown>> {
  return del<Record<string, unknown>>(`/v1/plugins/${id}`)
}

// ============ 认证 ============
export async function verifyApiKey(apiKey: string): Promise<AuthVerifyResponse> {
  return get<AuthVerifyResponse>('/v1/auth/verify', {
    headers: { Authorization: `Bearer ${apiKey}` },
  })
}

// ============ Prometheus 指标 ============
export async function getPrometheusMetrics(): Promise<string> {
  return get<string>('/metrics')
}

// ============ 增强型指标 API (Phase 1) ============

export async function getUsageByTimeRange(start?: number, end?: number): Promise<Record<string, unknown>> {
  const params = new URLSearchParams()
  if (start) params.append('start', start.toString())
  if (end) params.append('end', end.toString())
  return get<Record<string, unknown>>(`/v1/usage/range?${params}`)
}

export async function getTimeSeriesMetrics(
  granularity?: 'hour' | 'day' | 'week' | 'month',
  start?: number,
  end?: number
): Promise<TimeSeriesPoint[]> {
  const params = new URLSearchParams()
  if (granularity) params.append('granularity', granularity)
  if (start) params.append('start', start.toString())
  if (end) params.append('end', end.toString())
  return get<TimeSeriesPoint[]>(`/v1/usage/timeseries?${params}`)
}

export async function getDashboardOverview(start?: number, end?: number): Promise<DashboardOverview> {
  const params = new URLSearchParams()
  if (start) params.append('start', start.toString())
  if (end) params.append('end', end.toString())
  return get<DashboardOverview>(`/v1/usage/overview?${params}`)
}

export async function getProviderStats(start?: number, end?: number): Promise<ProviderStats[]> {
  const params = new URLSearchParams()
  if (start) params.append('start', start.toString())
  if (end) params.append('end', end.toString())
  return get<ProviderStats[]>(`/v1/usage/providers?${params}`)
}

export async function getAllTenantsStats(start?: number, end?: number): Promise<TenantStatsDetail[]> {
  const params = new URLSearchParams()
  if (start) params.append('start', start.toString())
  if (end) params.append('end', end.toString())
  return get<TenantStatsDetail[]>(`/v1/usage/tenants?${params}`)
}

export async function getStatusCodeStats(start?: number, end?: number): Promise<Record<string, number>> {
  const params = new URLSearchParams()
  if (start) params.append('start', start.toString())
  if (end) params.append('end', end.toString())
  return get<Record<string, number>>(`/v1/usage/status-codes?${params}`)
}

// ============ 请求日志 ============
export async function getRequestLogs(params?: {
  start?: number
  end?: number
  tenant_id?: string
  model?: string
  status_code?: number
  limit?: number
  offset?: number
}): Promise<{ logs: RequestLogItem[]; total: number }> {
  const searchParams = new URLSearchParams()
  if (params) {
    if (params.start) searchParams.append('start', params.start.toString())
    if (params.end) searchParams.append('end', params.end.toString())
    if (params.tenant_id) searchParams.append('tenant_id', params.tenant_id)
    if (params.model) searchParams.append('model', params.model)
    if (params.status_code !== undefined) searchParams.append('status_code', params.status_code.toString())
    if (params.limit) searchParams.append('limit', params.limit.toString())
    if (params.offset) searchParams.append('offset', params.offset.toString())
  }
  return get<{ logs: RequestLogItem[]; total: number }>(`/v1/request-logs?${searchParams}`)
}

// ============ 对话日志 ============
export async function getConversations(params?: {
  start?: number
  end?: number
  tenant_id?: string
  model?: string
  client?: string
  session_id?: string
  limit?: number
  offset?: number
}): Promise<{ sessions: ConversationSession[]; total: number }> {
  const searchParams = new URLSearchParams()
  if (params) {
    if (params.start) searchParams.append('start', params.start.toString())
    if (params.end) searchParams.append('end', params.end.toString())
    if (params.tenant_id) searchParams.append('tenant_id', params.tenant_id)
    if (params.model) searchParams.append('model', params.model)
    if (params.client) searchParams.append('client', params.client)
    if (params.session_id) searchParams.append('session_id', params.session_id)
    if (params.limit) searchParams.append('limit', params.limit.toString())
    if (params.offset) searchParams.append('offset', params.offset.toString())
  }
  return get<{ sessions: ConversationSession[]; total: number }>(`/v1/conversations?${searchParams}`)
}

export async function getConversation(sessionId: string): Promise<ConversationDetail> {
  return get<ConversationDetail>(`/v1/conversations/${sessionId}`)
}

export async function getConversationStats(sessionId: string): Promise<Record<string, unknown>> {
  return get<Record<string, unknown>>(`/v1/conversations/${sessionId}/stats`)
}

export async function deleteConversation(sessionId: string): Promise<Record<string, unknown>> {
  return del<Record<string, unknown>>(`/v1/conversations/${sessionId}`)
}

export async function getModels(): Promise<{ object: string; data: ModelListItem[]; default_model?: string }> {
  return get<{ object: string; data: ModelListItem[]; default_model?: string }>('/v1/models')
}

export async function discoverModels(provider?: string): Promise<DiscoverModelsResponse | DiscoverAllResponse> {
  const params = provider ? { provider } : undefined
  return get<DiscoverModelsResponse | DiscoverAllResponse>('/v1/admin/discover-models', { params })
}

export default api
