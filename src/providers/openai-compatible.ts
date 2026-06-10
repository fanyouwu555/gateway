/**
 * OpenAI 兼容 Provider 基类
 * 为 API 格式与 OpenAI 相同的 Provider（DeepSeek、Groq、Mistral 等）提供统一实现
 * 仅需通过配置声明支持的字段和能力，无需重复实现 HTTP 调用逻辑
 */
import { BaseProvider } from './base';
import type { IProviderCapabilities, IProviderConfig, IModelInfo, ChatCompletionRequest, ChatCompletionResponse, EmbeddingRequest, EmbeddingResponse } from '../types';
import { fetchWithAgent } from '../utils/http-client';

/**
 * OpenAI 兼容 Provider 的字段配置
 * 声明该 Provider 支持哪些可选请求字段
 */
export interface OpenAICompatibleFieldConfig {
  /** 支持 presence_penalty 字段 */
  presencePenalty?: boolean;
  /** 支持 frequency_penalty 字段 */
  frequencyPenalty?: boolean;
  /** 支持 user 字段 */
  user?: boolean;
  /** 支持 tools/tool_choice 字段 */
  tools?: boolean;
  /** 支持 logprobs 字段 */
  logprobs?: boolean;
}

/**
 * OpenAI 兼容 Provider 配置
 */
export interface OpenAICompatibleProviderConfig {
  name: string;
  capabilities: IProviderCapabilities;
  fields?: OpenAICompatibleFieldConfig;
  /** 自定义请求头 */
  extraHeaders?: Record<string, string>;
  /** 自定义错误解析（默认解析 error.message 或 message） */
  parseError?: (response: Response, body: Record<string, unknown>) => string;
}

/**
 * OpenAI 兼容 Provider 实现
 * 适用于 API 格式与 OpenAI /chat/completions 和 /embeddings 端点一致的 Provider
 */
export class OpenAICompatibleProvider extends BaseProvider {
  name: string;
  capabilities: IProviderCapabilities;
  private fieldConfig: OpenAICompatibleFieldConfig;
  private extraHeaders: Record<string, string>;
  private parseError: (response: Response, body: Record<string, unknown>) => string;

  constructor(config: OpenAICompatibleProviderConfig) {
    super();
    this.name = config.name;
    this.capabilities = config.capabilities;
    this.fieldConfig = config.fields ?? {};
    this.extraHeaders = config.extraHeaders ?? {};
    this.parseError = config.parseError ?? ((res, body) => {
      const errBody = body as { error?: { message?: string }; message?: string };
      return errBody.error?.message || errBody.message || `HTTP ${res.status}: ${res.statusText}`;
    });
  }

  /**
   * 根据字段配置构建请求体
   */
  protected buildChatBody(request: ChatCompletionRequest, stream: boolean): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: request.model,
      messages: request.messages,
      stream,
    };

    if (request.temperature !== undefined) body.temperature = request.temperature;
    if (request.top_p !== undefined) body.top_p = request.top_p;
    if (request.max_tokens !== undefined) body.max_tokens = request.max_tokens;
    if (request.stop !== undefined) body.stop = request.stop;

    // 可选字段——根据配置决定是否包含
    if (this.fieldConfig.presencePenalty && request.presence_penalty !== undefined) {
      body.presence_penalty = request.presence_penalty;
    }
    if (this.fieldConfig.frequencyPenalty && request.frequency_penalty !== undefined) {
      body.frequency_penalty = request.frequency_penalty;
    }
    if (this.fieldConfig.user && request.user !== undefined) {
      body.user = request.user;
    }
    if (this.fieldConfig.tools) {
      if (request.tools && request.tools.length > 0) {
        body.tools = request.tools;
      }
      if (request.tool_choice) {
        body.tool_choice = request.tool_choice;
      }
    }

    return body;
  }

  /**
   * 处理非流式聊天请求
   */
  async chat(request: ChatCompletionRequest, config: IProviderConfig): Promise<ChatCompletionResponse> {
    const url = `${config.base_url}/chat/completions`;
    const body = this.buildChatBody(request, false);

    return this.fetch<ChatCompletionResponse>(url, {
      method: 'POST',
      headers: { ...this.buildHeaders(config), ...this.extraHeaders },
      body: JSON.stringify(body),
    }, config.timeout);
  }

  /**
   * 处理流式聊天请求
   */
  async chatStream(request: ChatCompletionRequest, config: IProviderConfig, options?: { signal?: AbortSignal }): Promise<ReadableStream> {
    const url = `${config.base_url}/chat/completions`;
    const body = this.buildChatBody(request, true);

    const response = await fetchWithAgent(url, {
      method: 'POST',
      headers: { ...this.buildHeaders(config), ...this.extraHeaders },
      body: JSON.stringify(body),
      signal: options?.signal,
    });

    if (!response.ok) {
      const errBody = await response.json().catch(() => ({})) as Record<string, unknown>;
      throw new Error(this.parseError(response, errBody));
    }

    return this.parseStream(response.body as ReadableStream<Uint8Array>);
  }

  /**
   * 处理 Embedding 请求
   * 如果 Provider 不支持（capabilities.embed = false），则抛出错误
   */
  async embed(request: EmbeddingRequest, config: IProviderConfig): Promise<EmbeddingResponse> {
    if (!this.capabilities.embed) {
      throw new Error(`${this.name} does not support embeddings`);
    }
    const url = `${config.base_url}/embeddings`;

    const body: Record<string, unknown> = {
      model: request.model,
      input: request.input,
      encoding_format: request.encoding_format || 'float',
    };

    if (request.dimensions !== undefined) {
      body.dimensions = request.dimensions;
    }

    return this.fetch<EmbeddingResponse>(url, {
      method: 'POST',
      headers: { ...this.buildHeaders(config), ...this.extraHeaders },
      body: JSON.stringify(body),
    }, config.timeout);
  }

  async listModels(config: IProviderConfig): Promise<IModelInfo[]> {
    const url = `${config.base_url}/models`;
    const response = await this.fetch<{
      data: Array<{
        id: string;
        object?: string;
        owned_by?: string;
        created?: number;
        status?: string;
      }>;
    }>(
      url,
      { method: 'GET', headers: { ...this.buildHeaders(config), ...this.extraHeaders } },
      config.timeout
    );
    return response.data
      .filter((m) => !m.status || m.status === 'Enabled')
      .map((m) => ({
        id: m.id,
        owned_by: m.owned_by,
        created: m.created,
        status: m.status,
      }));
  }
}
