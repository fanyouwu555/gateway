/**
 * Provider 注册中心
 * 负责管理和调用各AI Provider
 * 支持 Failover 机制
 */
import type {
  IProvider,
  IProviderConfig,
  ChatCompletionRequest,
  ChatCompletionResponse,
  EmbeddingRequest,
  EmbeddingResponse,
} from '../types';
import { getProviderConfig } from '../config';
import { failoverManager } from '../services/failover';

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
 * 检查Provider是否已注册
 */
export function hasProvider(name: string): boolean {
  return providers.has(name);
}

/**
 * 通用聊天完成请求 (带 Failover)
 */
export async function chatComplete(
  providerName: string,
  request: ChatCompletionRequest
): Promise<ChatCompletionResponse> {
  const config = getProviderConfig(providerName);
  if (!config) {
    throw new Error(`Provider ${providerName} not configured`);
  }

  const provider = providers.get(providerName);
  if (!provider) {
    throw new Error(`Provider ${providerName} not registered`);
  }

  try {
    const result = await provider.chat(request, config);
    // 记录成功
    if (config.api_key) {
      failoverManager.recordSuccess(providerName, config.api_key);
    }
    return result;
  } catch (error) {
    // 记录失败
    if (config.api_key) {
      failoverManager.recordFailure(providerName, config.api_key);
    }
    throw error;
  }
}

/**
 * 流式聊天完成请求 (带 Failover)
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

  try {
    const stream = await provider.chatStream(request, config);
    // 包装 stream 以记录成功/失败
    const wrapper = new ReadableStream({
      start(controller) {
        const reader = stream.getReader();
        const read = async () => {
          try {
            const { done, value } = await reader.read();
            if (done) {
              // 流完成，记录成功
              if (config.api_key) {
                failoverManager.recordSuccess(providerName, config.api_key);
              }
              controller.close();
            } else {
              controller.enqueue(value);
              read();
            }
          } catch (error) {
            // 流错误，记录失败
            if (config.api_key) {
              failoverManager.recordFailure(providerName, config.api_key);
            }
            controller.error(error);
          }
        };
        read();
      },
    });
    return wrapper;
  } catch (error) {
    // 记录失败
    if (config.api_key) {
      failoverManager.recordFailure(providerName, config.api_key);
    }
    throw error;
  }
}

/**
 * Embedding请求 (带 Failover)
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

  try {
    const result = await provider.embed(request, config);
    // 记录成功
    if (config.api_key) {
      failoverManager.recordSuccess(providerName, config.api_key);
    }
    return result;
  } catch (error) {
    // 记录失败
    if (config.api_key) {
      failoverManager.recordFailure(providerName, config.api_key);
    }
    throw error;
  }
}

/**
 * 获取 Failover 健康状态
 */
export function getFailoverHealthStatus(): Record<string, { isHealthy: boolean; failureCount: number }> {
  return failoverManager.getHealthStatus();
}

export type { IProvider, IProviderConfig };
export type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  EmbeddingRequest,
  EmbeddingResponse,
} from '../types';