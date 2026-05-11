/**
 * Models 路由处理
 * GET /v1/models
 */
import { Hono } from 'hono';
import { getConfig } from '../config';

const modelRouter = new Hono();

/**
 * 获取可用模型列表
 */
modelRouter.get('/v1/models', (c) => {
  const config = getConfig();

  // 从routing配置中提取可用模型
  const models: Array<{ id: string; object: string; owned_by: string }> = [];

  for (const strategy of config.routing) {
    for (const rule of strategy.rules) {
      models.push({
        id: rule.model,
        object: 'model',
        owned_by: rule.provider,
      });
    }
  }

  // 去重
  const uniqueModels = models.filter(
    (model, index, self) => index === self.findIndex((m) => m.id === model.id)
  );

  return c.json({
    object: 'list',
    data: uniqueModels,
  });
});

export default modelRouter;