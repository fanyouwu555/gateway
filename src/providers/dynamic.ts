/**
 * 动态 Provider - 基于配置动态创建
 * 支持通过配置文件添加新的 Provider 而无需修改代码
 */
import { BaseProvider } from './base';
import type {
  IProviderCapabilities,
  IProviderConfig,
  ChatCompletionRequest,
  ChatCompletionResponse,
  EmbeddingRequest,
  EmbeddingResponse,
  DynamicProviderConfig,
} from '../types';
import { fetchWithAgent } from '../utils/http-client';

export class DynamicProvider extends BaseProvider {
  name: string;
  capabilities: IProviderCapabilities;
  private config: DynamicProviderConfig;

  constructor(dynamicConfig: DynamicProviderConfig) {
    super();
    this.name = dynamicConfig.name;
    this.config = dynamicConfig;
    this.capabilities = {
      chat: !!dynamicConfig.endpoints.chat,
      embed: !!dynamicConfig.endpoints.embeddings,
      streaming: !!dynamicConfig.endpoints.chat_stream,
      vision: dynamicConfig.capabilities?.vision ?? false,
      function_call: dynamicConfig.capabilities?.function_call ?? false,
    };
  }

  async chat(
    request: ChatCompletionRequest,
    config: IProviderConfig
  ): Promise<ChatCompletionResponse> {
    const endpoint = this.config.endpoints.chat || '/chat/completions';
    const url = `${config.base_url}${endpoint}`;

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

    return this.fetch<ChatCompletionResponse>(url, {
      method: 'POST',
      headers: this.buildDynamicHeaders(config),
      body: JSON.stringify(body),
    }, config.timeout);
  }

  async chatStream(
    request: ChatCompletionRequest,
    config: IProviderConfig
  ): Promise<ReadableStream> {
    const endpoint = this.config.endpoints.chat_stream || this.config.endpoints.chat || '/chat/completions';
    const url = `${config.base_url}${endpoint}`;

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

    const response = await fetchWithAgent(url, {
      method: 'POST',
      headers: this.buildDynamicHeaders(config),
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errBody = await response.json().catch(() => ({})) as { error?: { message?: string } };
      throw new Error(errBody.error?.message || `HTTP ${response.status}: ${response.statusText}`);
    }

    return this.parseStream(response.body as ReadableStream<Uint8Array>);
  }

  async embed(
    request: EmbeddingRequest,
    config: IProviderConfig
  ): Promise<EmbeddingResponse> {
    const endpoint = this.config.endpoints.embeddings || '/embeddings';
    const url = `${config.base_url}${endpoint}`;

    const body = {
      model: request.model,
      input: request.input,
      encoding_format: request.encoding_format || 'float',
      dimensions: request.dimensions,
    };

    return this.fetch<EmbeddingResponse>(url, {
      method: 'POST',
      headers: this.buildDynamicHeaders(config),
      body: JSON.stringify(body),
    }, config.timeout);
  }

  /**
   * 构建动态 headers
   */
  private buildDynamicHeaders(config: IProviderConfig): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    // 自定义认证
    if (config.api_key) {
      const authHeader = this.config.auth_header || 'Authorization';
      const prefix = this.config.auth_prefix || 'Bearer';
      headers[authHeader] = `${prefix} ${config.api_key}`;
    }

    if (config.headers) {
      Object.assign(headers, config.headers);
    }

    return headers;
  }
}