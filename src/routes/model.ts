/**
 * Models 路由处理
 * GET /v1/models — 从 routing 配置提取模型列表，补充 context_window / pricing 元数据
 */
import { Hono } from 'hono';
import { getConfig } from '../config';

const modelRouter = new Hono();

interface ModelEntry {
  id: string;
  object: string;
  owned_by: string;
  context_window?: number;
  pricing?: { input: number; output: number };
}

modelRouter.get('/v1/models', (c) => {
  const config = getConfig();

  const models: ModelEntry[] = [];
  for (const strategy of config.routing) {
    for (const rule of strategy.rules) {
      models.push({
        id: rule.model,
        object: 'model',
        owned_by: rule.provider,
        context_window: rule.max_tokens,
        pricing: config.pricing?.[rule.model],
      });
    }
  }

  const allModels = models.filter(
    (model, index, self) => index === self.findIndex((m) => m.id === model.id)
  );

  const apiKeyMeta = c.get('api_key_meta');
  const allowedModels = apiKeyMeta?.allowed_models;
  const defaultModel = apiKeyMeta?.default_model;

  let data: typeof allModels;
  if (allowedModels && allowedModels.length > 0) {
    const allowedSet = new Set(allowedModels);
    if (defaultModel) {
      allowedSet.add(defaultModel);
    }
    data = allModels.filter((m) => allowedSet.has(m.id));
  } else {
    data = allModels;
  }

  const response: { object: string; data: typeof data; default_model?: string } = {
    object: 'list',
    data,
  };
  if (defaultModel) {
    response.default_model = defaultModel;
  }

  return c.json(response);
});

export default modelRouter;
export type { ModelEntry };
