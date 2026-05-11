/**
 * DeepSeek Provider 实现
 */
import { BaseProvider } from '../base';
import type {
  IProviderCapabilities,
  IProviderConfig,
  ChatCompletionRequest,
  ChatCompletionResponse,
  EmbeddingRequest,
  EmbeddingResponse,
} from '../../types';

export class DeepSeekProvider extends BaseProvider {
  name = 'deepseek';

  capabilities: IProviderCapabilities = {
    chat: true,
    embed: true,
    streaming: true,
    vision: false,
    function_call: false,
  };

  async chat(
    request: ChatCompletionRequest,
    config: IProviderConfig
  ): Promise<ChatCompletionResponse> {
    const url = `${config.base_url}/chat/completions`;

    const body = {
      model: request.model,
      messages: request.messages,
      temperature: request.temperature,
      top_p: request.top_p,
      max_tokens: request.max_tokens,
      stream: false,
      stop: request.stop,
    };

    const response = await this.fetch<ChatCompletionResponse>(url, {
      method: 'POST',
      headers: this.buildHeaders(config),
      body: JSON.stringify(body),
    }, config.timeout);

    return response;
  }

  async chatStream(
    request: ChatCompletionRequest,
    config: IProviderConfig
  ): Promise<ReadableStream> {
    const url = `${config.base_url}/chat/completions`;

    const body = {
      model: request.model,
      messages: request.messages,
      temperature: request.temperature,
      top_p: request.top_p,
      max_tokens: request.max_tokens,
      stream: true,
      stop: request.stop,
    };

    const response = await fetch(url, {
      method: 'POST',
      headers: this.buildHeaders(config),
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errBody = await response.json().catch(() => ({})) as { message?: string };
      throw new Error(
        errBody.message || `HTTP ${response.status}: ${response.statusText}`
      );
    }

    return this.parseStream(response.body as ReadableStream<Uint8Array>);
  }

  async embed(
    request: EmbeddingRequest,
    config: IProviderConfig
  ): Promise<EmbeddingResponse> {
    const url = `${config.base_url}/embeddings`;

    const body = {
      model: request.model,
      input: request.input,
      encoding_format: request.encoding_format || 'float',
    };

    return await this.fetch<EmbeddingResponse>(url, {
      method: 'POST',
      headers: this.buildHeaders(config),
      body: JSON.stringify(body),
    }, config.timeout);
  }
}

// 导出单例
export const deepseekProvider = new DeepSeekProvider();