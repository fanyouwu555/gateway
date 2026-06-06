/**
 * Google Gemini Provider 实现
 * Gemini uses a different API format than OpenAI
 */
import { BaseProvider } from '../base';
import type {
  IProviderCapabilities,
  IProviderConfig,
  IModelInfo,
  ChatCompletionRequest,
  ChatCompletionResponse,
  EmbeddingRequest,
  EmbeddingResponse,
} from '../../types';
import { contentToString } from '../../utils';
import { fetchWithAgent } from '../../utils/http-client';

interface GeminiContent {
  role: 'user' | 'model';
  parts: { text: string }[];
}

interface GeminiRequest {
  contents: GeminiContent[];
  systemInstruction?: {
    parts: [{ text: string }];
  };
  generationConfig?: {
    temperature?: number;
    topP?: number;
    maxOutputTokens?: number;
    stopSequences?: string[];
  };
}

interface GeminiResponse {
  candidates: Array<{
    content: GeminiContent;
    finishReason: string;
  }>;
  usageMetadata?: {
    promptTokenCount: number;
    candidatesTokenCount: number;
    totalTokenCount: number;
  };
}

export class GoogleProvider extends BaseProvider {
  name = 'google';

  capabilities: IProviderCapabilities = {
    chat: true,
    embed: false,
    streaming: true,
    vision: true,
    function_call: false,
  };

  /**
   * 从消息列表中提取系统指令文本
   */
  private extractSystemInstruction(messages: ChatCompletionRequest['messages']): string {
    return messages
      .filter((m) => m.role === 'system')
      .map((m) => contentToString(m.content))
      .filter(Boolean)
      .join('\n\n');
  }

  /**
   * 转换 OpenAI 消息格式到 Gemini 格式，跳过 system 消息
   */
  private convertMessages(messages: ChatCompletionRequest['messages']): GeminiContent[] {
    const contents: GeminiContent[] = [];

    for (const msg of messages) {
      if (msg.role === 'system') {
        continue;
      }

      const role: 'user' | 'model' = msg.role === 'assistant' ? 'model' : 'user';
      contents.push({
        role,
        parts: [{ text: contentToString(msg.content) }],
      });
    }

    return contents;
  }

  /**
   * 转换 Gemini 响应到 OpenAI 格式
   */
  private convertResponse(model: string, geminiResp: GeminiResponse): ChatCompletionResponse {
    const candidate = geminiResp.candidates[0];
    return {
      id: `chatcmpl-${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: candidate?.content?.parts?.[0]?.text || '',
          },
          finish_reason: candidate?.finishReason === 'STOP' ? 'stop' : 'length',
        },
      ],
      usage: {
        prompt_tokens: geminiResp.usageMetadata?.promptTokenCount || 0,
        completion_tokens: geminiResp.usageMetadata?.candidatesTokenCount || 0,
        total_tokens: geminiResp.usageMetadata?.totalTokenCount || 0,
      },
    };
  }

  async chat(
    request: ChatCompletionRequest,
    config: IProviderConfig
  ): Promise<ChatCompletionResponse> {
    const model = request.model || 'gemini-2.0-flash';
    const url = `${config.base_url}/models/${model}:generateContent`;

    const systemInstruction = this.extractSystemInstruction(request.messages);

    const geminiRequest: GeminiRequest = {
      contents: this.convertMessages(request.messages),
      ...(systemInstruction ? { systemInstruction: { parts: [{ text: systemInstruction }] } } : {}),
      generationConfig: {
        temperature: request.temperature,
        topP: request.top_p,
        maxOutputTokens: request.max_tokens,
        stopSequences: request.stop ? (Array.isArray(request.stop) ? request.stop : [request.stop]) : undefined,
      },
    };

    const geminiResp = await this.fetch<GeminiResponse>(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': config.api_key || '',
      },
      body: JSON.stringify(geminiRequest),
    }, config.timeout);

    return this.convertResponse(model, geminiResp);
  }

  async chatStream(
    request: ChatCompletionRequest,
    config: IProviderConfig,
    options?: { signal?: AbortSignal }
  ): Promise<ReadableStream> {
    const model = request.model || 'gemini-2.0-flash';
    const url = `${config.base_url}/models/${model}:streamGenerateContent?alt=sse`;

    const systemInstruction = this.extractSystemInstruction(request.messages);

    const geminiRequest: GeminiRequest = {
      contents: this.convertMessages(request.messages),
      ...(systemInstruction ? { systemInstruction: { parts: [{ text: systemInstruction }] } } : {}),
      generationConfig: {
        temperature: request.temperature,
        topP: request.top_p,
        maxOutputTokens: request.max_tokens,
      },
    };

    const response = await fetchWithAgent(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': config.api_key || '',
      },
      body: JSON.stringify(geminiRequest),
      signal: options?.signal,
    });

    if (!response.ok) {
      const errBody = await response.json().catch(() => ({})) as { error?: { message?: string } };
      throw new Error(errBody.error?.message || `HTTP ${response.status}: ${response.statusText}`);
    }

    // 转换 Gemini 流到 OpenAI 格式
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    return new ReadableStream({
      async pull(controller) {
        try {
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
            if (!trimmed || trimmed === 'data: [DONE]') continue;

            try {
              const data = JSON.parse(trimmed.replace(/^data:\s*/, ''));
              const chunk = {
                id: `chatcmpl-${Date.now()}`,
                object: 'chat.completion.chunk',
                created: Math.floor(Date.now() / 1000),
                model,
                choices: [
                  {
                    index: 0,
                    delta: {
                      role: 'assistant',
                      content: data.candidates?.[0]?.content?.parts?.[0]?.text || '',
                    },
                    finish_reason: data.candidates?.[0]?.finishReason === 'STOP' ? 'stop' : null,
                  },
                ],
              };
              controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(chunk)}\n\n`));
            } catch {
              // Skip non-JSON lines
            }
          }
        } catch (error) {
          controller.error(error);
        }
      },
    });
  }

  async embed(
    _request: EmbeddingRequest,
    _config: IProviderConfig
  ): Promise<EmbeddingResponse> {
    throw new Error('Google Gemini does not support embeddings via the chat API');
  }

  async listModels(config: IProviderConfig): Promise<IModelInfo[]> {
    const url = `${config.base_url}/models`;
    const response = await this.fetch<{
      models: Array<{
        name: string;
        supportedGenerationMethods?: string[];
        inputTokenLimit?: number;
        outputTokenLimit?: number;
      }>;
    }>(url, {
      method: 'GET',
      headers: { 'x-goog-api-key': config.api_key || '' },
    }, config.timeout);

    return response.models
      .filter((m) => m.supportedGenerationMethods?.includes('generateContent'))
      .map((m) => ({
        id: m.name.replace('models/', ''),
        owned_by: 'google',
        context_window: m.inputTokenLimit,
        max_output_tokens: m.outputTokenLimit,
      }));
  }
}

export const googleProvider = new GoogleProvider();
