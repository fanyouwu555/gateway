/**
 * Anthropic Provider 实现
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
import { contentToString, safeJsonParse } from '../../utils';
import { fetchWithAgent } from '../../utils/http-client';

/** Anthropic content block */
type AnthropicContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string };

export class AnthropicProvider extends BaseProvider {
  name = 'anthropic';

  capabilities: IProviderCapabilities = {
    chat: true,
    embed: false,
    streaming: true,
    vision: true,
    function_call: true,
  };

  private static KNOWN_MODELS: IModelInfo[] = [
    { id: 'claude-3-opus-20240229', owned_by: 'anthropic', context_window: 200000, max_output_tokens: 4096, capabilities: { vision: true } },
    { id: 'claude-3-sonnet-20240229', owned_by: 'anthropic', context_window: 200000, max_output_tokens: 4096, capabilities: { vision: true } },
    { id: 'claude-3-haiku-20240307', owned_by: 'anthropic', context_window: 200000, max_output_tokens: 4096, capabilities: { vision: true } },
    { id: 'claude-3.5-sonnet-20241022', owned_by: 'anthropic', context_window: 200000, max_output_tokens: 8192, capabilities: { vision: true, function_call: true } },
    { id: 'claude-3.5-haiku-20241022', owned_by: 'anthropic', context_window: 200000, max_output_tokens: 8192 },
    { id: 'claude-4-sonnet-20250514', owned_by: 'anthropic', context_window: 200000, max_output_tokens: 16384, capabilities: { vision: true, function_call: true } },
    { id: 'claude-4-opus-20250514', owned_by: 'anthropic', context_window: 200000, max_output_tokens: 16384, capabilities: { vision: true, function_call: true } },
  ];

  /**
   * 从消息列表中提取系统提示文本
   */
  private extractSystemPrompt(messages: ChatCompletionRequest['messages']): string {
    return messages
      .filter((m) => m.role === 'system')
      .map((m) => contentToString(m.content))
      .filter(Boolean)
      .join('\n\n');
  }

  /**
   * 转换消息格式（OpenAI -> Anthropic），跳过 system 消息
   * 支持 tool_calls / tool_result / image_url 转换
   */
  private convertMessages(messages: ChatCompletionRequest['messages']): {
    role: 'user' | 'assistant';
    content: string | AnthropicContentBlock[];
  }[] {
    return messages
      .filter((msg) => msg.role !== 'system')
      .map((msg) => {
        // tool 角色 → user 角色 + tool_result block
        if (msg.role === 'tool') {
          return {
            role: 'user' as const,
            content: [{
              type: 'tool_result' as const,
              tool_use_id: msg.tool_call_id || '',
              content: contentToString(msg.content),
            }],
          };
        }

        // assistant 角色含 tool_calls → tool_use blocks + text
        if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
          const blocks: AnthropicContentBlock[] = [];
          const text = contentToString(msg.content);
          if (text) {
            blocks.push({ type: 'text', text });
          }
          for (const tc of msg.tool_calls) {
            blocks.push({
              type: 'tool_use',
              id: tc.id,
              name: tc.function.name,
              input: safeJsonParse(tc.function.arguments, {}),
            });
          }
          return {
            role: 'assistant' as const,
            content: blocks,
          };
        }

        return {
          role: msg.role === 'assistant' ? ('assistant' as const) : ('user' as const),
          content: contentToString(msg.content),
        };
      });
  }

  async chat(
    request: ChatCompletionRequest,
    config: IProviderConfig
  ): Promise<ChatCompletionResponse> {
    const url = `${config.base_url}/messages`;

    const systemPrompt = this.extractSystemPrompt(request.messages);
    const messages = this.convertMessages(request.messages);

    const body: Record<string, unknown> = {
      model: request.model,
      messages,
      max_tokens: request.max_tokens || 1024,
      ...(systemPrompt ? { system: systemPrompt } : {}),
    };

    if (request.temperature !== undefined) {
      body.temperature = request.temperature;
    }

    if (request.top_p !== undefined) {
      body.top_p = request.top_p;
    }

    // 转换 tools 定义（OpenAI 格式 → Anthropic 格式）
    if (request.tools && request.tools.length > 0) {
      body.tools = request.tools.map((t) => ({
        name: t.function.name,
        description: t.function.description,
        input_schema: t.function.parameters,
      }));
    }

    // 转换 tool_choice
    if (request.tool_choice) {
      if (request.tool_choice === 'none') {
        body.tool_choice = { type: 'none' };
      } else if (request.tool_choice === 'auto') {
        body.tool_choice = { type: 'auto' };
      } else if (request.tool_choice === 'required') {
        body.tool_choice = { type: 'any' };
      } else if (typeof request.tool_choice === 'object' && request.tool_choice.type === 'function') {
        body.tool_choice = { type: 'tool', name: request.tool_choice.function.name };
      }
    }

    const response = await this.fetch<{
      id: string;
      type: string;
      role: string;
      content: AnthropicContentBlock[];
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

    // 从 Anthropic content blocks 中提取 text 和 tool_use
    const textBlocks = response.content.filter((c): c is { type: 'text'; text: string } => c.type === 'text');
    const toolUseBlocks = response.content.filter((c): c is { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> } => c.type === 'tool_use');

    const message: { role: 'assistant'; content: string; tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }> } = {
      role: 'assistant',
      content: textBlocks.map((b) => b.text).join('') || '',
    };

    if (toolUseBlocks.length > 0) {
      message.tool_calls = toolUseBlocks.map((b) => ({
        id: b.id,
        type: 'function' as const,
        function: {
          name: b.name,
          arguments: JSON.stringify(b.input),
        },
      }));
    }

    // 转换为 OpenAI 格式
    return {
      id: response.id,
      object: 'chat.completion',
      created: Date.now(),
      model: response.model,
      choices: [
        {
          index: 0,
          message,
          finish_reason:
            response.stop_reason === 'end_turn'
              ? 'stop'
              : response.stop_reason === 'max_tokens'
                ? 'length'
                : response.stop_reason === 'tool_use'
                  ? 'tool_calls'
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
    config: IProviderConfig,
    options?: { signal?: AbortSignal }
  ): Promise<ReadableStream> {
    const url = `${config.base_url}/messages`;

    const systemPrompt = this.extractSystemPrompt(request.messages);
    const messages = this.convertMessages(request.messages);

    const body: Record<string, unknown> = {
      model: request.model,
      messages,
      max_tokens: request.max_tokens || 1024,
      stream: true,
      ...(systemPrompt ? { system: systemPrompt } : {}),
    };

    if (request.temperature !== undefined) {
      body.temperature = request.temperature;
    }

    if (request.top_p !== undefined) {
      body.top_p = request.top_p;
    }

    // 转换 tools 定义（OpenAI 格式 → Anthropic 格式）
    if (request.tools && request.tools.length > 0) {
      body.tools = request.tools.map((t) => ({
        name: t.function.name,
        description: t.function.description,
        input_schema: t.function.parameters,
      }));
    }

    // 转换 tool_choice
    if (request.tool_choice) {
      if (request.tool_choice === 'none') {
        body.tool_choice = { type: 'none' };
      } else if (request.tool_choice === 'auto') {
        body.tool_choice = { type: 'auto' };
      } else if (request.tool_choice === 'required') {
        body.tool_choice = { type: 'any' };
      } else if (typeof request.tool_choice === 'object' && request.tool_choice.type === 'function') {
        body.tool_choice = { type: 'tool', name: request.tool_choice.function.name };
      }
    }

    const response = await fetchWithAgent(url, {
      method: 'POST',
      headers: {
        ...this.buildHeaders(config),
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01',
        'x-api-key': config.api_key || '',
      },
      body: JSON.stringify(body),
      signal: options?.signal,
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
   * 支持 text、tool_use、thinking content blocks 的转换
   */
  private parseAnthropicStream(body: ReadableStream<Uint8Array>): ReadableStream {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let currentId = '';
    let currentModel = '';

    const buildChunk = (choices: Array<Record<string, unknown>>) => ({
      id: currentId,
      object: 'chat.completion.chunk',
      created: Date.now(),
      model: currentModel,
      choices,
    });

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

              // 跟踪当前消息的 id 和 model
              if (parsed.type === 'message_start' && parsed.message) {
                currentId = parsed.message.id || '';
                currentModel = parsed.message.model || '';
                continue;
              }

              // content_block_start: tool_use 初始信息
              if (parsed.type === 'content_block_start' && parsed.content_block?.type === 'tool_use') {
                const block = parsed.content_block;
                const chunk = buildChunk([
                  {
                    index: parsed.index ?? 0,
                    delta: {
                      tool_calls: [{
                        index: parsed.index ?? 0,
                        id: block.id,
                        type: 'function',
                        function: { name: block.name },
                      }],
                    },
                    finish_reason: null,
                  },
                ]);
                controller.enqueue(
                  new TextEncoder().encode(`data: ${JSON.stringify(chunk)}\n\n`)
                );
                continue;
              }

              // content_block_delta: text 或 input_json_delta
              if (parsed.type === 'content_block_delta') {
                const delta = parsed.delta;
                // 兼容新旧格式：有 type 字段或只有 text 字段
                if (delta?.type === 'text_delta' || (delta?.text && !delta?.type)) {
                  const chunk = buildChunk([
                    {
                      index: parsed.index ?? 0,
                      delta: {
                        role: 'assistant',
                        content: delta.text || '',
                      },
                      finish_reason: null,
                    },
                  ]);
                  controller.enqueue(
                    new TextEncoder().encode(`data: ${JSON.stringify(chunk)}\n\n`)
                  );
                } else if (delta?.type === 'input_json_delta') {
                  const chunk = buildChunk([
                    {
                      index: parsed.index ?? 0,
                      delta: {
                        tool_calls: [{
                          index: parsed.index ?? 0,
                          function: { arguments: delta.partial_json || '' },
                        }],
                      },
                      finish_reason: null,
                    },
                  ]);
                  controller.enqueue(
                    new TextEncoder().encode(`data: ${JSON.stringify(chunk)}\n\n`)
                  );
                }
                continue;
              }

              // message_delta: stop_reason 和 usage
              if (parsed.type === 'message_delta') {
                const stopReason = parsed.delta?.stop_reason;
                const finishReason =
                  stopReason === 'end_turn'
                    ? 'stop'
                    : stopReason === 'max_tokens'
                      ? 'length'
                      : stopReason === 'tool_use'
                        ? 'tool_calls'
                        : null;
                const chunk = buildChunk([
                  {
                    index: 0,
                    delta: {},
                    finish_reason: finishReason,
                  },
                ]);
                controller.enqueue(
                  new TextEncoder().encode(`data: ${JSON.stringify(chunk)}\n\n`)
                );
                continue;
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

  async listModels(): Promise<IModelInfo[]> {
    return AnthropicProvider.KNOWN_MODELS;
  }
}

// 导出单例
export const anthropicProvider = new AnthropicProvider();