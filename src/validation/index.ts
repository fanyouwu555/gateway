/**
 * Zod 校验层
 * 所有 API 请求体的运行时校验
 */
import { z } from 'zod';

// ===== Chat Message Schema =====

const chatMessageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant']),
  content: z.string().min(1),
  name: z.string().optional(),
});

const chatToolSchema = z.object({
  type: z.literal('function'),
  function: z.object({
    name: z.string().min(1),
    description: z.string(),
    parameters: z.record(z.unknown()),
  }),
});

const chatToolChoiceSchema = z.object({
  type: z.literal('function'),
  function: z.object({ name: z.string().min(1) }),
});

// ===== Chat Completion Request =====

export const chatCompletionRequestSchema = z.object({
  model: z.string().min(1, 'Missing required field: model'),
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

export const tenantConfigSchema = z.object({
  name: z.string().min(1),
  status: z.enum(['active', 'suspended', 'trial']),
  plan: z.enum(['free', 'pro', 'enterprise']),
  settings: z.object({
    default_provider: z.string().optional(),
    allowed_providers: z.array(z.string()).optional(),
    allowed_models: z.array(z.string()).optional(),
    webhook_url: z.string().url().optional(),
    notification_email: z.string().email().optional(),
  }).optional(),
  limits: z.object({
    daily_requests: z.number().int().positive(),
    daily_tokens: z.number().int().positive(),
    monthly_cost: z.number().positive(),
    max_api_keys: z.number().int().positive(),
    concurrent_requests: z.number().int().positive(),
  }).optional(),
});

export const tenantUpdateSchema = z.object({
  name: z.string().min(1).optional(),
  status: z.enum(['active', 'suspended', 'trial']).optional(),
  plan: z.enum(['free', 'pro', 'enterprise']).optional(),
  settings: z.object({
    default_provider: z.string().optional(),
    allowed_providers: z.array(z.string()).optional(),
    allowed_models: z.array(z.string()).optional(),
    webhook_url: z.string().url().optional(),
    notification_email: z.string().email().optional(),
  }).optional(),
  limits: z.object({
    daily_requests: z.number().int().positive(),
    daily_tokens: z.number().int().positive(),
    monthly_cost: z.number().positive(),
    max_api_keys: z.number().int().positive(),
    concurrent_requests: z.number().int().positive(),
  }).optional(),
});

export const createApiKeySchema = z.object({
  name: z.string().min(1, 'API key name is required'),
  expires_at: z.number().int().positive().optional(),
  allowed_models: z.array(z.string()).optional(),
  rate_limit_qps: z.number().positive().optional(),
  rate_limit_burst: z.number().positive().optional(),
  monthly_budget: z.number().positive().optional(),
  max_tokens_per_request: z.number().int().positive().optional(),
  metadata: z.record(z.string()).optional(),
});

export const updateKeyPolicySchema = z.object({
  name: z.string().min(1).optional(),
  expires_at: z.number().int().positive().optional(),
  allowed_models: z.array(z.string()).optional(),
  rate_limit_qps: z.number().positive().optional(),
  rate_limit_burst: z.number().positive().optional(),
  monthly_budget: z.number().positive().optional(),
  max_tokens_per_request: z.number().int().positive().optional(),
  metadata: z.record(z.string()).optional(),
});

// ===== Gateway Config Update =====

export const configUpdateSchema = z.object({
  port: z.number().int().positive().optional(),
  host: z.string().optional(),
  log_level: z.enum(['debug', 'info', 'warn', 'error']).optional(),
  providers: z.record(z.object({
    provider: z.string(),
    base_url: z.string(),
    api_key: z.string().optional(),
    timeout: z.number().positive().optional(),
    headers: z.record(z.string()).optional(),
    max_retries: z.number().positive().optional(),
  })).optional(),
  routing: z.array(z.object({
    name: z.string(),
    rules: z.array(z.object({
      model: z.string(),
      provider: z.string(),
      max_tokens: z.number().positive().optional(),
    })),
    fallback: z.string().optional(),
  })).optional(),
  auth: z.object({
    enabled: z.boolean(),
    api_keys: z.array(z.object({
      key: z.string(),
      tenant_id: z.string(),
      name: z.string(),
      created_at: z.number(),
    })).optional(),
  }).optional(),
  rate_limit: z.object({
    enabled: z.boolean(),
    qps: z.number().positive(),
    burst: z.number().positive(),
  }).optional(),
  failover: z.object({
    enabled: z.boolean(),
    failureThreshold: z.number().positive(),
    successThreshold: z.number().positive(),
    healthCheckInterval: z.number().positive(),
    healthCheckTimeout: z.number().positive().optional(),
    healthCheckModel: z.string().optional(),
    chains: z.record(z.array(z.string())).optional(),
    errorRateThreshold: z.number().optional(),
    latencyThresholdMs: z.number().positive().optional(),
  }).optional(),
  cache: z.object({
    enabled: z.boolean(),
    ttl: z.number().positive(),
    max_size: z.number().positive(),
  }).optional(),
  pricing: z.record(z.object({
    input: z.number(),
    output: z.number(),
  })).optional(),
  model_aliases: z.record(z.string()).optional(),
});
