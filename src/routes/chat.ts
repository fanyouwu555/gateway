/**
 * Chat Completions 路由处理
 * POST /v1/chat/completions
 *
 * 完整请求链路：
 *   校验 → Guardrail → 请求插件 → 智能路由 → Provider（带Failover）→ 响应插件 → 返回
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import { chatComplete, chatCompleteStream } from '../providers';
import { chatCompletionRequestSchema } from '../validation';
import { writeLog } from '../utils/logger';
import { recordLatency, recordError } from '../services/router';
import { runGuardrailPlugins, runRequestPlugins, runResponsePlugins, runTransformPlugins } from '../plugins';
import { resolveRequestModel, resolveProviderForRequest } from '../services/chat-pipeline';
import { getCache, setCache, getLastCacheHitType } from '../services/cache';
import { getConfig } from '../config';
import { templateToMessages } from '../services/prompt';
import { checkQuota, recordUsage } from '../services/quota';
import { recordKeyCost } from '../services/billing';
import { createChildSpan, endSpan } from '../utils/tracing';
import { recordAiTtfb, recordAiTpot, recordAiCost, recordAiTokens } from '../middleware/metrics';
import { recordMetric } from '../services/metrics';
import { getPricingService } from '../services/pricing';
import { countCompletionTokens, countPromptTokens } from '../services/token-counter';
import { processSSEStream } from '../services/stream-processor';
import { getTokenRateLimit } from '../services/token-ratelimit';
import { deductBalance } from '../services/wallet';
import { getRequestLogStore } from '../services/request-log';
import { getConversationLogService } from '../services/conversation-log';
import type { ChatMessage, ChatCompletionRequest, IApiKeyMeta } from '../types';
import type { Span } from '@opentelemetry/api';
import { extractClientInfo } from '../utils/client-info';
import { inferRequirements, getModelCapabilities, checkCapabilityMatch, formatCapabilityError } from '../services/model-capability';
import { getProvider } from '../providers';
import { GatewayError } from '../middleware/error';

const chatRouter = new Hono();

async function checkKeyPolicies(c: Context, req: ChatCompletionRequest, tenantId: string | undefined): Promise<Response | null> {
  const keyAllowedModels = c.get('key_allowed_models') as string[] | undefined;
  const apiKeyMeta = c.get('api_key_meta') as { default_model?: string } | undefined;
  if (keyAllowedModels && keyAllowedModels.length > 0 && !keyAllowedModels.includes(req.model)) {
    if (apiKeyMeta?.default_model !== req.model) {
      recordMetric(
        c.get('request_id') as string,
        tenantId,
        'gateway',
        req.model,
        0,
        403,
        { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        c.get('key_hash'),
        c.get('key_metadata'),
      );
      return c.json({
        error: {
          message: `Model '${req.model}' is not allowed by this API key. Allowed: ${keyAllowedModels.join(', ')}`,
          type: 'invalid_request_error',
          code: 'model_not_allowed',
        },
      }, 403);
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
      const code = billingCheck.code || 'insufficient_balance';
      recordMetric(
        c.get('request_id') as string,
        tenantId,
        'gateway',
        req.model,
        0,
        402,
        { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        keyHash,
        c.get('key_metadata'),
      );
      throw GatewayError.billingError(billingCheck.reason || 'Billing check failed', code);
    }
  }

  const keyMaxTokens = c.get('key_max_tokens_per_request') as number | undefined;
  if (keyMaxTokens !== undefined && (req.max_tokens === undefined || req.max_tokens > keyMaxTokens)) {
    req.max_tokens = keyMaxTokens;
  }

  return null;
}

async function checkCaches(
  c: Context,
  req: ChatCompletionRequest,
  tenantId: string | undefined,
  config: ReturnType<typeof getConfig>,
  rootSpan: Span | null,
): Promise<Response | null> {
  const cacheSpan = createChildSpan(rootSpan, 'cache_lookup');
  if ((config.cache?.enabled || config.semantic_cache?.enabled) && !req.stream) {
    const cached = await getCache(req, tenantId);
    if (cached) {
      const hitType = getLastCacheHitType();
      const metricProvider = hitType === 'semantic' ? 'semantic_cache' : 'cache';
      writeLog('debug', 'Cache hit', { model: req.model, hitType });
      c.set('cache_hit', true);

      // 缓存命中后补执行响应插件，确保命中与未命中的行为一致
      let cachedResp = JSON.parse(cached) as import('../types').ChatCompletionResponse;
      cachedResp = await runResponsePlugins(c, cachedResp);

      endSpan(cacheSpan);
      const promptTokens = cachedResp.usage?.prompt_tokens || 0;
      const completionTokens = cachedResp.usage?.completion_tokens || 0;
      const totalTokens = cachedResp.usage?.total_tokens || 0;
      if (cachedResp.usage) {
        c.set('prompt_tokens', promptTokens);
        c.set('completion_tokens', completionTokens);
        c.set('total_tokens', totalTokens);
      }
      recordMetric(
        c.get('request_id') as string,
        tenantId,
        metricProvider,
        req.model,
        0,
        200,
        { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: totalTokens },
        c.get('key_hash'),
        c.get('key_metadata'),
      );
      const cacheCost = getPricingService().calculateCost(req.model, promptTokens, completionTokens);
      c.header('X-Gateway-Cost', cacheCost.toFixed(6));
      return c.json(cachedResp, 200);
    }
  }
  endSpan(cacheSpan);

  return null;
}

async function runPreProviderPipeline(
  c: Context,
  req: ChatCompletionRequest,
  tenantId: string | undefined,
  rootSpan: Span | null,
): Promise<ChatCompletionRequest | Response> {
  const guardrailSpan = createChildSpan(rootSpan, 'guardrail_check');
  const guardrailResult = await runGuardrailPlugins(c, req);
  endSpan(guardrailSpan);
  if (!guardrailResult.allowed) {
    recordMetric(
      c.get('request_id') as string,
      tenantId,
      'gateway',
      req.model,
      0,
      400,
      { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      c.get('key_hash'),
      c.get('key_metadata'),
    );
    return c.json(
      {
        error: {
          message: guardrailResult.reasons?.join('; ') || 'Request blocked by guardrail',
          type: 'invalid_request_error',
          code: 'guardrail_blocked',
        },
      },
      400
    );
  }

  const transformedReq = await runTransformPlugins(c, req) as typeof req;

  // 配额检查（日请求/日Token，所有模式都生效）
  if (tenantId) {
    const quotaCheck = checkQuota(tenantId);
    if (!quotaCheck.allowed) {
      recordMetric(
        c.get('request_id') as string,
        tenantId,
        'gateway',
        transformedReq.model,
        0,
        429,
        { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        c.get('key_hash'),
        c.get('key_metadata'),
      );
      return c.json(
        {
          error: {
            message: quotaCheck.reason || 'Quota exceeded',
            type: 'rate_limit_error',
            code: 'quota_exceeded',
          },
        },
        429
      );
    }
  }

  return await runRequestPlugins(c, transformedReq);
}

async function handleStreamingResponse(
  c: Context,
  processedReq: ChatCompletionRequest,
  providerName: string,
  rootSpan: Span | null,
  sessionId: string,
  sessionSource: { id: string; providedByHeader?: string },
): Promise<Response> {
  const model = processedReq.model;
  const providerSpan = createChildSpan(rootSpan, 'provider_call');
  const providerCallStart = Date.now();

  const streamResponse = await chatCompleteStream(providerName, processedReq);
  recordLatency(providerName, Date.now() - providerCallStart);

  const requestId = c.get('request_id') as string;
  const promptTokens = await countPromptTokens(
    processedReq.messages as ChatMessage[],
    model,
  );
  c.set('prompt_tokens', promptTokens);

  const reader = streamResponse.getReader();
  const streamStart = Date.now();
  let streamCancelled = false;
  const abortController = new AbortController();

  const wrappedStream = new ReadableStream({
    async start(controller) {
      try {
        const result = await processSSEStream(reader, {
          onChunk: (chunk) => {
            controller.enqueue(new TextEncoder().encode('data: ' + JSON.stringify(chunk) + '\n\n'));
          },
          signal: abortController.signal,
        });

        if (streamCancelled) {
          controller.close();
          return;
        }

        const accumulatedContent = result.content;
        const accumulatedReasoning = result.reasoningContent;
        const accumulatedToolCalls = result.toolCalls || [];

        const completionTokens = await countCompletionTokens(accumulatedContent + accumulatedReasoning, model);
        const totalTokens = promptTokens + completionTokens;
        c.set('completion_tokens', completionTokens);
        c.set('total_tokens', totalTokens);

        recordAiTokens(promptTokens, completionTokens, providerName, model);

        const cost = getPricingService().calculateCost(model, promptTokens, completionTokens);

        const tenantId = c.get('tenant_id');
        const keyHash = c.get('key_hash') as string | undefined;
        if (tenantId) {
          await recordUsage(tenantId, totalTokens);
          await recordKeyCost(keyHash || '', cost);
          recordAiCost(cost, providerName, model);
        }

        // 预付模式扣费
        const billingMode = c.get('key_billing_mode') as IApiKeyMeta['billing_mode'];
        let remainingBalanceMicroYuan: number | undefined;
        if (billingMode === 'prepaid' && keyHash) {
          const costMicroYuan = Math.ceil(cost * 1_000_000);
          const deductResult = await deductBalance(keyHash, costMicroYuan, {
            request_id: requestId,
            model,
            provider: providerName,
          });
          remainingBalanceMicroYuan = deductResult.newBalance;
          if (!deductResult.success) {
            writeLog('warn', 'Prepaid overdraft in streaming', {
              key_hash: keyHash,
              cost_micro_yuan: costMicroYuan,
              new_balance: deductResult.newBalance,
            });
          }
        }

        const trl = getTokenRateLimit();
        if (trl) {
          trl.consume(model, totalTokens);
        }

        const duration = Date.now() - streamStart;
        recordMetric(
          requestId,
          c.get('tenant_id'),
          providerName,
          model,
          duration,
          200,
          { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: totalTokens },
          c.get('key_hash'),
          c.get('key_metadata'),
        );

        const logStore = getRequestLogStore();
        if (logStore.shouldSample()) {
          const stringBody = JSON.stringify(processedReq);
          const sanitizedBody = stringBody.replace(/"api_key":"[^"]+"/g, '"api_key":"***"');
          logStore.add({
            request_id: requestId,
            tenant_id: c.get('tenant_id'),
            timestamp: Date.now(),
            method: 'POST',
            path: '/v1/chat/completions',
            provider: providerName,
            model,
            status_code: 200,
            duration_ms: duration,
            prompt_tokens: promptTokens,
            completion_tokens: completionTokens,
            total_tokens: totalTokens,
            request_body: sanitizedBody,
            response_body: JSON.stringify({ stream: true, usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: totalTokens } }),
            cost,
          });
        }

        const conversationLogService = getConversationLogService();
        const streamTurn: import('../types').IConversationTurn = {
          turn_id: requestId,
          session_id: sessionId,
          timestamp: Date.now(),
          request: {
            messages: processedReq.messages as import('../types').ChatMessage[],
            tools: processedReq.tools,
            model,
          },
          response: {
            content: accumulatedContent,
            reasoning_content: accumulatedReasoning || undefined,
            tool_calls: accumulatedToolCalls.length > 0 ? accumulatedToolCalls : undefined,
            usage: {
              prompt_tokens: promptTokens,
              completion_tokens: completionTokens,
              total_tokens: totalTokens,
            },
          },
          metadata: {
            provider: providerName,
            duration_ms: duration,
            cost,
            status_code: 200,
            tenant_id: c.get('tenant_id'),
            client_info: c.get('client_info'),
            session_source: { id: sessionId, provided_by_header: sessionSource.providedByHeader },
            user_agent: c.get('user_agent'),
          },
        };
        conversationLogService.saveTurn(streamTurn).catch(() => {});

        const usageChunk = {
          id: c.get('request_id') || '',
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [] as Array<Record<string, unknown>>,
          usage: {
            prompt_tokens: promptTokens,
            completion_tokens: completionTokens,
            total_tokens: totalTokens,
            cost,
            ...(remainingBalanceMicroYuan !== undefined ? { balance_micro_yuan: remainingBalanceMicroYuan } : {}),
          },
        };
        controller.enqueue(new TextEncoder().encode('data: ' + JSON.stringify(usageChunk) + '\n\n'));
        controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
        controller.close();
      } catch (err) {
        if (!streamCancelled) {
          controller.error(err instanceof Error ? err : new Error(String(err)));
        }
      }
    },
    cancel() {
      streamCancelled = true;
      abortController.abort();
    },
  });

  endSpan(providerSpan);

  c.header('X-Session-Id', sessionId);
  c.header('X-Actual-Provider', providerName);
  c.header('X-Actual-Model', processedReq.model);
  const poolModelStream = c.get('pool_model') as string | undefined;
  if (poolModelStream) {
    c.header('X-Model-Pool', poolModelStream);
  }
  return new Response(wrappedStream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}

async function handleNonStreamingResponse(
  c: Context,
  processedReq: ChatCompletionRequest,
  providerName: string,
  providerCallStart: number,
  rootSpan: Span | null,
  sessionId: string,
  sessionSource: { id: string; providedByHeader?: string },
  config: ReturnType<typeof getConfig>,
  req: ChatCompletionRequest,
): Promise<Response> {
  const model = processedReq.model;
  const tenantId = c.get('tenant_id');
  const providerSpan = createChildSpan(rootSpan, 'provider_call');
  const poolModel = c.get('pool_model') as string | undefined;

  let response = await chatComplete(providerName, processedReq, poolModel);
  const providerCallEnd = Date.now();
  const ttfbMs = providerCallEnd - providerCallStart;
  endSpan(providerSpan);

  recordAiTtfb(ttfbMs, providerName, model);
  recordLatency(providerName, ttfbMs);

  // 在响应插件处理前缓存原始 provider 响应，确保缓存内容与插件无关
  if ((config.cache?.enabled || config.semantic_cache?.enabled) && !req.stream) {
    setCache(req, JSON.stringify(response), tenantId).catch((err) => {
      writeLog('warn', 'Failed to cache response', { error: err instanceof Error ? err.message : String(err) });
    });
  }

  response = await runResponsePlugins(c, response);

  if (response.usage) {
    const promptTokens = response.usage.prompt_tokens || 0;
    const completionTokens = response.usage.completion_tokens || 0;
    const totalTokens = response.usage.total_tokens || promptTokens + completionTokens;
    c.set('prompt_tokens', promptTokens);
    c.set('completion_tokens', completionTokens);
    c.set('total_tokens', totalTokens);

    recordAiTokens(promptTokens, completionTokens, providerName, model);

    if (completionTokens > 0) {
      const tpotMs = ttfbMs / completionTokens;
      recordAiTpot(tpotMs, providerName, model);
    }
  }

  const usageSpan = createChildSpan(rootSpan, 'usage_record');
  let remainingBalanceMicroYuan: number | undefined;
  if (tenantId && response.usage) {
    const cost = getPricingService().calculateCost(processedReq.model, response.usage.prompt_tokens || 0, response.usage.completion_tokens || 0);
    const keyHash = c.get('key_hash') as string | undefined;
    await recordUsage(tenantId, response.usage.total_tokens || 0);
    await recordKeyCost(keyHash || '', cost);

    recordAiCost(cost, providerName, model);

    // 预付模式扣费
    const billingMode = c.get('key_billing_mode') as IApiKeyMeta['billing_mode'];
    if (billingMode === 'prepaid' && keyHash) {
      const { deductBalance } = await import('../services/wallet');
      const costMicroYuan = Math.ceil(cost * 1_000_000);
      const deductResult = await deductBalance(keyHash, costMicroYuan, {
        request_id: c.get('request_id') as string,
        model,
        provider: providerName,
      });
      remainingBalanceMicroYuan = deductResult.newBalance;
      if (!deductResult.success) {
        writeLog('warn', 'Prepaid overdraft in non-streaming', {
          key_hash: keyHash,
          cost_micro_yuan: costMicroYuan,
          new_balance: deductResult.newBalance,
        });
      }
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
        prompt_tokens: response.usage.prompt_tokens || 0,
        completion_tokens: response.usage.completion_tokens || 0,
        total_tokens: response.usage.total_tokens || 0,
      },
      keyHash,
      c.get('key_metadata'),
    );
  }
  endSpan(usageSpan);

  const totalCost = response.usage ? getPricingService().calculateCost(model, response.usage.prompt_tokens || 0, response.usage.completion_tokens || 0) : 0;

  const conversationLogService = getConversationLogService();
  const content = response.choices[0]?.message?.content;
  const turn: import('../types').IConversationTurn = {
    turn_id: c.get('request_id') as string,
    session_id: sessionId,
    timestamp: Date.now(),
    request: {
      messages: processedReq.messages as import('../types').ChatMessage[],
      tools: processedReq.tools,
      model,
    },
    response: {
      content: typeof content === 'string' ? content : JSON.stringify(content || ''),
      reasoning_content: response.choices[0]?.message?.reasoning_content,
      tool_calls: response.choices[0]?.message?.tool_calls,
      usage: {
        prompt_tokens: response.usage?.prompt_tokens || 0,
        completion_tokens: response.usage?.completion_tokens || 0,
        total_tokens: response.usage?.total_tokens || 0,
      },
    },
    metadata: {
      provider: providerName,
      duration_ms: Date.now() - providerCallStart,
      cost: totalCost,
      status_code: 200,
      tenant_id: c.get('tenant_id'),
      client_info: c.get('client_info'),
      session_source: { id: sessionId, provided_by_header: sessionSource.providedByHeader },
      user_agent: c.get('user_agent'),
    },
  };
  conversationLogService.saveTurn(turn).catch(() => {});

  if (response.usage) {
    const trl = getTokenRateLimit();
    if (trl) {
      trl.consume(model, response.usage.total_tokens || 0);
    }
  }

  const logStore = getRequestLogStore();
  if (logStore.shouldSample()) {
    const stringBody = JSON.stringify(processedReq);
    const sanitizedBody = stringBody.replace(/"api_key":"[^"]+"/g, '"api_key":"***"');
    const cost = response.usage ? getPricingService().calculateCost(model, response.usage.prompt_tokens || 0, response.usage.completion_tokens || 0) : 0;
    logStore.add({
      request_id: c.get('request_id') as string,
      tenant_id: c.get('tenant_id'),
      timestamp: Date.now(),
      method: 'POST',
      path: '/v1/chat/completions',
      provider: providerName,
      model,
      status_code: 200,
      duration_ms: Date.now() - providerCallStart,
      prompt_tokens: response.usage?.prompt_tokens || 0,
      completion_tokens: response.usage?.completion_tokens || 0,
      total_tokens: response.usage?.total_tokens || 0,
      request_body: sanitizedBody,
      response_body: JSON.stringify({ usage: response.usage }),
      cost,
    });
  }

  c.header('X-Gateway-Cost', totalCost.toFixed(6));
  if (remainingBalanceMicroYuan !== undefined) {
    c.header('X-Remaining-Balance-Micro-Yuan', remainingBalanceMicroYuan.toString());
  }
  c.header('X-Session-Id', sessionId);
  c.header('X-Actual-Provider', providerName);
  c.header('X-Actual-Model', processedReq.model);
  const poolModelNonStream = c.get('pool_model') as string | undefined;
  if (poolModelNonStream) {
    c.header('X-Model-Pool', poolModelNonStream);
  }
  return c.json(response, 200);
}

function handleError(
  c: Context,
  error: unknown,
  sessionId: string,
  sessionSource: { id: string; providedByHeader?: string },
  providerCallStart: number,
): Response {
  if (error instanceof GatewayError) {
    throw error;
  }

  const err = error instanceof Error ? error : new Error('Unknown error');
  writeLog('error', 'Chat completion error', {
    request_id: c.get('request_id'),
    error: err.message,
    code: err.constructor.name,
  });

  const failedProvider = c.get('provider') as string | undefined;
  if (failedProvider) {
    recordLatency(failedProvider, Date.now() - providerCallStart);
    recordError(failedProvider);
  }

  if (sessionId) {
    const conversationLogService = getConversationLogService();
    const errorTurn: import('../types').IConversationTurn = {
      turn_id: c.get('request_id') as string,
      session_id: sessionId,
      timestamp: Date.now(),
      request: {
        messages: [],
        model: c.get('model') || 'unknown',
      },
      response: {
        content: '',
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      },
      metadata: {
        provider: c.get('provider') || 'gateway',
        duration_ms: 0,
        cost: 0,
        status_code: err instanceof SyntaxError ? 400 : 500,
        tenant_id: c.get('tenant_id'),
        error: err.message,
        client_info: c.get('client_info'),
        session_source: { id: sessionId, provided_by_header: sessionSource.providedByHeader },
        user_agent: c.get('user_agent'),
      },
    };
    conversationLogService.saveTurn(errorTurn).catch(() => {});
  }

  try {
    const metricRequestId = c.get('request_id') as string;
    if (metricRequestId) {
      recordMetric(
        metricRequestId,
        c.get('tenant_id'),
        c.get('provider') || 'gateway',
        c.get('model') || 'unknown',
        0,
        err instanceof SyntaxError ? 400 : 500,
        { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        c.get('key_hash'),
        c.get('key_metadata'),
      );
    }
  } catch {
    // 静默失败，不影响错误响应
  }

  if (err instanceof SyntaxError) {
    return c.json(
      {
        error: {
          message: 'Invalid JSON in request body',
          type: 'invalid_request_error',
          code: 'invalid_json',
        },
      },
      400
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

/**
 * 处理 Chat Completion 请求
 */
async function handleChatCompletion(c: Context): Promise<Response> {
  const { clientInfo, sessionSource, userAgent } = extractClientInfo(c.req.raw.headers);
  c.set('client_info', clientInfo);
  c.set('user_agent', userAgent);

  const sessionId = sessionSource.id;
  c.set('session_id', sessionId);

  let providerCallStart = 0;
  try {
    const requestBodyText = await c.req.text();

    const parsed = chatCompletionRequestSchema.safeParse(JSON.parse(requestBodyText));
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

    let request = parsed.data;

    if (request.template_id) {
      const templateMessages = templateToMessages(
        request.template_id,
        request.template_variables || {}
      );
      if (!templateMessages) {
        return c.json(
          {
            error: {
              message: `Template not found: ${request.template_id}`,
              type: 'invalid_request_error',
              code: 'unknown_template',
            },
          },
          400
        );
      }
      request = { ...request, messages: templateMessages };
    }

    const apiKeyMeta = c.get('api_key_meta') as { default_model?: string } | undefined;
    request = resolveRequestModel(request as unknown as import('../types').ChatCompletionRequest, apiKeyMeta, getConfig().routing[0]?.rules[0]?.model);
    const req = request as unknown as ChatCompletionRequest;
    const tenantId = c.get('tenant_id');

    const policyError = await checkKeyPolicies(c, req, tenantId);
    if (policyError) return policyError;

    const rootSpan = c.get('span');
    const config = getConfig();

    const cachedResponse = await checkCaches(c, req, tenantId, config, rootSpan);
    if (cachedResponse) return cachedResponse;

    const pipelineResult = await runPreProviderPipeline(c, req, tenantId, rootSpan);
    if (pipelineResult instanceof Response) return pipelineResult;
    const processedReq = pipelineResult;

    const strategyHeader = c.req.header('x-routing-strategy') as import('../services/router').RouterStrategy | undefined;
    const requestHeaders = Object.fromEntries(
      Object.entries(c.req.header() || {}).map(([k, v]) => [k.toLowerCase(), v || ''])
    );
    const providerResult = resolveProviderForRequest(processedReq, strategyHeader, tenantId, requestHeaders);
    if ('error' in providerResult) {
      recordMetric(
        c.get('request_id') as string,
        tenantId,
        'gateway',
        processedReq.model,
        0,
        400,
        { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        c.get('key_hash'),
        c.get('key_metadata'),
      );
      return c.json({ error: providerResult.error }, 400);
    }
    const { provider: providerName, actualModel } = providerResult;

    // 如果模型池解析出了不同的实际模型，更新请求
    const providerReq = actualModel !== processedReq.model
      ? { ...processedReq, model: actualModel }
      : processedReq;

    c.set('provider', providerName);
    c.set('model', providerReq.model);
    c.set('pool_model', processedReq.model); // 保存原始模型池名称

    // 能力校验：确保目标模型支持请求所需的能力
    const requirements = inferRequirements(providerReq);
    let modelCaps = getModelCapabilities(providerReq.model);
    if (!modelCaps) {
      const provider = getProvider(providerName);
      modelCaps = provider?.capabilities || null;
    }
    const missing = checkCapabilityMatch(requirements, modelCaps);
    if (missing.length > 0) {
      return c.json(
        {
          error: {
            message: formatCapabilityError(providerReq.model, missing),
            type: 'invalid_request_error',
            code: 'capability_mismatch',
            param: 'model',
          },
        },
        400,
      );
    }

    // Token 级限流：请求前预估检查
    const trl = getTokenRateLimit();
    if (trl) {
      const promptTokens = await countPromptTokens(
        providerReq.messages as ChatMessage[],
        providerReq.model,
      );
      const estimatedTotal = promptTokens + (providerReq.max_tokens || 4096);
      if (!trl.check(providerReq.model, estimatedTotal)) {
        return c.json(
          {
            error: {
              message: `Token rate limit exceeded for model '${providerReq.model}'. Estimated tokens: ${estimatedTotal}`,
              type: 'rate_limit_error',
              code: 'token_rate_limit_exceeded',
            },
          },
          429,
        );
      }
    }

    providerCallStart = Date.now();

    if (providerReq.stream) {
      return await handleStreamingResponse(c, providerReq, providerName, rootSpan, sessionId, sessionSource);
    }

    return await handleNonStreamingResponse(c, providerReq, providerName, providerCallStart, rootSpan, sessionId, sessionSource, config, req);
  } catch (error) {
    return handleError(c, error, sessionId, sessionSource, providerCallStart);
  }
}

chatRouter.post('/v1/chat/completions', handleChatCompletion);

export default chatRouter;
