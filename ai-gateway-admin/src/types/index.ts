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
  is_admin?: boolean
  allowed_models?: string[]
  default_model?: string
  rate_limit_qps?: number
  rate_limit_burst?: number
  monthly_budget?: number
  max_tokens_per_request?: number
  metadata?: Record<string, string>
  billing_mode?: 'competition' | 'subscription' | 'prepaid'
  /** 余额（微元），由前端通过 /balance API 填充，不来自后端 key 列表 */
  balance?: number
  subscription_expires_at?: number
}

export interface WalletTransaction {
  id: string
  key_hash: string
  tenant_id: string
  type: 'recharge' | 'deduct' | 'refund'
  amount_micro_yuan: number
  balance_after_micro_yuan: number
  reason?: string
  created_at: number
  metadata?: Record<string, string>
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
  providers: Record<string, unknown>
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
}

// ============ 缓存 ============
export interface CacheStats {
  size: number
  hit_rate: number
  hits?: number
  misses?: number
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

// ============ 时间序列数据 ============
export interface TimeSeriesPoint {
  timestamp: number
  time_label: string
  total_requests: number
  total_tokens: number
  total_cost: number
  avg_duration_ms: number
  success_rate: number
  error_rate: number
}

// ============ Provider 统计 ============
export interface ProviderStats {
  provider: string
  total_requests: number
  total_tokens: number
  total_cost: number
  avg_duration_ms: number
  success_rate: number
  by_model: Record<string, {
    total_requests: number
    total_tokens: number
    total_cost: number
    avg_duration_ms: number
  }>
}

// ============ Tenant 统计 ============
export interface TenantStatsDetail {
  tenant_id: string
  total_requests: number
  total_tokens: number
  total_cost: number
  avg_duration_ms: number
  success_rate: number
  by_provider: Record<string, number>
  by_model: Record<string, number>
}

// ============ Dashboard 概览 ============
export interface DashboardOverview {
  total_requests: number
  total_tokens: number
  total_cost: number
  avg_duration_ms: number
  success_rate: number
  error_rate: number
  total_providers: number
  total_models: number
  total_tenants: number
}

// ============ 状态码统计 ============
export interface StatusCodeStats {
  [code: string]: number
}

// ============ 请求日志 ============
export interface RequestLogItem {
  request_id: string
  tenant_id?: string
  timestamp: number
  method: string
  path: string
  provider?: string
  model?: string
  status_code: number
  duration_ms: number
  prompt_tokens?: number
  completion_tokens?: number
  total_tokens?: number
  cost?: number
  error?: string
}

// ============ 对话日志 ============
export interface ConversationSession {
  session_id: string
  created_at: number
  updated_at: number
  turn_count: number
  total_prompt_tokens: number
  total_completion_tokens: number
  total_tokens: number
  total_cost: number
  tenant_id?: string
  last_model?: string
  /** 客户端信息 */
  client_info?: {
    name: string
    version?: string
    inferredFrom: 'header' | 'user-agent' | 'unknown'
  }
  /** 原始 User-Agent */
  user_agent?: string
}

export interface ConversationTurn {
  turn_id: string
  session_id: string
  timestamp: number
  request: {
    messages: Array<{
      role: string
      content?: string
    }>
    tools?: unknown[]
    model: string
  }
  response: {
    content: string
    reasoning_content?: string
    tool_calls?: Array<{
      id: string
      type: string
      function: {
        name: string
        arguments: string
      }
    }>
    usage: {
      prompt_tokens: number
      completion_tokens: number
      total_tokens: number
    }
  }
  metadata: {
    provider: string
    duration_ms: number
    cost: number
    status_code: number
    tenant_id?: string
    error?: string
    /** 客户端信息 */
    client_info?: {
      name: string
      version?: string
      inferredFrom: 'header' | 'user-agent' | 'unknown'
    }
    /** 会话标识来源 */
    session_source?: {
      id: string
      provided_by_header?: string
    }
    /** 原始 User-Agent */
    user_agent?: string
  }
}

export interface TenantUpdateData {
  name?: string
  status?: 'active' | 'suspended' | 'trial'
  plan?: 'free' | 'pro' | 'enterprise'
  settings?: TenantSettings
  limits?: Partial<TenantLimits>
}

export interface ConfigUpdateData {
  port?: number
  host?: string
  log_level?: 'debug' | 'info' | 'warn' | 'error'
  providers?: Record<string, unknown>
  routing?: RoutingRule[]
  auth?: { enabled?: boolean; api_keys?: ApiKey[] }
  rate_limit?: Partial<RateLimitConfig>
  failover?: Partial<FailoverConfig>
  cache?: { enabled?: boolean; ttl?: number; max_size?: number }
  pricing?: Record<string, { input: number; output: number }>
  model_aliases?: Record<string, string>
}

export interface ConversationDetail {
  session: ConversationSession
  turns: ConversationTurn[]
}

export interface HealthData {
  status: string
  version?: string
  uptime?: number
  services?: {
    providers?: Array<{
      name: string
      status: string
      has_api_key?: boolean
      base_url?: string
    }>
  }
}

export interface PluginItem {
  id: string
  name: string
  type: 'request' | 'response' | 'transform' | 'guardrail' | 'custom'
  enabled: boolean
  priority: number
  settings?: Record<string, unknown>
}

export interface AlertRuleItem {
  id: string
  name: string
  metric: 'error_rate' | 'avg_latency_ms' | 'total_requests'
  threshold: number
  condition: 'gt' | 'lt'
  webhook_url: string
  enabled: boolean
  cooldown_seconds: number
}

export interface PromptItem {
  id: string
  name: string
  description?: string
  template: string
  variables: string[]
  default_values?: Record<string, string>
  created_at: number
  updated_at: number
}

export interface RouterStatusData {
  providers: Record<string, {
    isHealthy?: boolean
    totalRequests?: number
    errorRate?: number
    avgLatencyMs?: number
  }>
}

export interface AuthVerifyResponse {
  is_admin: boolean
}

export interface ModelInfo {
  id: string
  owned_by?: string
  context_window?: number
  max_output_tokens?: number
  capabilities?: {
    chat?: boolean
    embed?: boolean
    streaming?: boolean
    vision?: boolean
    function_call?: boolean
  }
  pricing?: { input: number; output: number }
  created?: number
}

export interface DiscoverModelsResponse {
  provider?: string
  models?: ModelInfo[]
  error?: string
  cached?: boolean
}

export interface DiscoverAllResponse {
  [providerName: string]: {
    models?: ModelInfo[]
    error?: string
    cached?: boolean
  }
}

export interface ModelListItem {
  id: string
  object: string
  owned_by: string
  context_window?: number
  pricing?: { input: number; output: number }
}