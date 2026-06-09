/**
 * AI Gateway - 公共类型定义
 * 所有类型定义必须在此文件集中管理
 */

// ===== 通用类型 =====

/** 请求ID类型 */
export type RequestId = string;

/** 租户ID类型 */
export type TenantId = string;

/** API Key类型 */
export type ApiKey = string;

// ===== 请求类型 =====

/** Chat Completion 请求消息 */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | ChatContentPart[];
  name?: string;
  tool_call_id?: string;
  tool_calls?: ChatToolCall[];
  /** Reasoning/thinking content from reasoning models (DeepSeek R1, Kimi thinking mode, etc.) */
  reasoning_content?: string;
}

/** Chat Tool Call（assistant 调用的 tool） */
export interface ChatToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

/** Chat Content Part（支持多模态） */
export interface ChatContentPart {
  type: 'text' | 'image_url';
  text?: string;
  image_url?: {
    url: string;
    detail?: 'low' | 'high' | 'auto';
  };
}

/** Chat Completion 请求体 */
export interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  stream?: boolean;
  stop?: string | string[];
  presence_penalty?: number;
  frequency_penalty?: number;
  user?: string;
  tools?: ChatTool[];
  tool_choice?: ChatToolChoice;
}

/** Chat工具定义 */
export interface ChatTool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

/** 工具选择 */
export type ChatToolChoice =
  | 'none'
  | 'auto'
  | 'required'
  | { type: 'function'; function: { name: string } };

/** Embedding 请求体 */
export interface EmbeddingRequest {
  model: string;
  input: string | string[];
  encoding_format?: 'float' | 'base64';
  dimensions?: number;
}

// ===== 响应类型 =====

/** Chat Completion 响应消息 */
export interface ChatChoice {
  index: number;
  message: ChatMessage;
  finish_reason: 'stop' | 'length' | 'tool_calls' | null;
  delta?: ChatMessage;
}

/** Chat Completion 完整响应 */
export interface ChatCompletionResponse {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: ChatChoice[];
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

/** Streaming Chat Completion chunk */
export interface ChatCompletionChunk {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: ChatMessage;
    finish_reason: 'stop' | 'length' | 'tool_calls' | null;
  }>;
}

/** Embedding 响应 */
export interface EmbeddingResponse {
  object: 'list';
  data: Array<{
    object: 'embedding';
    embedding: number[];
    index: number;
  }>;
  model: string;
  usage: {
    prompt_tokens: number;
    total_tokens: number;
  };
}

// ===== Provider 类型 =====

/** Provider 配置接口 */
export interface IProviderConfig {
  provider: string;
  base_url: string;
  /** 单个 API Key（兼容单 Key 场景） */
  api_key?: string;
  /** 多个 API Key（用于负载均衡），优先级高于 api_key */
  api_keys?: string[];
  timeout?: number;
  max_retries?: number;
  headers?: Record<string, string>;
}

/** Provider 能力定义 */
export interface IProviderCapabilities {
  chat: boolean;
  embed: boolean;
  streaming: boolean;
  vision: boolean;
  function_call: boolean;
}

/** Provider 模型信息（由 listModels 返回） */
export interface IModelInfo {
  id: string;
  owned_by?: string;
  context_window?: number;
  max_output_tokens?: number;
  capabilities?: Partial<IProviderCapabilities>;
  pricing?: { input: number; output: number };
  created?: number;
}

/** Provider 接口 */
export interface IProvider {
  name: string;
  capabilities: IProviderCapabilities;
  chat(request: ChatCompletionRequest, config: IProviderConfig): Promise<ChatCompletionResponse>;
  chatStream(request: ChatCompletionRequest, config: IProviderConfig, options?: { signal?: AbortSignal }): Promise<ReadableStream>;
  embed(request: EmbeddingRequest, config: IProviderConfig): Promise<EmbeddingResponse>;
  listModels?(config: IProviderConfig): Promise<IModelInfo[]>;
}

// ===== 路由类型 =====

/** 路由策略 */
export interface IRoutingStrategy {
  name: string;
  rules: IRoutingRule[];
  fallback?: string;
  /** Provider 成本排序（从低到高），用于 cost 策略 */
  cost_order?: string[];
  /** 条件路由规则 */
  conditional_rules?: IConditionalRoutingRule[];
}

/** 路由规则 */
export interface IRoutingRule {
  model: string;
  provider: string;
  max_tokens?: number;
  priority?: number;
}

/** 条件路由规则 */
export interface IConditionalRoutingRule {
  name: string;
  priority: number;
  condition: {
    field: string;
    operator: 'eq' | 'neq' | 'contains' | 'gt' | 'lt' | 'regex';
    value: string | number | boolean;
  };
  target: {
    provider: string;
    model?: string;
  };
}

// ===== 模型能力池类型 =====

/** 模型池候选 */
export interface IModelPoolCandidate {
  provider: string;
  model: string;
  priority: number;
  enabled?: boolean;
}

/** 模型能力池 */
export interface IModelPool {
  name: string;
  description?: string;
  capabilities?: string[];
  candidates: IModelPoolCandidate[];
}

// ===== 鉴权类型 =====

/** API Key 元数据 */
export interface IApiKeyMeta {
  key: string;
  tenant_id: TenantId;
  name: string;
  created_at: number;
  expires_at?: number;
  is_admin?: boolean;
  limits?: {
    daily_requests?: number;
    daily_tokens?: number;
  };

  // 虚拟 Key 策略（可选 — 现有 Key 不受影响）
  allowed_models?: string[];             // 允许的模型列表，空/不设 = 不限制
  default_model?: string;                // 该 Key 的默认模型
  rate_limit_qps?: number;               // 该 Key 独立的 QPS
  rate_limit_burst?: number;             // 该 Key 独立的突发容量
  monthly_budget?: number;               // 月度预算上限（USD）
  max_tokens_per_request?: number;       // 单次请求最大 token 数
  metadata?: Record<string, string>;     // 自定义标签
}

/** 鉴权结果 */
export interface IAuthResult {
  valid: boolean;
  tenant_id?: TenantId;
  api_key_meta?: IApiKeyMeta;
  error?: string;
}

// ===== 日志类型 =====

/** 请求日志数据 */
export interface IRequestLog {
  request_id: RequestId;
  tenant_id?: TenantId;
  timestamp: number;
  method: string;
  path: string;
  provider?: string;
  model?: string;
  status_code: number;
  duration_ms: number;
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  error?: string;
}

/** 详细的请求日志（包含请求和响应体） */
export interface IRequestLogDetail extends IRequestLog {
  request_body?: string;
  response_body?: string;
  cost?: number;
}

// ===== 会话日志类型 =====

/** 一轮对话的完整记录 */
export interface IConversationTurn {
  turn_id: string;
  session_id: string;
  timestamp: number;
  request: {
    messages: ChatMessage[];
    tools?: ChatTool[];
    model: string;
  };
  response: {
    content: string;
    reasoning_content?: string;
    tool_calls?: ChatToolCall[];
    tool_results?: ChatMessage[];
    usage?: {
      prompt_tokens?: number;
      completion_tokens?: number;
      total_tokens?: number;
    };
  };
  metadata: {
    provider: string;
    duration_ms: number;
    cost?: number;
    status_code: number;
    tenant_id?: TenantId;
    error?: string;
    /** 客户端信息（通用，不绑定特定客户端） */
    client_info?: {
      name: string;
      version?: string;
      inferred_from: 'header' | 'user-agent' | 'unknown';
    };
    /** 会话标识来源 */
    session_source?: {
      id: string;
      provided_by_header?: string;
    };
    /** 原始 User-Agent 字符串 */
    user_agent?: string;
  };
}

/** 会话元数据 */
export interface ISessionMeta {
  session_id: string;
  created_at: number;
  updated_at: number;
  turn_count: number;
  total_prompt_tokens: number;
  total_completion_tokens: number;
  total_tokens: number;
  total_cost: number;
  tenant_id?: TenantId;
  last_model?: string;
  /** 客户端信息 */
  client_info?: {
    name: string;
    version?: string;
    inferred_from: 'header' | 'user-agent' | 'unknown';
  };
  /** 原始 User-Agent 字符串 */
  user_agent?: string;
}

/** 会话查询过滤条件 */
export interface IConversationFilter {
  start?: number;
  end?: number;
  tenant_id?: string;
  model?: string;
  /** 按客户端名称筛选（如 'opencode', 'cursor', 'vscode'） */
  client?: string;
  /** 按会话 ID 精确筛选 */
  session_id?: string;
  limit?: number;
  offset?: number;
}

// ===== 配置类型 =====

/** 网关配置 */
export interface IGatewayConfig {
  port: number;
  host: string;
  log_level: 'debug' | 'info' | 'warn' | 'error';
  providers: Record<string, IProviderConfig>;
  routing: IRoutingStrategy[];
  auth: {
    enabled?: boolean;
    api_keys?: IApiKeyMeta[];
  };
  rate_limit: {
    enabled?: boolean;
    qps?: number;
    burst?: number;
  };
  cost_control?: {
    monthly_budget?: number;
    warn_threshold?: number;
  };
  failover?: {
    enabled?: boolean;
    failureThreshold?: number;
    successThreshold?: number;
    healthCheckInterval?: number;
    healthCheckTimeout?: number;
    healthCheckModel?: string;
    /** Explicit failover chains: primary -> [fallback1, fallback2, ...] */
    chains?: Record<string, string[]>;
    /** Error-rate threshold (0-1) that triggers provider-level degradation. Default 0.5 */
    errorRateThreshold?: number;
    /** Average-latency threshold (ms) that triggers degradation. Default 30000 */
    latencyThresholdMs?: number;
  };
  loadBalance?: {
    strategy?: 'roundRobin' | 'random';
  };
  /** 缓存配置 */
  cache?: {
    enabled?: boolean;
    ttl?: number; // 毫秒
    max_size?: number;
  };
  /** 语义缓存配置 */
  semantic_cache?: {
    enabled?: boolean;
    threshold?: number;
    backend?: 'memory' | 'redis_vector';
    max_entries?: number;
  };
  /** 请求/响应日志配置 */
  request_logging?: {
    enabled?: boolean;
    max_body_size?: number;
    sample_rate?: number;
  };
  /** 会话日志配置 */
  conversation_logging?: {
    enabled?: boolean;
    max_memory_sessions?: number;
    redis_ttl_days?: number;
    max_turns_per_session?: number;
  };
  /** 限流清理间隔（毫秒） */
  rate_limit_clean_interval?: number;
  /** Token 定价配置 (每 1M tokens 美元价格) */
  pricing?: Record<string, { input: number; output: number }>;
  /** Token 级按模型限流配置 */
  model_rate_limits?: Record<string, { tokens_per_minute: number; burst_tokens?: number }>;
  /** 默认模型名称 */
  default_model?: string;
  /** 模型别名映射 */
  model_aliases?: Record<string, string>;
  /** 跨 Provider 模型等效映射：当 Failover 切换 Provider 时自动重命名 model 字段
   *  key = 请求中的 model 名，value = { provider → 等效 model 名 }
   *  例: { "gpt-4o": { "deepseek": "deepseek-chat", "anthropic": "claude-3-5-sonnet-20241022" } }
   */
  model_equivalents?: Record<string, Record<string, string>>;
  /** 模型降级链：当主模型返回 429/503 时，在同一 Provider 内依次尝试 fallback 模型
   *  key = 请求中的 model 名，value = [fallbackModel1, fallbackModel2, ...]
   *  例: { "gpt-4o": ["gpt-4o-mini", "gpt-3.5-turbo"] }
   */
  model_fallbacks?: Record<string, string[]>;
  /** 模型能力池：用户请求抽象模型名，网关自动选择具体 Provider 和模型 */
  model_pools?: Record<string, IModelPool>;
  /** 动态 Provider 配置 */
  dynamicProviders?: DynamicProviderConfig[];
}

/** 动态 Provider 配置 */
export interface DynamicProviderConfig {
  name: string;
  base_url: string;
  api_key?: string;
  auth_header?: string; // 自定义认证 header 名称
  auth_prefix?: string; // 认证前缀 (Bearer, ApiKey 等)
  endpoints?: {
    chat?: string;
    chat_stream?: string;
    embeddings?: string;
    models?: string;
  };
  capabilities?: Partial<IProviderCapabilities>;
}

// ===== 错误类型 =====

/** Gateway 错误类型 */
export type GatewayErrorType =
  | 'invalid_request_error'
  | 'authentication_error'
  | 'rate_limit_error'
  | 'provider_error'
  | 'internal_error';