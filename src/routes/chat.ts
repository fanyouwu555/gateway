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
import { smartRoute, type RouterStrategy } from '../services/router';
import { runGuardrailPlugins, runRequestPlugins, runResponsePlugins, runTransformPlugins } from '../plugins';
import { getCache, setCache } from '../services/cache';
import { getConfig } from '../config';
import { templateToMessages } from '../services/prompt';
import { checkQuota, recordUsage, checkKeyQuota } from '../services/quota';
import { createChildSpan, endSpan } from '../utils/tracing';
import { recordAiTtfb, recordAiTpot, recordAiCost, recordAiTokens } from '../middleware/metrics';

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
        return c.json(JSON.parse(cached), 200);
      }
    }
    endSpan(cacheSpan);

    // 0.5. 运行 Transform 插件（PII 脱敏等）
    const transformedReq = await runTransformPlugins(c, req) as typeof req;

    // 1. 运行 Guardrail 插件（拦截不合规请求）
    const guardrailSpan = createChildSpan(rootSpan, 'guardrail_check');
    const guardrailResult = await runGuardrailPlugins(c, transformedReq);
    endSpan(guardrailSpan);
    if (!guardrailResult.allowed) {
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

    // 3. 智能路由决策：确定使用哪个 Provider
    //    优先级：x-routing-strategy 请求头 > 默认路由
    const strategyHeader = c.req.header('x-routing-strategy') as RouterStrategy | undefined;
    let providerName: string | undefined;

    if (strategyHeader && ['cost', 'latency', 'quality', 'balance'].includes(strategyHeader)) {
      // 使用 SmartRouter 决策
      const decision = smartRoute(processedReq, strategyHeader);
      providerName = decision.provider;
      writeLog('info', 'SmartRouter selected provider', {
        model,
        provider: providerName,
        strategy: strategyHeader,
        reason: decision.reason,
      });
    } else {
      // 使用配置的 model→provider 映射
      providerName = getProviderForModel(model);
    }

    if (!providerName) {
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
      endSpan(providerSpan);

      return new Response(streamResponse, {
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
    }
    endSpan(usageSpan);

    // 6. 缓存响应（非流式请求）
    if (config.cache?.enabled && !processedReq.stream) {
      setCache(processedReq, JSON.stringify(response), tenantId).catch((err) => {
        writeLog('warn', 'Failed to cache response', { error: err instanceof Error ? err.message : String(err) });
      });
    }

    return c.json(response, 200);
  } catch (error) {
    const err = error instanceof Error ? error : new Error('Unknown error');
    writeLog('error', 'Chat completion error', {
      request_id: c.get('request_id'),
      error: err.message,
      code: err.constructor.name,
    });

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
