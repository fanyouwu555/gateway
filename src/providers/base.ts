/**
 * Base Provider 抽象类
 * 所有Provider实现应继承此类
 */
import type {
  IProvider,
  IProviderConfig,
  IProviderCapabilities,
  ChatCompletionRequest,
  ChatCompletionResponse,
  EmbeddingRequest,
  EmbeddingResponse,
} from '../types';
import { fetchWithAgent } from '../utils/http-client';

export abstract class BaseProvider implements IProvider {
  abstract name: string;

  abstract capabilities: IProviderCapabilities;

  abstract chat(
    request: ChatCompletionRequest,
    config: IProviderConfig
  ): Promise<ChatCompletionResponse>;

  abstract chatStream(
    request: ChatCompletionRequest,
    config: IProviderConfig
  ): Promise<ReadableStream>;

  abstract embed(
    request: EmbeddingRequest,
    config: IProviderConfig
  ): Promise<EmbeddingResponse>;

  /**
   * 通用fetch方法
   */
  protected async fetch<T = unknown>(
    endpoint: string,
    options: RequestInit,
    timeout = 30000
  ): Promise<T> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      const response = await fetchWithAgent(endpoint, {
        ...options,
        signal: controller.signal,
      });

      if (!response.ok) {
        const errBody = await response.json().catch(() => ({})) as { message?: string };
        throw new Error(
          errBody.message || `HTTP ${response.status}: ${response.statusText}`
        );
      }

      return await response.json() as T;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * 构建请求头
   */
  protected buildHeaders(config: IProviderConfig): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (config.api_key) {
      headers['Authorization'] = `Bearer ${config.api_key}`;
    }

    if (config.headers) {
      Object.assign(headers, config.headers);
    }

    return headers;
  }

  /**
   * 解析streaming响应
   */
  protected parseStream(
    body: ReadableStream<Uint8Array>
  ): ReadableStream {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    return new ReadableStream({
      async pull(controller) {
        const { done, value } = await reader.read();

        if (done) {
          controller.close();
          return;
        }

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          // 兼容 "data: {...}" 和 "data:{...}" 两种 SSE 格式
          let data: string | undefined;
          if (trimmed.startsWith('data: ')) {
            data = trimmed.slice(6);
          } else if (trimmed.startsWith('data:')) {
            data = trimmed.slice(5);
          }
          if (data === undefined) continue;
          if (data === '[DONE]') {
            controller.close();
            return;
          }
          try {
            const parsed = JSON.parse(data);
            const chunk = {
              id: parsed.id || '',
              object: 'chat.completion.chunk',
              created: parsed.created || Date.now(),
              model: parsed.model || '',
              choices: parsed.choices || [],
            };
            controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(chunk)}\n\n`));
          } catch {
            // 忽略解析错误
          }
        }
      },
      cancel() {
        reader.cancel();
      },
    });
  }
}