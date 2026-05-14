/**
 * Chat Completions 路由处理
 * POST /v1/chat/completions
 *
 * 完整请求链路：
 *   校验 → Guardrail → 请求插件 → 智能路由 → Provider（带Failover）→ 响应插件 → 返回
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import { getProviderForModel } from '../config';
import { chatComplete, chatCompleteStream } from '../providers';
import { chatCompletionRequestSchema } from '../validation';
import { writeLog } from '../utils/logger';
import { smartRoute, type RouterStrategy } from '../services/router';
import { runGuardrailPlugins, runRequestPlugins, runResponsePlugins } from '../plugins';

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

    // 1. 运行 Guardrail 插件（拦截不合规请求）
    const guardrailResult = await runGuardrailPlugins(c, request);
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

    // 2. 运行请求插件（转换/增强请求）
    request = await runRequestPlugins(c, request);

    const model = request.model;

    // 3. 智能路由决策：确定使用哪个 Provider
    //    优先级：x-routing-strategy 请求头 > 默认路由
    const strategyHeader = c.req.header('x-routing-strategy') as RouterStrategy | undefined;
    let providerName: string | undefined;

    if (strategyHeader && ['cost', 'latency', 'quality', 'balance'].includes(strategyHeader)) {
      // 使用 SmartRouter 决策
      const decision = smartRoute(request, strategyHeader);
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
    if (request.stream) {
      const streamResponse = await chatCompleteStream(providerName, request);

      return new Response(streamResponse, {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        },
      });
    }

    let response = await chatComplete(providerName, request);

    // 5. 运行响应插件（转换/增强响应）
    response = await runResponsePlugins(c, response);

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
