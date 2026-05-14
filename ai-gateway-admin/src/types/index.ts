// ============ 统计相关 ============
export interface DashboardStats {
  total_requests: number
  total_tokens: number
  avg_latency: number
  error_rate: number
  requests_trend: number
  tokens_trend: number
  latency_trend: number
  error_trend: number
}

export interface UsageData {
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
  cost: number
  requests: number
}

// ============ 租户相关 ============
export interface Tenant {
  tenant_id: string
  name: string
  status: 'active' | 'suspended' | 'trial'
  plan: 'free' | 'pro' | 'enterprise'
  created_at: number
  updated_at: number
  settings: TenantSettings
  limits: TenantLimits
}

export interface TenantSettings {
  default_provider?: string
  allowed_providers?: string[]
  allowed_models?: string[]
  webhook_url?: string
  notification_email?: string
}

export interface TenantLimits {
  daily_requests: number
  daily_tokens: number
  monthly_cost: number
  max_api_keys: number
  concurrent_requests: number
}

export interface TenantStats {
  total_requests: number
  total_tokens: number
  total_cost: number
  api_keys_count: number
}

// ============ API Key ============
export interface ApiKey {
  key: string
  tenant_id: string
  name: string
  created_at: number
  expires_at?: number
}

// ============ Provider ============
export interface Provider {
  name: string
  status: 'online' | 'offline'
  models: string[]
  requests: number
  latency: number
}

// ============ 配置相关 ============
export interface GatewayConfig {
  port: number
  host: string
  log_level: string
  providers: Record<string, any>
  routing: RoutingRule[]
  auth: AuthConfig
  rate_limit: RateLimitConfig
  failover: FailoverConfig
  load_balance: LoadBalanceConfig
}

export interface RoutingRule {
  name: string
  rules: { model: string; provider: string; max_tokens?: number }[]
  fallback?: string
}

export interface AuthConfig {
  enabled: boolean
  api_keys: ApiKey[]
}

export interface RateLimitConfig {
  enabled: boolean
  qps: number
  burst: number
}

export interface FailoverConfig {
  enabled: boolean
  failureThreshold: number
  successThreshold: number
  healthCheckInterval: number
  healthCheckTimeout: number
  healthCheckModel: string
}

export interface LoadBalanceConfig {
  strategy: string
  providers: Record<string, any>
}

// ============ 缓存 ============
export interface CacheStats {
  size: number
  hit_rate: number
  hits: number
  misses: number
}

// ============ 图表数据 ============
export interface ChartDataItem {
  time: string
  value: number
}

export interface PieChartDataItem {
  name: string
  value: number
}