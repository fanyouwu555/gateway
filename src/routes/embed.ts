/**
 * Embeddings 路由处理
 * POST /v1/embeddings
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import { getProviderForModel } from '../config';
import { createEmbedding } from '../providers';
import { embeddingRequestSchema } from '../validation';
import { logError } from '../middleware/logger';

const embedRouter = new Hono();

/**
 * 处理 Embedding 请求
 */
async function handleEmbedding(c: Context): Promise<Response> {
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
    const model = request.model;

    // Embedding模型通常以-开头，如 text-embedding-3-small
    // 这里简化处理，默认使用配置的provider
    const providerName = getProviderForModel(model) || 'openai';

    // 保存provider信息
    c.set('provider', providerName);
    c.set('model', model);

    const response = await createEmbedding(providerName, request);
    return c.json(response, 200);
  } catch (error) {
    const err = error instanceof Error ? error : new Error('Unknown error');
    logError(c.get('request_id'), err, { component: 'embed' });

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