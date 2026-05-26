/**
 * Google Gemini Provider 实现
 * Gemini uses a different API format than OpenAI
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
import { contentToString } from '../../utils';
import { fetchWithAgent } from '../../utils/http-client';

interface GeminiContent {
  role: 'user' | 'model';
  parts: { text: string }[];
}

interface GeminiRequest {
  contents: GeminiContent[];
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
   * 转换 OpenAI 消息格式到 Gemini 格式
   */
  private convertMessages(messages: ChatCompletionRequest['messages']): GeminiContent[] {
    const contents: GeminiContent[] = [];

    for (const msg of messages) {
      let role: 'user' | 'model' = 'user';
      if (msg.role === 'assistant') {
        role = 'model';
      } else if (msg.role === 'system') {
        // 将 system 消息作为 user 消息添加前缀
        contents.push({
          role: 'user',
          parts: [{ text: `System instruction: ${contentToString(msg.content)}` }],
        });
        continue;
      }

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

    const geminiRequest: GeminiRequest = {
      contents: this.convertMessages(request.messages),
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
    config: IProviderConfig
  ): Promise<ReadableStream> {
    const model = request.model || 'gemini-2.0-flash';
    const url = `${config.base_url}/models/${model}:streamGenerateContent?alt=sse`;

    const geminiRequest: GeminiRequest = {
      contents: this.convertMessages(request.messages),
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
}

export const googleProvider = new GoogleProvider();
