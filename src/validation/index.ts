/**
 * Zod 校验层
 * 所有 API 请求体的运行时校验
 */
import { z } from 'zod';

// ===== Chat Message Schema =====

const chatContentPartSchema = z.object({
  type: z.enum(['text', 'image_url']),
  text: z.string().optional(),
  image_url: z.object({
    url: z.string(),
    detail: z.enum(['low', 'high', 'auto']).optional(),
  }).optional(),
});

const chatMessageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant', 'tool']),
  content: z.union([z.string(), z.array(chatContentPartSchema).min(1)]).optional().default(''),
  name: z.string().optional(),
  tool_call_id: z.string().optional(),
  tool_calls: z.array(z.object({
    id: z.string(),
    type: z.literal('function'),
    function: z.object({
      name: z.string(),
      arguments: z.string(),
    }),
  })).optional(),
});

const chatToolSchema = z.object({
  type: z.literal('function'),
  function: z.object({
    name: z.string().min(1),
    description: z.string(),
    parameters: z.record(z.unknown()),
  }),
});

const chatToolChoiceSchema = z.union([
  z.enum(['none', 'auto', 'required']),
  z.object({
    type: z.literal('function'),
    function: z.object({ name: z.string().min(1) }),
  }),
]);

// ===== Chat Completion Request =====

export const chatCompletionRequestSchema = z.object({
  model: z.string().optional(),
  messages: z.array(chatMessageSchema).min(1, 'messages must contain at least 1 message').optional(),
  template_id: z.string().optional(),
  template_variables: z.record(z.string()).optional(),
  temperature: z.number().min(0).max(2).optional(),
  top_p: z.number().min(0).max(1).optional(),
  max_tokens: z.number().int().positive().optional(),
  stream: z.boolean().optional(),
  stop: z.union([z.string(), z.array(z.string())]).optional(),
  presence_penalty: z.number().min(-2).max(2).optional(),
  frequency_penalty: z.number().min(-2).max(2).optional(),
  user: z.string().optional(),
  tools: z.array(chatToolSchema).optional(),
  tool_choice: chatToolChoiceSchema.optional(),
}).refine((data) => {
  // 必须提供 messages 或 template_id 之一
  if (!data.messages && !data.template_id) {
    return false;
  }
  return true;
}, {
  message: 'Either messages or template_id must be provided',
  path: ['messages'],
});

// ===== Embedding Request =====

export const embeddingRequestSchema = z.object({
  model: z.string().min(1, 'Missing required field: model'),
  input: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]),
  encoding_format: z.enum(['float', 'base64']).optional(),
  dimensions: z.number().int().positive().optional(),
});

// ===== Tenant Config (for admin API) =====

export const tenantSettingsSchema = z.object({
  default_provider: z.string().optional(),
  allowed_providers: z.array(z.string()).optional(),
  allowed_models: z.array(z.string()).optional(),
  webhook_url: z.string().url().optional(),
  notification_email: z.string().email().optional(),
});

export const tenantLimitsSchema = z.object({
  daily_requests: z.number().int().positive(),
  daily_tokens: z.number().int().positive(),
  max_api_keys: z.number().int().positive(),
  concurrent_requests: z.number().int().positive(),
});

export const tenantConfigSchema = z.object({
  name: z.string().min(1),
  status: z.enum(['active', 'suspended', 'trial']),
  plan: z.enum(['free', 'pro', 'enterprise']),
  settings: tenantSettingsSchema.optional(),
  limits: tenantLimitsSchema.optional(),
});

export const tenantUpdateSchema = z.object({
  name: z.string().min(1).optional(),
  status: z.enum(['active', 'suspended', 'trial']).optional(),
  plan: z.enum(['free', 'pro', 'enterprise']).optional(),
  settings: tenantSettingsSchema.optional(),
  limits: tenantLimitsSchema.optional(),
});

export const createApiKeySchema = z.object({
  name: z.string().min(1, 'API key name is required'),
  expires_at: z.number().int().positive().optional(),
  allowed_models: z.array(z.string()).optional(),
  default_model: z.string().optional(),
  rate_limit_qps: z.number().positive().optional(),
  rate_limit_burst: z.number().positive().optional(),
  monthly_budget: z.number().positive().optional(),
  max_tokens_per_request: z.number().int().positive().optional(),
  metadata: z.record(z.string()).optional(),
  billing_mode: z.enum(['competition', 'subscription', 'prepaid']).optional(),
  balance: z.number().int().nonnegative().optional(),
  subscription_expires_at: z.number().int().positive().optional(),
});

export const updateKeyPolicySchema = z.object({
  name: z.string().min(1).optional(),
  expires_at: z.number().int().positive().optional(),
  allowed_models: z.array(z.string()).optional(),
  default_model: z.string().optional(),
  rate_limit_qps: z.number().positive().optional(),
  rate_limit_burst: z.number().positive().optional(),
  monthly_budget: z.number().positive().optional(),
  max_tokens_per_request: z.number().int().positive().optional(),
  metadata: z.record(z.string()).optional(),
  billing_mode: z.enum(['competition', 'subscription', 'prepaid']).optional(),
  balance: z.number().int().nonnegative().optional(),
  subscription_expires_at: z.number().int().positive().optional(),
});

// ===== Tenant Template =====

export const tenantTemplateSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  is_default: z.boolean().optional(),
  tenant: z.object({
    plan: z.enum(['free', 'pro', 'enterprise']),
    status: z.enum(['active', 'suspended', 'trial']),
    settings: tenantSettingsSchema.optional(),
    limits: tenantLimitsSchema.optional(),
  }),
  default_key: createApiKeySchema.extend({
    name: z.string().min(1),
  }).optional(),
});

export const tenantTemplateUpdateSchema = tenantTemplateSchema.partial().extend({
  name: z.string().min(1).optional(),
});

// ===== Gateway Config Update =====

const providerConfigSchema = z.object({
  provider: z.string(),
  base_url: z.string(),
  api_key: z.string().optional(),
  timeout: z.number().positive().optional(),
  headers: z.record(z.string()).optional(),
  max_retries: z.number().positive().optional(),
});

const routingRuleSchema = z.object({
  name: z.string(),
  rules: z.array(z.object({
    model: z.string(),
    provider: z.string(),
    max_tokens: z.number().positive().optional(),
  })),
  fallback: z.string().optional(),
});

export const configUpdateSchema = z.object({
  port: z.number().int().positive().optional(),
  host: z.string().optional(),
  log_level: z.enum(['debug', 'info', 'warn', 'error']).optional(),
  default_model: z.string().optional(),
  providers: z.record(providerConfigSchema).optional(),
  routing: z.array(routingRuleSchema).optional(),
  auth: z.object({
    enabled: z.boolean().optional(),
    api_keys: z.array(z.object({
      key: z.string(),
      tenant_id: z.string(),
      name: z.string(),
      created_at: z.number(),
    })).optional(),
  }).optional(),
  rate_limit: z.object({
    enabled: z.boolean().optional(),
    qps: z.number().positive().optional(),
    burst: z.number().positive().optional(),
  }).optional(),
  model_rate_limits: z.record(z.object({
    tokens_per_minute: z.number().positive(),
    burst_tokens: z.number().positive().optional(),
  })).optional(),
  failover: z.object({
    enabled: z.boolean().optional(),
    failureThreshold: z.number().positive().optional(),
    successThreshold: z.number().positive().optional(),
    healthCheckInterval: z.number().positive().optional(),
    healthCheckTimeout: z.number().positive().optional(),
    healthCheckModel: z.string().optional(),
    chains: z.record(z.array(z.string())).optional(),
    errorRateThreshold: z.number().optional(),
    latencyThresholdMs: z.number().positive().optional(),
  }).optional(),
  loadBalance: z.object({
    strategy: z.enum(['roundRobin', 'random']).optional(),
  }).optional(),
  cache: z.object({
    enabled: z.boolean().optional(),
    ttl: z.number().positive().optional(),
    max_size: z.number().positive().optional(),
  }).optional(),
  semantic_cache: z.object({
    enabled: z.boolean().optional(),
    threshold: z.number().min(0).max(1).optional(),
    backend: z.enum(['memory', 'redis_vector']).optional(),
    max_entries: z.number().positive().optional(),
  }).optional(),
  request_logging: z.object({
    enabled: z.boolean().optional(),
    max_body_size: z.number().positive().optional(),
    sample_rate: z.number().min(0).max(1).optional(),
  }).optional(),
  conversation_logging: z.object({
    enabled: z.boolean().optional(),
    max_memory_sessions: z.number().positive().optional(),
    redis_ttl_days: z.number().positive().optional(),
    max_turns_per_session: z.number().positive().optional(),
  }).optional(),
  pricing: z.record(z.object({
    input: z.number(),
    output: z.number(),
  })).optional(),
  model_aliases: z.record(z.string()).optional(),
  model_equivalents: z.record(z.record(z.string())).optional(),
  model_pools: z.record(z.object({
    name: z.string(),
    description: z.string().optional(),
    capabilities: z.array(z.string()).optional(),
    candidates: z.array(z.object({
      provider: z.string(),
      model: z.string(),
      priority: z.number(),
      enabled: z.boolean().optional(),
    })),
  })).optional(),
  dynamicProviders: z.array(z.object({
    name: z.string(),
    base_url: z.string(),
    api_key: z.string().optional(),
    auth_header: z.string().optional(),
    auth_prefix: z.string().optional(),
    endpoints: z.object({
      chat: z.string().optional(),
      chat_stream: z.string().optional(),
      embeddings: z.string().optional(),
      models: z.string().optional(),
    }).optional(),
    capabilities: z.record(z.boolean()).optional(),
  })).optional(),
  rate_limit_clean_interval: z.number().positive().optional(),
});

// ===== Prompt Template =====

export const promptTemplateSchema = z.object({
  id: z.string().min(1, 'Template id is required'),
  name: z.string().min(1, 'Template name is required'),
  description: z.string().optional().default(''),
  template: z.string().min(1, 'Template content is required'),
  variables: z.array(z.string()).optional(),
  default_values: z.record(z.string()).optional(),
});

export const promptTemplateUpdateSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  template: z.string().min(1).optional(),
  variables: z.array(z.string()).optional(),
  default_values: z.record(z.string()).optional(),
});

// ===== Alert Rule =====

export const alertRuleSchema = z.object({
  id: z.string().min(1, 'Alert rule id is required'),
  name: z.string().min(1, 'Alert rule name is required'),
  metric: z.enum(['error_rate', 'avg_latency_ms', 'total_requests']),
  threshold: z.number({ required_error: 'threshold is required' }),
  condition: z.enum(['gt', 'lt']).optional().default('gt'),
  webhook_url: z.string().url('webhook_url must be a valid URL'),
  enabled: z.boolean().optional().default(true),
  cooldown_seconds: z.number().int().positive().optional().default(300),
});

// ===== Plugin Register =====

export const pluginRegisterSchema = z.object({
  code: z.string().min(1, 'Plugin code is required'),
});

// ===== Model Aliases =====

export const modelAliasesSchema = z.record(z.string());

// ===== Wallet Recharge =====

export const rechargeSchema = z.object({
  amount: z.number().positive('Recharge amount must be positive'),
  reason: z.string().optional(),
  metadata: z.record(z.string()).optional(),
});
