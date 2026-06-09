/**
 * Chat Completions 路由处理
 * POST /v1/chat/completions
 *
 * 完整请求链路：
 *   校验 → Guardrail → 请求插件 → 智能路由 → Provider（带Failover）→ 响应插件 → 返回
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import { getProviderForModel, resolveModelAlias, isModelPool, getModelPool } from '../config';
import { chatComplete, chatCompleteStream } from '../providers';
import { chatCompletionRequestSchema } from '../validation';
import { writeLog } from '../utils/logger';
import { smartRoute, evaluateConditionalRules, recordLatency, recordError, type RouterStrategy } from '../services/router';
import { runGuardrailPlugins, runRequestPlugins, runResponsePlugins, runTransformPlugins } from '../plugins';
import { getCache, setCache, getLastCacheHitType } from '../services/cache';
import { getConfig } from '../config';
import { templateToMessages } from '../services/prompt';
import { checkQuota, recordUsage, checkKeyQuota } from '../services/quota';
import { createChildSpan, endSpan } from '../utils/tracing';
import { recordAiTtfb, recordAiTpot, recordAiCost, recordAiTokens } from '../middleware/metrics';
import { recordMetric } from '../services/metrics';
import { getPricingService } from '../services/pricing';
import { countCompletionTokens, countPromptTokens, accumulateStreamContent } from '../services/token-counter';
import { getTokenRateLimit } from '../services/token-ratelimit';
import { getRequestLogStore } from '../services/request-log';
import { getConversationLogService } from '../services/conversation-log';
import type { ChatMessage, ChatCompletionChunk, ChatCompletionRequest } from '../types';
import type { Span } from '@opentelemetry/api';
import { extractClientInfo } from '../utils/client-info';

const chatRouter = new Hono();

type ParsedRequest = ReturnType<typeof chatCompletionRequestSchema.parse>;

function resolveRequestModel(c: Context, request: ParsedRequest): ParsedRequest {
  let resolved = request;
  if (!resolved.model) {
    const apiKeyMeta = c.get('api_key_meta') as { default_model?: string } | undefined;
    if (apiKeyMeta?.default_model) {
      resolved = { ...resolved, model: resolveModelAlias(apiKeyMeta.default_model) };
    } else {
      const firstRule = getConfig().routing[0]?.rules[0];
      if (firstRule) {
        resolved = { ...resolved, model: firstRule.model };
      }
    }
  }
  if (resolved.model) {
    resolved = { ...resolved, model: resolveModelAlias(resolved.model) };
  }
  return resolved;
}

function checkKeyPolicies(c: Context, req: ChatCompletionRequest, tenantId: string | undefined): Response | null {
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

  const keyMonthlyBudget = c.get('key_monthly_budget') as number | undefined;
  if (keyMonthlyBudget !== undefined) {
    const keyHash = c.get('key_hash') as string | undefined;
    if (keyHash) {
      const budgetCheck = checkKeyQuota(keyHash, keyMonthlyBudget);
      if (!budgetCheck.allowed) {
        recordMetric(
          c.get('request_id') as string,
          tenantId,
          'gateway',
          req.model,
          0,
          429,
          { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
          keyHash,
          c.get('key_metadata'),
        );
        return c.json({
          error: {
            message: budgetCheck.reason || 'API key monthly budget exceeded',
            type: 'rate_limit_error',
            code: 'budget_exceeded',
          },
        }, 429);
      }
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
      endSpan(cacheSpan);
      const cachedResp = JSON.parse(cached) as { usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } };
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

function resolveProvider(
  c: Context,
  processedReq: ChatCompletionRequest,
  tenantId: string | undefined,
): { provider: string; actualModel: string } | Response {
  const model = processedReq.model;
  const strategyHeader = c.req.header('x-routing-strategy') as RouterStrategy | undefined;

  // 1. 优先检查模型能力池
  if (model && isModelPool(model)) {
    const pool = getModelPool(model);
    if (pool && pool.candidates && pool.candidates.length > 0) {
      const enabledCandidates = pool.candidates
        .filter((c) => c.enabled !== false)
        .sort((a, b) => a.priority - b.priority);

      if (enabledCandidates.length > 0) {
        const selected = enabledCandidates[0];
        writeLog('info', 'Model pool resolved', {
          pool: model,
          provider: selected.provider,
          actualModel: selected.model,
        });
        return { provider: selected.provider, actualModel: selected.model };
      }
    }
  }

  const contentLength = processedReq.messages.reduce(
    (sum: number, m: { content: string | unknown[] }) => sum + (m.content?.length || 0),
    0
  );
  const conditionalDecision = evaluateConditionalRules({
    model,
    tenant_id: tenantId,
    content_length: contentLength,
    has_tools: !!(processedReq.tools && processedReq.tools.length > 0),
    headers: Object.fromEntries(
      Object.entries(c.req.header() || {}).map(([k, v]) => [k.toLowerCase(), v || ''])
    ),
  });

  let providerName: string | undefined;
  let resolvedModel = model;

  if (conditionalDecision) {
    providerName = conditionalDecision.provider;
    if (conditionalDecision.model) {
      resolvedModel = conditionalDecision.model;
    }
    writeLog('info', 'Conditional rule matched', {
      model,
      provider: providerName,
      reason: conditionalDecision.reason,
    });
  } else if (strategyHeader && ['cost', 'latency', 'quality', 'balance'].includes(strategyHeader)) {
    const decision = smartRoute(processedReq, strategyHeader);
    providerName = decision.provider;
    if (decision.model) {
      resolvedModel = decision.model;
    }
    writeLog('info', 'SmartRouter selected provider', {
      model,
      provider: providerName,
      strategy: strategyHeader,
      reason: decision.reason,
    });
  } else {
    providerName = getProviderForModel(model);
  }

  if (!providerName) {
    recordMetric(
      c.get('request_id') as string,
      tenantId,
      'gateway',
      model,
      0,
      400,
      { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      c.get('key_hash'),
      c.get('key_metadata'),
    );
    return c.json(
      {
        error: {
          message: `No provider configured for model: ${model}`,
          type: 'invalid_request_error',
          code: 'unknown_model',
        },
      },
      400
    );
  }

  return { provider: providerName, actualModel: resolvedModel };
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
  const decoder = new TextDecoder();
  let textBuffer = '';
  let accumulatedContent = '';
  let accumulatedReasoning = '';
  const accumulatedToolCalls: import('../types').ChatToolCall[] = [];
  const streamStart = Date.now();
  let streamCancelled = false;

  const wrappedStream = new ReadableStream({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        if (streamCancelled) {
          controller.close();
          return;
        }

        const completionTokens = await countCompletionTokens(accumulatedContent, model);
        const totalTokens = promptTokens + completionTokens;
        c.set('completion_tokens', completionTokens);
        c.set('total_tokens', totalTokens);

        recordAiTokens(promptTokens, completionTokens, providerName, model);

        const cost = getPricingService().calculateCost(model, promptTokens, completionTokens);

        const tenantId = c.get('tenant_id');
        if (tenantId) {
          const keyHash = c.get('key_hash') as string | undefined;
          recordUsage(tenantId, totalTokens, cost, keyHash);
          recordAiCost(cost, providerName, model);
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
          },
        };
        controller.enqueue(new TextEncoder().encode('data: ' + JSON.stringify(usageChunk) + '\n\n'));
        controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
        controller.close();
        return;
      }

      controller.enqueue(value);

      textBuffer += decoder.decode(value, { stream: true });
      const lines = textBuffer.split('\n');
      textBuffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('data: ') && !trimmed.startsWith('data: [DONE]')) {
          try {
            const parsed = JSON.parse(trimmed.slice(6)) as ChatCompletionChunk;
            for (const choice of parsed.choices || []) {
              const delta = choice.delta;
              accumulatedContent = accumulateStreamContent(accumulatedContent, delta);
              if (delta.reasoning_content && typeof delta.reasoning_content === 'string') {
                accumulatedReasoning += delta.reasoning_content;
              }
              if (delta.tool_calls && Array.isArray(delta.tool_calls)) {
                for (const tc of delta.tool_calls as Array<import('../types').ChatToolCall & { index?: number }>) {
                  const idx = tc.index ?? 0;
                  if (!accumulatedToolCalls[idx]) {
                    accumulatedToolCalls[idx] = {
                      id: tc.id || '',
                      type: 'function',
                      function: { name: '', arguments: '' },
                    };
                  }
                  if (tc.id) accumulatedToolCalls[idx].id = tc.id;
                  if (tc.function?.name) accumulatedToolCalls[idx].function.name += tc.function.name;
                  if (tc.function?.arguments) accumulatedToolCalls[idx].function.arguments += tc.function.arguments;
                }
              }
            }
          } catch {
            // 忽略非 JSON 行或解析错误
          }
        }
      }
    },
    cancel() {
      streamCancelled = true;
      reader.cancel().catch(() => {});
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
  if (tenantId && response.usage) {
    const cost = getPricingService().calculateCost(processedReq.model, response.usage.prompt_tokens || 0, response.usage.completion_tokens || 0);
    const keyHash = c.get('key_hash') as string | undefined;
    recordUsage(tenantId, response.usage.total_tokens || 0, cost, keyHash);

    recordAiCost(cost, providerName, model);

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

  if ((config.cache?.enabled || config.semantic_cache?.enabled) && !req.stream) {
    setCache(req, JSON.stringify(response), tenantId).catch((err) => {
      writeLog('warn', 'Failed to cache response', { error: err instanceof Error ? err.message : String(err) });
    });
  }

  c.header('X-Gateway-Cost', totalCost.toFixed(6));
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

    request = resolveRequestModel(c, request);
    const req = request as unknown as ChatCompletionRequest;
    const tenantId = c.get('tenant_id');

    const policyError = checkKeyPolicies(c, req, tenantId);
    if (policyError) return policyError;

    const rootSpan = c.get('span');
    const config = getConfig();

    const cachedResponse = await checkCaches(c, req, tenantId, config, rootSpan);
    if (cachedResponse) return cachedResponse;

    const pipelineResult = await runPreProviderPipeline(c, req, tenantId, rootSpan);
    if (pipelineResult instanceof Response) return pipelineResult;
    const processedReq = pipelineResult;

    const providerResult = resolveProvider(c, processedReq, tenantId);
    if (providerResult instanceof Response) return providerResult;
    const { provider: providerName, actualModel } = providerResult;

    // 如果模型池解析出了不同的实际模型，更新请求
    const providerReq = actualModel !== processedReq.model
      ? { ...processedReq, model: actualModel }
      : processedReq;

    c.set('provider', providerName);
    c.set('model', providerReq.model);
    c.set('pool_model', processedReq.model); // 保存原始模型池名称

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
