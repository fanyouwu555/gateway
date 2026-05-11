/**
 * Embeddings 路由处理
 * POST /v1/embeddings
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import { getProviderForModel } from '../config';
import { createEmbedding } from '../providers';
import type { EmbeddingRequest } from '../types';

const embedRouter = new Hono();

/**
 * 处理 Embedding 请求
 */
async function handleEmbedding(c: Context): Promise<Response> {
  try {
    const request = (await c.req.json()) as EmbeddingRequest;
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

    // Embedding模型通常以-开头，如 text-embedding-3-small
    // 这里简化处理，默认使用配置的provider
    const providerName = getProviderForModel(model) || 'openai';

    // 保存provider信息
    c.set('provider', providerName);
    c.set('model', model);

    const response = await createEmbedding(providerName, request);
    return c.json(response, 200);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error('[Embed] Error:', message);

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

embedRouter.post('/v1/embeddings', handleEmbedding);

export default embedRouter;