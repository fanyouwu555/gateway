/**
 * Chat Completions 路由处理
 * POST /v1/chat/completions
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import { getProviderForModel } from '../config';
import { chatComplete, chatCompleteStream } from '../providers';
import type { ChatCompletionRequest } from '../types';

const chatRouter = new Hono();

/**
 * 处理 Chat Completion 请求
 */
async function handleChatCompletion(c: Context, stream = false): Promise<Response> {
  try {
    const request = (await c.req.json()) as ChatCompletionRequest;
    const model = request.model;

    if (!model) {
      return c.json(
        {
          error: {
            message: 'Missing required field: model',
            type: 'invalid_request_error',
            code: 'missing_model',
          },
        },
        400
      );
    }

    // 根据模型获取Provider
    const providerName = getProviderForModel(model);
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

    // 保存provider信息到请求上下文
    c.set('provider', providerName);
    c.set('model', model);

    // 调用Provider
    if (stream || request.stream) {
      const streamResponse = await chatCompleteStream(providerName, request);

      return new Response(streamResponse, {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        },
      });
    }

    const response = await chatComplete(providerName, request);
    return c.json(response, 200);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error('[Chat] Error:', message);

    return c.json(
      {
        error: {
          message,
          type: 'provider_error',
          code: 'provider_request_failed',
        },
      },
      500
    );
  }
}

// Chat Completions (支持流式和非流式)
chatRouter.post('/v1/chat/completions', async (c) => {
  const request = (await c.req.json()) as ChatCompletionRequest;
  const isStream = request.stream === true;
  return handleChatCompletion(c, isStream);
});

export default chatRouter;