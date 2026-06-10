/**
 * Models 路由处理
 * GET /v1/models — 从 routing 配置提取模型列表，交叉验证 provider 可用性，补充元数据
 */
import { Hono } from 'hono';
import { getConfig, getProviderConfig, getProviderForModel } from '../config';
import { getProvider } from '../providers';

const modelRouter = new Hono();

interface ModelEntry {
  id: string;
  object: string;
  owned_by: string;
  context_window?: number;
  pricing?: { input: number; output: number };
}

/** 模型可用性缓存: provider:model -> { available, expiresAt } */
const modelAvailabilityCache = new Map<string, { available: boolean; expiresAt: number }>();
const CACHE_TTL = 5 * 60 * 1000; // 5 分钟

/**
 * 检查模型在 provider 上是否可用
 * - 如果 provider 支持 listModels，查询可用列表做交叉验证
 * - 如果模型在 list 中且 status 非 Enabled，视为不可用
 * - 如果模型不在 list 中或 listModels 失败，视为可用（避免误杀未在 list 中但实际可用的模型）
 */
async function isModelAvailable(modelId: string, providerName: string): Promise<boolean> {
  const cacheKey = `${providerName}:${modelId}`;
  const cached = modelAvailabilityCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.available;
  }

  const provider = getProvider(providerName);
  if (!provider || !provider.listModels) {
    return true;
  }

  try {
    const providerConfig = getProviderConfig(providerName) || { provider: providerName, base_url: '' };
    const availableModels = await provider.listModels(providerConfig);
    const found = availableModels.find((m) => m.id === modelId);
    if (found && found.status && found.status !== 'Enabled') {
      modelAvailabilityCache.set(cacheKey, { available: false, expiresAt: Date.now() + CACHE_TTL });
      return false;
    }
    modelAvailabilityCache.set(cacheKey, { available: true, expiresAt: Date.now() + CACHE_TTL });
    return true;
  } catch {
    return true;
  }
}

modelRouter.get('/v1/models', async (c) => {
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

  let allModels = models.filter(
    (model, index, self) => index === self.findIndex((m) => m.id === model.id)
  );

  // 交叉验证模型可用性（并行查询）
  const availabilityChecks = allModels.map(async (m) => {
    const providerName = getProviderForModel(m.id);
    if (!providerName) return true;
    return isModelAvailable(m.id, providerName);
  });
  const availabilityResults = await Promise.all(availabilityChecks);
  allModels = allModels.filter((_m, index) => availabilityResults[index]);

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

  return c.json(response, 200);
});

export default modelRouter;
export type { ModelEntry };
