/**
 * Anthropic Provider 实现
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

export class AnthropicProvider extends BaseProvider {
  name = 'anthropic';

  capabilities: IProviderCapabilities = {
    chat: true,
    embed: false, // Anthropic 不支持 Embedding API
    streaming: true,
    vision: true,
    function_call: false,
  };

  /**
   * 转换消息格式（OpenAI -> Anthropic）
   */
  private convertMessages(messages: ChatCompletionRequest['messages']): {
    role: 'user' | 'assistant';
    content: string;
  }[] {
    return messages.map((msg) => {
      if (msg.role === 'system') {
        // Anthropic 使用 system 消息，但需要特殊处理
        return { role: 'user' as const, content: msg.content };
      }
      return {
        role: msg.role === 'assistant' ? 'assistant' as const : 'user' as const,
        content: msg.content,
      };
    });
  }

  async chat(
    request: ChatCompletionRequest,
    config: IProviderConfig
  ): Promise<ChatCompletionResponse> {
    const url = `${config.base_url}/messages`;

    const messages = this.convertMessages(request.messages);

    const body: Record<string, unknown> = {
      model: request.model,
      messages,
      max_tokens: request.max_tokens || 1024,
    };

    if (request.temperature !== undefined) {
      body.temperature = request.temperature;
    }

    if (request.top_p !== undefined) {
      body.top_p = request.top_p;
    }

    const response = await this.fetch<{
      id: string;
      type: string;
      role: string;
      content: { type: string; text: string }[];
      model: string;
      stop_reason: string;
      stop_sequence: string | null;
      usage: { input_tokens: number; output_tokens: number };
    }>(url, {
      method: 'POST',
      headers: {
        ...this.buildHeaders(config),
        'anthropic-version': '2023-06-01',
        'x-api-key': config.api_key || '',
      },
      body: JSON.stringify(body),
    }, config.timeout);

    // 转换为 OpenAI 格式
    return {
      id: response.id,
      object: 'chat.completion',
      created: Date.now(),
      model: response.model,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: response.content[0]?.text || '',
          },
          finish_reason:
            response.stop_reason === 'end_turn'
              ? 'stop'
              : response.stop_reason === 'max_tokens'
                ? 'length'
                : null,
        },
      ],
      usage: {
        prompt_tokens: response.usage.input_tokens,
        completion_tokens: response.usage.output_tokens,
        total_tokens: response.usage.input_tokens + response.usage.output_tokens,
      },
    };
  }

  async chatStream(
    request: ChatCompletionRequest,
    config: IProviderConfig
  ): Promise<ReadableStream> {
    const url = `${config.base_url}/messages`;

    const messages = this.convertMessages(request.messages);

    const body: Record<string, unknown> = {
      model: request.model,
      messages,
      max_tokens: request.max_tokens || 1024,
      stream: true,
    };

    if (request.temperature !== undefined) {
      body.temperature = request.temperature;
    }

    if (request.top_p !== undefined) {
      body.top_p = request.top_p;
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        ...this.buildHeaders(config),
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01',
        'x-api-key': config.api_key || '',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errBody = await response.json().catch(() => ({})) as { error?: { message?: string } };
      throw new Error(
        errBody.error?.message || `HTTP ${response.status}: ${response.statusText}`
      );
    }

    return this.parseAnthropicStream(response.body as ReadableStream<Uint8Array>);
  }

  /**
   * 解析 Anthropic 流式响应
   */
  private parseAnthropicStream(body: ReadableStream<Uint8Array>): ReadableStream {
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
          if (trimmed.startsWith('data: ')) {
            const data = trimmed.slice(6);
            try {
              const parsed = JSON.parse(data);

              if (parsed.type === 'content_block_delta') {
                const chunk = {
                  id: parsed.id || '',
                  object: 'chat.completion.chunk',
                  created: Date.now(),
                  model: parsed.model || '',
                  choices: [
                    {
                      index: 0,
                      delta: {
                        role: 'assistant',
                        content: parsed.delta?.text || '',
                      },
                      finish_reason: null,
                    },
                  ],
                };
                controller.enqueue(
                  new TextEncoder().encode(`data: ${JSON.stringify(chunk)}\n\n`)
                );
              } else if (parsed.type === 'message_delta') {
                const chunk = {
                  id: parsed.id || '',
                  object: 'chat.completion.chunk',
                  created: Date.now(),
                  model: parsed.model || '',
                  choices: [
                    {
                      index: 0,
                      delta: {},
                      finish_reason:
                        parsed.delta?.stop_reason === 'end_turn'
                          ? 'stop'
                          : parsed.delta?.stop_reason === 'max_tokens'
                            ? 'length'
                            : null,
                    },
                  ],
                };
                controller.enqueue(
                  new TextEncoder().encode(`data: ${JSON.stringify(chunk)}\n\n`)
                );
              }
            } catch {
              // 忽略解析错误
            }
          }
        }
      },
      cancel() {
        reader.cancel();
      },
    });
  }

  async embed(
    _request: EmbeddingRequest,
    _config: IProviderConfig
  ): Promise<EmbeddingResponse> {
    throw new Error('Anthropic does not support Embedding API');
  }
}

// 导出单例
export const anthropicProvider = new AnthropicProvider();