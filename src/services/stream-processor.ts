import type { ChatCompletionChunk, ChatToolCall } from '../types';
import { accumulateStreamContent } from './token-counter';

export interface StreamProcessOptions {
  onChunk?: (chunk: ChatCompletionChunk) => void;
  signal?: AbortSignal;
}

export interface StreamResult {
  content: string;
  reasoningContent: string;
  finishReason: string | null;
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  toolCalls?: Array<ChatToolCall>;
  error?: Error;
}

export async function processSSEStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  options?: StreamProcessOptions,
): Promise<StreamResult> {
  const decoder = new TextDecoder();
  let textBuffer = '';
  let content = '';
  let reasoningContent = '';
  let finishReason: string | null = null;
  const toolCalls: ChatToolCall[] = [];
  let usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number } | undefined;

  let onAbort: (() => void) | undefined;
  if (options?.signal) {
    onAbort = () => { reader.cancel().catch(() => {}); };
    options.signal.addEventListener('abort', onAbort, { once: true });
  }

  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      if (options?.signal?.aborted) {
        throw new Error('Stream aborted');
      }

      const { done, value } = await reader.read();
      if (done) {
        if (options?.signal?.aborted) {
          throw new Error('Stream aborted');
        }
        break;
      }

      textBuffer += decoder.decode(value, { stream: true });
      const lines = textBuffer.split('\n');
      textBuffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('data: ') && !trimmed.startsWith('data: [DONE]')) {
          try {
            const parsed = JSON.parse(trimmed.slice(6)) as ChatCompletionChunk & {
              usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
            };

            if (parsed.usage) {
              usage = {
                prompt_tokens: parsed.usage.prompt_tokens || 0,
                completion_tokens: parsed.usage.completion_tokens || 0,
                total_tokens: parsed.usage.total_tokens || 0,
              };
            }

            for (const choice of parsed.choices || []) {
              if (choice.finish_reason) {
                finishReason = choice.finish_reason;
              }
              const delta = choice.delta;
              content = accumulateStreamContent(content, delta);
              if (delta.reasoning_content && typeof delta.reasoning_content === 'string') {
                reasoningContent += delta.reasoning_content;
              }
              if (delta.tool_calls && Array.isArray(delta.tool_calls)) {
                for (const tc of delta.tool_calls as Array<ChatToolCall & { index?: number }>) {
                  const idx = tc.index ?? 0;
                  if (!toolCalls[idx]) {
                    toolCalls[idx] = {
                      id: tc.id || '',
                      type: 'function',
                      function: { name: '', arguments: '' },
                    };
                  }
                  if (tc.id) toolCalls[idx].id = tc.id;
                  if (tc.function?.name) toolCalls[idx].function.name += tc.function.name;
                  if (tc.function?.arguments) toolCalls[idx].function.arguments += tc.function.arguments;
                }
              }
            }

            options?.onChunk?.(parsed);
          } catch {
            // silently ignore malformed SSE lines
          }
        }
      }
    }
  } catch (err) {
    return {
      content,
      reasoningContent,
      finishReason,
      usage: usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      error: err instanceof Error ? err : new Error(String(err)),
    };
  } finally {
    if (onAbort && options?.signal) {
      options.signal.removeEventListener('abort', onAbort);
    }
    reader.cancel().catch(() => {});
  }

  return {
    content,
    reasoningContent,
    finishReason,
    usage: usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
  };
}
