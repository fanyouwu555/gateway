/**
 * Chat Completions 路由处理
 * POST /v1/chat/completions
 *
 * 完整请求链路：
 *   校验 → Guardrail → 请求插件 → 智能路由 → Provider（带Failover）→ 响应插件 → 返回
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import { getProviderForModel, resolveModelAlias } from '../config';
import { chatComplete, chatCompleteStream } from '../providers';
import { chatCompletionRequestSchema } from '../validation';
import { writeLog } from '../utils/logger';
import { smartRoute, evaluateConditionalRules, type RouterStrategy } from '../services/router';
import { runGuardrailPlugins, runRequestPlugins, runResponsePlugins, runTransformPlugins } from '../plugins';
import { getCache, setCache } from '../services/cache';
import { getSemanticCache } from '../services/semantic-cache';
import { getConfig } from '../config';
import { templateToMessages } from '../services/prompt';
import { checkQuota, recordUsage, checkKeyQuota } from '../services/quota';
import { createChildSpan, endSpan } from '../utils/tracing';
import { recordAiTtfb, recordAiTpot, recordAiCost, recordAiTokens } from '../middleware/metrics';
import { recordMetric, calculateCost } from '../services/metrics';
import { countCompletionTokens, countPromptTokens, accumulateStreamContent } from '../services/token-counter';
import { getTokenRateLimit } from '../services/token-ratelimit';
import { getRequestLogStore } from '../services/request-log';
import type { ChatMessage, ChatCompletionChunk } from '../types';

const chatRouter = new Hono();

/**
 * 处理 Chat Completion 请求
 */
async function handleChatCompletion(c: Context): Promise<Response> {
  try {
    const parsed = chatCompletionRequestSchema.safeParse(await c.req.json());
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

    // 模板渲染：如果提供了 template_id，将模板转换为 messages
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

    // 解析模型别名
    request = { ...request, model: resolveModelAlias(request.model) };

    // 模板渲染后 messages 必定存在
    const req = request as unknown as import('../types').ChatCompletionRequest;

    // 提前获取 tenantId，供缓存、配额等模块使用
    const tenantId = c.get('tenant_id');

    // 虚拟 Key 策略检查：允许的模型列表
    const keyAllowedModels = c.get('key_allowed_models') as string[] | undefined;
    if (keyAllowedModels && keyAllowedModels.length > 0 && !keyAllowedModels.includes(req.model)) {
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

    // 虚拟 Key 策略检查：月度预算
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

    // 虚拟 Key 策略：clamp max_tokens
    const keyMaxTokens = c.get('key_max_tokens_per_request') as number | undefined;
    if (keyMaxTokens !== undefined && (req.max_tokens === undefined || req.max_tokens > keyMaxTokens)) {
      req.max_tokens = keyMaxTokens;
    }

    // 获取 Root Span（如存在）用于创建 Child Span
    const rootSpan = c.get('span');

    // 0. 缓存检查（非流式请求）
    const config = getConfig();
    const cacheSpan = createChildSpan(rootSpan, 'cache_lookup');
    if (config.cache?.enabled && !req.stream) {
      const cached = await getCache(req, tenantId);
      if (cached) {
        writeLog('debug', 'Cache hit', { model: req.model });
        c.set('cache_hit', true);
        endSpan(cacheSpan);
        // 从缓存响应中提取 usage 设置到上下文（供 logger 记录指标）
        const cachedResp = JSON.parse(cached) as { usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } };
        const promptTokens = cachedResp.usage?.prompt_tokens || 0;
        const completionTokens = cachedResp.usage?.completion_tokens || 0;
        const totalTokens = cachedResp.usage?.total_tokens || 0;
        if (cachedResp.usage) {
          c.set('prompt_tokens', promptTokens);
          c.set('completion_tokens', completionTokens);
          c.set('total_tokens', totalTokens);
        }
        // 记录缓存命中指标到 MetricsStore
        recordMetric(
          c.get('request_id') as string,
          tenantId,
          'cache',
          req.model,
          0,
          200,
          { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: totalTokens },
          c.get('key_hash'),
          c.get('key_metadata'),
        );
        // 计算缓存命中的费用
        const cacheCost = calculateCost(req.model, { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: totalTokens }) || 0;
        c.header('X-Gateway-Cost', cacheCost.toFixed(6));
        return c.json(cachedResp, 200);
      }
    }
    endSpan(cacheSpan);

    // L3 向量语义缓存
    const semanticCache = getSemanticCache();
    if (semanticCache && config.semantic_cache?.enabled && !req.stream) {
      const semanticCached = await semanticCache.get(req, tenantId);
      if (semanticCached) {
        writeLog('debug', 'Semantic cache hit', { model: req.model });
        c.set('cache_hit', true);
        // 从缓存响应中提取 usage 设置到上下文
        const cachedResp = JSON.parse(semanticCached) as { usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } };
        const promptTokens = cachedResp.usage?.prompt_tokens || 0;
        const completionTokens = cachedResp.usage?.completion_tokens || 0;
        const totalTokens = cachedResp.usage?.total_tokens || 0;
        if (cachedResp.usage) {
          c.set('prompt_tokens', promptTokens);
          c.set('completion_tokens', completionTokens);
          c.set('total_tokens', totalTokens);
        }
        // 记录语义缓存命中指标到 MetricsStore
        recordMetric(
          c.get('request_id') as string,
          tenantId,
          'semantic_cache',
          req.model,
          0,
          200,
          { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: totalTokens },
          c.get('key_hash'),
          c.get('key_metadata'),
        );
        // 计算语义缓存命中的费用
        const semanticCacheCost = calculateCost(req.model, { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: totalTokens }) || 0;
        c.header('X-Gateway-Cost', semanticCacheCost.toFixed(6));
        return c.json(cachedResp, 200);
      }
    }

    // 0.5. 运行 Transform 插件（PII 脱敏等）
    const transformedReq = await runTransformPlugins(c, req) as typeof req;

    // 1. 运行 Guardrail 插件（拦截不合规请求）
    const guardrailSpan = createChildSpan(rootSpan, 'guardrail_check');
    const guardrailResult = await runGuardrailPlugins(c, transformedReq);
    endSpan(guardrailSpan);
    if (!guardrailResult.allowed) {
      recordMetric(
        c.get('request_id') as string,
        tenantId,
        'gateway',
        transformedReq.model,
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

    // 1.5. 配额检查
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

    // 2. 运行请求插件（转换/增强请求）
    const processedReq = await runRequestPlugins(c, transformedReq);

    const model = processedReq.model;

    // 3. 路由决策：确定使用哪个 Provider
    //    优先级：条件规则 > x-routing-strategy 请求头 > 默认路由
    const strategyHeader = c.req.header('x-routing-strategy') as RouterStrategy | undefined;

    // 3a. 评估条件路由规则（最高优先级）
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
    if (conditionalDecision) {
      providerName = conditionalDecision.provider;
      writeLog('info', 'Conditional rule matched', {
        model,
        provider: providerName,
        reason: conditionalDecision.reason,
      });
    } else if (strategyHeader && ['cost', 'latency', 'quality', 'balance'].includes(strategyHeader)) {
      // 3b. 使用 SmartRouter 决策
      const decision = smartRoute(processedReq, strategyHeader);
      providerName = decision.provider;
      writeLog('info', 'SmartRouter selected provider', {
        model,
        provider: providerName,
        strategy: strategyHeader,
        reason: decision.reason,
      });
    } else {
      // 3c. 使用配置的 model→provider 映射
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

    // 保存 provider 信息到请求上下文（用于日志）
    c.set('provider', providerName);
    c.set('model', model);

    // 4. 调用 Provider (支持 Failover)
    const providerSpan = createChildSpan(rootSpan, 'provider_call');
    const providerCallStart = Date.now();

    if (processedReq.stream) {
      const streamResponse = await chatCompleteStream(providerName, processedReq);

      // 1. 预计算 prompt tokens（从请求消息本地计数）
      const requestId = c.get('request_id') as string;
      const promptTokens = await countPromptTokens(
        processedReq.messages as ChatMessage[],
        model,
      );
      c.set('prompt_tokens', promptTokens);

      // 2. 包裹流以追踪 completion token（透传原始字节，不修改 SSE 格式）
      const reader = streamResponse.getReader();
      const decoder = new TextDecoder();
      let textBuffer = '';
      let accumulatedContent = '';
      const streamStart = Date.now();

      const wrappedStream = new ReadableStream({
        async pull(controller) {
          const { done, value } = await reader.read();
          if (done) {
            // 流结束：计算 completion tokens 并记录用量
            const completionTokens = await countCompletionTokens(accumulatedContent, model);
            const totalTokens = promptTokens + completionTokens;
            c.set('completion_tokens', completionTokens);
            c.set('total_tokens', totalTokens);

            // 记录 AI 指标
            recordAiTokens(promptTokens, completionTokens, providerName, model);

            // 计算费用（同时用于 tenant usage 记录和 usageChunk）
            const pricing = getConfig().pricing?.[model];
            let cost = 0;
            if (pricing) {
              cost = (promptTokens * pricing.input + completionTokens * pricing.output) / 1_000_000;
            }

            const tenantId = c.get('tenant_id');
            if (tenantId) {
              const keyHash = c.get('key_hash') as string | undefined;
              recordUsage(tenantId, totalTokens, cost, keyHash);
              recordAiCost(cost, providerName, model, tenantId);
            }

            // Token 级按模型限流消耗
            const trl = getTokenRateLimit();
            if (trl) {
              trl.consume(model, totalTokens);
            }

            // 记录完整指标（覆盖 logger middleware 记录的初始值）
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

            // 记录请求日志
            const logStore = getRequestLogStore();
            if (logStore.shouldSample()) {
              const stringBody = JSON.stringify(processedReq);
              // 移除敏感字段
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

            // 在流结束时发送 usage chunk（符合 OpenAI 流式格式）
            // 客户端（如 OpenCode）依赖此 chunk 获取 token 统计
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

          // 透传原始字节（保持 SSE 格式完整，包括 \n\n 事件分隔符）
          controller.enqueue(value);

          // 同时解码文本以提取 delta content（只读解析，不修改）
          textBuffer += decoder.decode(value, { stream: true });
          const lines = textBuffer.split('\n');
          textBuffer = lines.pop() || '';

          for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed.startsWith('data: ') && !trimmed.startsWith('data: [DONE]')) {
              try {
                const parsed = JSON.parse(trimmed.slice(6)) as ChatCompletionChunk;
                for (const choice of parsed.choices || []) {
                  accumulatedContent = accumulateStreamContent(accumulatedContent, choice.delta);
                }
              } catch {
                // 忽略非 JSON 行或解析错误
              }
            }
          }
        },
        cancel() {
          reader.cancel();
        },
      });

      endSpan(providerSpan);

      return new Response(wrappedStream, {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        },
      });
    }

    let response = await chatComplete(providerName, processedReq);
    const providerCallEnd = Date.now();
    const ttfbMs = providerCallEnd - providerCallStart;
    endSpan(providerSpan);

    // 记录 AI 指标：TTFT
    recordAiTtfb(ttfbMs, providerName, model);

    // 5. 运行响应插件（转换/增强响应）
    response = await runResponsePlugins(c, response);

    // 5.5. 将 token 使用量写入上下文（供 logger middleware 读取）
    if (response.usage) {
      const promptTokens = response.usage.prompt_tokens || 0;
      const completionTokens = response.usage.completion_tokens || 0;
      const totalTokens = response.usage.total_tokens || promptTokens + completionTokens;
      c.set('prompt_tokens', promptTokens);
      c.set('completion_tokens', completionTokens);
      c.set('total_tokens', totalTokens);

      // 记录 AI Token 使用量指标
      recordAiTokens(promptTokens, completionTokens, providerName, model);

      // 计算并记录 TPOT（每输出 token 耗时）
      if (completionTokens > 0) {
        const tpotMs = ttfbMs / completionTokens;
        recordAiTpot(tpotMs, providerName, model);
      }
    }

    // 5.6. 记录使用量（非流式请求）
    const usageSpan = createChildSpan(rootSpan, 'usage_record');
    if (tenantId && response.usage) {
      const pricing = config.pricing?.[processedReq.model];
      let cost = 0;
      if (pricing) {
        const inputTokens = response.usage.prompt_tokens || 0;
        const outputTokens = response.usage.completion_tokens || 0;
        cost = (inputTokens * pricing.input + outputTokens * pricing.output) / 1_000_000;
      }
      const keyHash = c.get('key_hash') as string | undefined;
      recordUsage(tenantId, response.usage.total_tokens || 0, cost, keyHash);

      // 记录 AI 成本指标
      recordAiCost(cost, providerName, model, tenantId);

      // 记录完整指标到 MetricsStore（供管理面板展示）
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

    // Token 级按模型限流消耗
    if (response.usage) {
      const trl = getTokenRateLimit();
      if (trl) {
        trl.consume(model, response.usage.total_tokens || 0);
      }
    }

    // 记录请求日志
    const logStore = getRequestLogStore();
    if (logStore.shouldSample()) {
      const stringBody = JSON.stringify(processedReq);
      const sanitizedBody = stringBody.replace(/"api_key":"[^"]+"/g, '"api_key":"***"');
      const cost = response.usage ? (calculateCost(model, {
        prompt_tokens: response.usage.prompt_tokens || 0,
        completion_tokens: response.usage.completion_tokens || 0,
        total_tokens: response.usage.total_tokens || 0,
      }) || 0) : 0;
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

    // 6. 缓存响应（非流式请求）
    if (config.cache?.enabled && !processedReq.stream) {
      setCache(processedReq, JSON.stringify(response), tenantId).catch((err) => {
        writeLog('warn', 'Failed to cache response', { error: err instanceof Error ? err.message : String(err) });
      });
    }

    // L3 语义缓存写入
    if (semanticCache && config.semantic_cache?.enabled && !processedReq.stream) {
      semanticCache.set(processedReq, JSON.stringify(response), tenantId).catch((err) => {
        writeLog('warn', 'Failed to set semantic cache', { error: err instanceof Error ? err.message : String(err) });
      });
    }

    // X-Gateway-Cost 响应头
    const totalCost = response.usage ? calculateCost(model, {
      prompt_tokens: response.usage.prompt_tokens || 0,
      completion_tokens: response.usage.completion_tokens || 0,
      total_tokens: response.usage.total_tokens || 0,
    }) || 0 : 0;
    c.header('X-Gateway-Cost', totalCost.toFixed(6));

    return c.json(response, 200);
  } catch (error) {
    const err = error instanceof Error ? error : new Error('Unknown error');
    writeLog('error', 'Chat completion error', {
      request_id: c.get('request_id'),
      error: err.message,
      code: err.constructor.name,
    });

    // 记录失败请求的指标到 MetricsStore
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

    // JSON 解析错误返回 400，其他错误返回 500
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
}

chatRouter.post('/v1/chat/completions', handleChatCompletion);

export default chatRouter;
