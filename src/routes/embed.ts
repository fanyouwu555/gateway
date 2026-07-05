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
import { recordKeyCost } from '../services/billing';
import { getPricingService } from '../services/pricing';
import { getRequestLogStore } from '../services/request-log';
import { checkQuota } from '../services/quota';
import { getTokenRateLimit } from '../services/token-ratelimit';
import { countCompletionTokens } from '../services/token-counter';
import { deductBalance } from '../services/wallet';
import type { IApiKeyMeta } from '../types';

const embedRouter = new Hono();

async function checkEmbedKeyPolicies(c: Context, model: string): Promise<Response | null> {
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

  // 统一计费检查
  const billingMode = c.get('key_billing_mode') as IApiKeyMeta['billing_mode'];
  const keyHash = c.get('key_hash') as string | undefined;
  if (keyHash) {
    const { checkBilling } = await import('../services/billing');
    const billingCheck = checkBilling(
      keyHash,
      billingMode,
      c.get('key_monthly_budget'),
      c.get('key_subscription_expires_at')
    );
    if (!billingCheck.allowed) {
      const statusCode = billingCheck.code === 'subscription_expired' ? 403 : 402;
      const errorType = billingCheck.code === 'subscription_expired' ? 'authentication_error' : 'rate_limit_error';
      const code = billingCheck.code || 'insufficient_balance';
      return c.json(
        {
          error: {
            message: billingCheck.reason || 'Billing check failed',
            type: errorType,
            code,
          },
        },
        statusCode,
      );
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
    const policyError = await checkEmbedKeyPolicies(c, model);
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

    // 配额检查（日请求/日Token，所有模式都生效）
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

    let remainingBalanceMicroYuan: number | undefined;
    if (tenantId && response.usage) {
      const cost = getPricingService().calculateCost(model, promptTokens, 0);
      const keyHash = c.get('key_hash') as string | undefined;

      recordUsage(tenantId, totalTokens);
      recordKeyCost(keyHash || '', cost);

      // 预付模式扣费
      const billingMode = c.get('key_billing_mode') as IApiKeyMeta['billing_mode'];
      if (billingMode === 'prepaid' && keyHash) {
        const costMicroYuan = Math.ceil(cost * 1_000_000);
        const deductResult = deductBalance(keyHash, costMicroYuan, {
          request_id: c.get('request_id') as string,
          model,
          provider: providerName,
        });
        remainingBalanceMicroYuan = deductResult.newBalance;
      }

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
    if (remainingBalanceMicroYuan !== undefined) {
      c.header('X-Remaining-Balance-Micro-Yuan', remainingBalanceMicroYuan.toString());
    }
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