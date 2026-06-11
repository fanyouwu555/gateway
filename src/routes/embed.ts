/**
 * Embeddings 路由处理
 * POST /v1/embeddings
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import { getProviderForModel, resolveModelAlias } from '../config';
import { createEmbedding, getProvider } from '../providers';
import { embeddingRequestSchema } from '../validation';
import { logError } from '../utils/logger';
import { recordMetric } from '../services/metrics';
import { recordUsage } from '../services/quota';
import { getPricingService } from '../services/pricing';
import { getRequestLogStore } from '../services/request-log';
import { checkQuota, checkKeyQuota } from '../services/quota';
import { getTokenRateLimit } from '../services/token-ratelimit';
import { countCompletionTokens } from '../services/token-counter';

const embedRouter = new Hono();

function checkEmbedKeyPolicies(c: Context, model: string): Response | null {
  const keyAllowedModels = c.get('key_allowed_models') as string[] | undefined;
  const apiKeyMeta = c.get('api_key_meta') as { default_model?: string } | undefined;
  if (keyAllowedModels && keyAllowedModels.length > 0 && !keyAllowedModels.includes(model)) {
    if (apiKeyMeta?.default_model !== model) {
      return c.json(
        {
          error: {
            message: `Model '${model}' is not allowed by this API key. Allowed: ${keyAllowedModels.join(', ')}`,
            type: 'invalid_request_error',
            code: 'model_not_allowed',
          },
        },
        403,
      );
    }
  }

  const keyMonthlyBudget = c.get('key_monthly_budget') as number | undefined;
  if (keyMonthlyBudget !== undefined) {
    const keyHash = c.get('key_hash') as string | undefined;
    if (keyHash) {
      const budgetCheck = checkKeyQuota(keyHash, keyMonthlyBudget);
      if (!budgetCheck.allowed) {
        return c.json(
          {
            error: {
              message: budgetCheck.reason || 'API key monthly budget exceeded',
              type: 'rate_limit_error',
              code: 'budget_exceeded',
            },
          },
          429,
        );
      }
    }
  }
  return null;
}

/**
 * 处理 Embedding 请求
 */
async function handleEmbedding(c: Context): Promise<Response> {
  const providerCallStart = Date.now();

  try {
    const parsed = embeddingRequestSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      const firstError = parsed.error.errors[0];
      return c.json(
        {
          error: {
            message: firstError?.message || 'Invalid request',
            type: 'invalid_request_error',
            code: 'invalid_request',
            param: firstError?.path?.join('.'),
          },
        },
        400
      );
    }

    const request = parsed.data;
    const model = resolveModelAlias(request.model);

    const providerName = getProviderForModel(model);
    if (!providerName) {
      return c.json(
        {
          error: {
            message: `No provider configured for model: ${model}`,
            type: 'invalid_request_error',
            code: 'model_not_found',
            param: 'model',
          },
        },
        400
      );
    }

    c.set('provider', providerName);
    c.set('model', model);

    const tenantId = c.get('tenant_id');

    // Key policy check
    const policyError = checkEmbedKeyPolicies(c, model);
    if (policyError) return policyError;

    // 能力校验：确保 Provider 支持 embeddings
    const provider = getProvider(providerName);
    if (!provider?.capabilities.embed) {
      return c.json(
        {
          error: {
            message: `Model '${model}' does not support embeddings. Please use a model that supports this feature.`,
            type: 'invalid_request_error',
            code: 'capability_mismatch',
            param: 'model',
          },
        },
        400
      );
    }

    // Quota check
    if (tenantId) {
      const quotaCheck = checkQuota(tenantId);
      if (!quotaCheck.allowed) {
        return c.json(
          {
            error: {
              message: quotaCheck.reason || 'Quota exceeded',
              type: 'rate_limit_error',
              code: 'quota_exceeded',
            },
          },
          429,
        );
      }
    }

    // Token rate limit check (pre-request)
    const trl = getTokenRateLimit();
    if (trl) {
      const inputText = Array.isArray(request.input) ? request.input.join(' ') : request.input;
      const estimatedTokens = await countCompletionTokens(inputText, model);
      if (!trl.check(model, estimatedTokens)) {
        return c.json(
          {
            error: {
              message: `Token rate limit exceeded for model '${model}'. Estimated tokens: ${estimatedTokens}`,
              type: 'rate_limit_error',
              code: 'token_rate_limit_exceeded',
            },
          },
          429,
        );
      }
    }

    const response = await createEmbedding(providerName, request);

    const promptTokens = response.usage?.prompt_tokens || 0;
    const totalTokens = response.usage?.total_tokens || 0;

    if (tenantId && response.usage) {
      const cost = getPricingService().calculateCost(model, promptTokens, 0);
      const keyHash = c.get('key_hash') as string | undefined;

      recordUsage(tenantId, totalTokens, cost, keyHash);

      const requestId = c.get('request_id') as string;
      const duration = Date.now() - providerCallStart;
      recordMetric(
        requestId,
        tenantId,
        providerName,
        model,
        duration,
        200,
        {
          prompt_tokens: promptTokens,
          completion_tokens: 0,
          total_tokens: totalTokens,
        },
        keyHash,
        c.get('key_metadata'),
      );
    }

    const totalCost = response.usage ? getPricingService().calculateCost(model, promptTokens, 0) : 0;

    const logStore = getRequestLogStore();
    if (logStore.shouldSample()) {
      const stringBody = JSON.stringify(request);
      const sanitizedBody = stringBody.replace(/"api_key":"[^"]+"/g, '"api_key":"***"');
      logStore.add({
        request_id: c.get('request_id') as string,
        tenant_id: c.get('tenant_id'),
        timestamp: Date.now(),
        method: 'POST',
        path: '/v1/embeddings',
        provider: providerName,
        model,
        status_code: 200,
        duration_ms: Date.now() - providerCallStart,
        prompt_tokens: promptTokens,
        completion_tokens: 0,
        total_tokens: totalTokens,
        request_body: sanitizedBody,
        response_body: JSON.stringify({ usage: response.usage }),
        cost: totalCost,
      });
    }

    c.header('X-Gateway-Cost', totalCost.toFixed(6));
    return c.json(response, 200);
  } catch (error) {
    const err = error instanceof Error ? error : new Error('Unknown error');
    logError(c.get('request_id'), err, { component: 'embed' });

    const tenantId = c.get('tenant_id');
    const providerName = c.get('provider') as string | undefined;
    if (tenantId && providerName) {
      const model = c.get('model') as string;
      const duration = Date.now() - providerCallStart;
      recordMetric(
        c.get('request_id') as string,
        tenantId,
        providerName,
        model,
        duration,
        500,
        {
          prompt_tokens: 0,
          completion_tokens: 0,
          total_tokens: 0,
        },
        c.get('key_hash'),
        c.get('key_metadata'),
      );
    }

    return c.json(
      {
        error: {
          message: err.message,
          type: 'provider_error',
          code: 'provider_request_failed',
        },
      },
      500
    );
  }
}

embedRouter.post('/v1/embeddings', handleEmbedding);

export default embedRouter;