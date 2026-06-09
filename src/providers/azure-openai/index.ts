/**
 * Azure OpenAI Provider
 * API format is OpenAI-compatible, but URL structure and auth differ:
 * - Base URL: https://{resource}.openai.azure.com/openai/deployments/{deployment}
 * - Auth header: api-key instead of Authorization: Bearer
 * - API version query param required
 */
import { OpenAICompatibleProvider } from '../openai-compatible';
import type { IProviderConfig, ChatCompletionRequest, ChatCompletionResponse, EmbeddingRequest, EmbeddingResponse } from '../../types';
import { fetchWithAgent } from '../../utils/http-client';

const DEFAULT_API_VERSION = '2024-02-01';

function buildAzureUrl(resource: string, deployment: string, path: string, apiVersion: string): string {
  return `https://${resource}.openai.azure.com/openai/deployments/${deployment}${path}?api-version=${apiVersion}`;
}

export class AzureOpenAIProvider extends OpenAICompatibleProvider {
  private resource: string;
  private deployment: string;
  private apiKey: string;
  private apiVersion: string;

  constructor() {
    const resource = process.env.AZURE_OPENAI_RESOURCE || '';
    const deployment = process.env.AZURE_OPENAI_DEPLOYMENT || '';
    const apiKey = process.env.AZURE_OPENAI_API_KEY || '';
    const apiVersion = process.env.AZURE_OPENAI_API_VERSION || DEFAULT_API_VERSION;

    super({
      name: 'azure-openai',
      capabilities: {
        chat: true,
        embed: true,
        streaming: true,
        vision: true,
        function_call: true,
      },
      fields: {
        presencePenalty: true,
        frequencyPenalty: true,
        user: true,
        tools: true,
      },
    });

    this.resource = resource;
    this.deployment = deployment;
    this.apiKey = apiKey;
    this.apiVersion = apiVersion;
  }

  private buildAzureUrl(path: string): string {
    return buildAzureUrl(this.resource, this.deployment, path, this.apiVersion);
  }

  private buildAzureHeaders(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'api-key': this.apiKey,
    };
  }

  async chat(request: ChatCompletionRequest, _config: IProviderConfig): Promise<ChatCompletionResponse> {
    const url = this.buildAzureUrl('/chat/completions');
    const body = (this as unknown as { buildChatBody: (request: ChatCompletionRequest, stream: boolean) => Record<string, unknown> }).buildChatBody(request, false);

    return this.fetch<ChatCompletionResponse>(url, {
      method: 'POST',
      headers: this.buildAzureHeaders(),
      body: JSON.stringify(body),
    }, _config.timeout);
  }

  async chatStream(request: ChatCompletionRequest, _config: IProviderConfig, options?: { signal?: AbortSignal }): Promise<ReadableStream> {
    const url = this.buildAzureUrl('/chat/completions');
    const body = (this as unknown as { buildChatBody: (request: ChatCompletionRequest, stream: boolean) => Record<string, unknown> }).buildChatBody(request, true);

    const response = await fetchWithAgent(url, {
      method: 'POST',
      headers: this.buildAzureHeaders(),
      body: JSON.stringify(body),
      signal: options?.signal,
    });

    if (!response.ok) {
      const errBody = await response.json().catch(() => ({})) as Record<string, unknown>;
      const errBodyTyped = errBody as { error?: { message?: string }; message?: string };
      const message = errBodyTyped.error?.message || errBodyTyped.message || `HTTP ${response.status}: ${response.statusText}`;
      throw new Error(message);
    }

    return this.parseStream(response.body as ReadableStream<Uint8Array>);
  }

  async embed(request: EmbeddingRequest, _config: IProviderConfig): Promise<EmbeddingResponse> {
    if (!this.capabilities.embed) {
      throw new Error(`${this.name} does not support embeddings`);
    }
    const url = this.buildAzureUrl('/embeddings');

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
      headers: this.buildAzureHeaders(),
      body: JSON.stringify(body),
    }, _config.timeout);
  }
}

export const azureOpenAIProvider = new AzureOpenAIProvider();
