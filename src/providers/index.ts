/**
 * Provider 注册中心
 * 负责管理和调用各AI Provider
 * 集成了：多 API Key 选择 → 单 Provider 调用 → Failover 切换
 */
import type {
  IProvider,
  IProviderConfig,
  ChatCompletionRequest,
  ChatCompletionResponse,
  EmbeddingRequest,
  EmbeddingResponse,
} from '../types';
import { getProviderApiKeys } from '../types';
import { getConfig, getProviderConfig, getRoutingStrategy } from '../config';
import { failoverManager as defaultFailover } from '../services/failover';
import { loadBalanceManager as defaultLoadBalancer } from '../services/loadbalancer';

type FailoverManager = typeof defaultFailover;
type LoadBalanceManager = typeof defaultLoadBalancer;
import { withRetry } from '../services/retry';

// 可注入依赖（默认使用全局单例）
let activeFailover: FailoverManager = defaultFailover;
let activeLoadBalancer: LoadBalanceManager = defaultLoadBalancer;

/**
 * 设置 Provider 模块依赖（注入模式替代跨层直接 import）
 * 用于测试时注入 mock 实例，或生产切换实现
 */
export function setProviderDeps(deps: {
  failoverManager?: FailoverManager;
  loadBalanceManager?: LoadBalanceManager;
}): void {
  if (deps.failoverManager !== undefined) activeFailover = deps.failoverManager;
  if (deps.loadBalanceManager !== undefined) activeLoadBalancer = deps.loadBalanceManager;
}

/**
 * 重置 Provider 模块依赖为默认全局单例
 */
export function resetProviderDeps(): void {
  activeFailover = defaultFailover;
  activeLoadBalancer = defaultLoadBalancer;
}

// Provider映射
const providers = new Map<string, IProvider>();

/**
 * 注册Provider
 */
export function registerProvider(name: string, provider: IProvider): void {
  providers.set(name, provider);
}

/**
 * 获取Provider实例
 */
export function getProvider(name: string): IProvider | undefined {
  return providers.get(name);
}

/**
 * 获取所有已注册的Provider名称
 */
export function getProviderNames(): string[] {
  return Array.from(providers.keys());
}

/**
 * 重置 Provider 注册表（用于测试隔离）
 */
export function resetProviders(): void {
  providers.clear();
}

/**
 * 检查Provider是否已注册
 */
export function hasProvider(name: string): boolean {
  return providers.has(name);
}

/**
 * Get fallback providers for a given primary provider
 * 1. Use explicit failover chain from config if available
 * 2. Fall back to routing strategy rules
 */
function getFallbackProviders(excludeProvider: string, _requestModel: string): string[] {
  // 1. Use explicit failover chain
  const chain = activeFailover.getFailoverChain(excludeProvider);
  if (chain.length > 0) {
    return chain.filter((p) => p !== excludeProvider);
  }

  // 2. Fallback: derive from routing strategy
  const result: string[] = [];
  const strategy = getRoutingStrategy();
  if (strategy?.rules) {
    for (const rule of strategy.rules) {
      if (rule.provider !== excludeProvider) {
        result.push(rule.provider);
      }
    }
  }
  if (strategy?.fallback && strategy.fallback !== excludeProvider) {
    result.push(strategy.fallback);
  }
  return [...new Set(result)];
}

/**
 * 执行单次 Provider 调用（含 Key 选择 + 重试）
 */
async function callProviderWithRetry(
  provider: IProvider,
  config: IProviderConfig,
  request: ChatCompletionRequest,
  stream: boolean
): Promise<ChatCompletionResponse | ReadableStream> {
  // 获取该 Provider 的可用 API Keys
  const availableKeys = getProviderApiKeys(config);

  if (availableKeys.length === 0) {
    throw new Error(`No API keys configured for provider: ${provider.name}`);
  }

  // 使用 LoadBalancer 选择一个 Key（多 Key 场景）
  const selection = activeLoadBalancer.selectToken(provider.name, availableKeys);
  const activeKey = selection?.apiKey || availableKeys[0];

  // 创建带选中 Key 的配置副本
  const callConfig: IProviderConfig = { ...config, api_key: activeKey };

  // 使用重试机制调用（仅对 5xx/网络错误重试）
  if (stream) {
    // 流式调用不重试（流建立后无法回滚）
    const result = await provider.chatStream(request, callConfig);
    activeFailover.recordSuccess(provider.name, activeKey);
    return result;
  }

  return withRetry(
    async () => {
      try {
        const result = await provider.chat(request, callConfig);
        activeFailover.recordSuccess(provider.name, activeKey);
        return result;
      } catch (error) {
        activeFailover.recordFailure(provider.name, activeKey);
        throw error;
      }
    },
    { maxRetries: config.max_retries ?? 3, baseDelay: 1000, maxDelay: 10000 }
  );
}

/**
 * 根据 `model_equivalents` 配置解析目标 Provider 的等效模型名
 * 当 Failover 切换到其他 Provider 时自动重命名 model 字段
 */
export function resolveModelForProvider(model: string, provider: string): string {
  const equivalents = getConfig().model_equivalents;
  if (!equivalents) return model;
  const perProvider = equivalents[model];
  if (!perProvider) return model;
  return perProvider[provider] || model;
}

/**
 * 通用聊天完成请求（带 Failover）
 * 主 Provider 失败后自动切换到其他可用 Provider
 */
export async function chatComplete(
  providerName: string,
  request: ChatCompletionRequest
): Promise<ChatCompletionResponse> {
  const errors: Array<{ provider: string; error: string }> = [];
  const attemptedProviders = new Set<string>();

  // 尝试的 Provider 列表（先主后备）
  const providersToTry: string[] = [providerName];

  // 检查 failover 配置
  const failoverConfig = getConfig().failover;
  if (failoverConfig?.enabled) {
    const fallbacks = getFallbackProviders(providerName, request.model);
    providersToTry.push(...fallbacks);
  }

  for (const currentProvider of providersToTry) {
    if (attemptedProviders.has(currentProvider)) continue;
    attemptedProviders.add(currentProvider);

    const config = getProviderConfig(currentProvider);
    if (!config) {
      errors.push({ provider: currentProvider, error: 'Not configured' });
      continue;
    }

    const provider = providers.get(currentProvider);
    if (!provider) {
      errors.push({ provider: currentProvider, error: 'Not registered' });
      continue;
    }

    // 检查 Provider 级健康状态
    if (failoverConfig?.enabled) {
      if (!activeFailover.isProviderHealthy(currentProvider)) {
        errors.push({ provider: currentProvider, error: 'Provider unhealthy' });
        continue;
      }
    }

    // Token 级健康检查（fallback provider 必须有一个健康的 key）
    if (failoverConfig?.enabled && currentProvider !== providerName) {
      const token = activeFailover.getAvailableToken(currentProvider);
      if (!token) {
        errors.push({ provider: currentProvider, error: 'No healthy API key' });
        continue;
      }
    }

    // 根据 model_equivalents 重映射 model 名称
    const mappedModel = resolveModelForProvider(request.model, currentProvider);
    const providerRequest = mappedModel !== request.model
      ? { ...request, model: mappedModel }
      : request;

    let startTime = 0;
    try {
      startTime = Date.now();
      const result = await callProviderWithRetry(provider, config, providerRequest, false);
      const latency = Date.now() - startTime;
      activeFailover.recordProviderRequest(currentProvider, true, latency);
      return result as ChatCompletionResponse;
    } catch (error) {
      const latency = Date.now() - startTime;
      activeFailover.recordProviderRequest(currentProvider, false, latency);
      const errMsg = error instanceof Error ? error.message : String(error);
      errors.push({ provider: currentProvider, error: errMsg });
      // 继续尝试下一个 Provider
    }
  }

  // 所有 Provider 都失败
  throw new Error(
    `All providers failed for model "${request.model}": ${errors.map((e) => `${e.provider} (${e.error})`).join('; ')}`
  );
}

/**
 * 流式聊天完成请求
 * 流式请求不支持 Failover（已建立的流无法切换到其他 Provider）
 */
export async function chatCompleteStream(
  providerName: string,
  request: ChatCompletionRequest
): Promise<ReadableStream> {
  const config = getProviderConfig(providerName);
  if (!config) {
    throw new Error(`Provider ${providerName} not configured`);
  }

  const provider = providers.get(providerName);
  if (!provider) {
    throw new Error(`Provider ${providerName} not registered`);
  }

  const result = await callProviderWithRetry(provider, config, request, true);
  return result as ReadableStream;
}

/**
 * 创建 Embedding 请求
 */
export async function createEmbedding(
  providerName: string,
  request: EmbeddingRequest
): Promise<EmbeddingResponse> {
  const config = getProviderConfig(providerName);
  if (!config) {
    throw new Error(`Provider ${providerName} not configured`);
  }

  const provider = providers.get(providerName);
  if (!provider) {
    throw new Error(`Provider ${providerName} not registered`);
  }

  return provider.embed(request, config);
}
