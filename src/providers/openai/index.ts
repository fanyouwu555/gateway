/**
 * OpenAI Provider 实现
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

export class OpenAIProvider extends BaseProvider {
  name = 'openai';

  capabilities: IProviderCapabilities = {
    chat: true,
    embed: true,
    streaming: true,
    vision: true,
    function_call: true,
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
      presence_penalty: request.presence_penalty,
      frequency_penalty: request.frequency_penalty,
      user: request.user,
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
      presence_penalty: request.presence_penalty,
      frequency_penalty: request.frequency_penalty,
      user: request.user,
    };

    const response = await fetch(url, {
      method: 'POST',
      headers: this.buildHeaders(config),
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errBody = await response.json().catch(() => ({})) as { error?: { message?: string } };
      throw new Error(
        errBody.error?.message || `HTTP ${response.status}: ${response.statusText}`
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
      dimensions: request.dimensions,
    };

    return await this.fetch<EmbeddingResponse>(url, {
      method: 'POST',
      headers: this.buildHeaders(config),
      body: JSON.stringify(body),
    }, config.timeout);
  }
}

// 导出单例
export const openaiProvider = new OpenAIProvider();