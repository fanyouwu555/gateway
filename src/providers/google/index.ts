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
import { contentToString, safeJsonParse, fetchImageAsBase64 } from '../../utils';
import { fetchWithAgent } from '../../utils/http-client';

interface GeminiPart {
  text?: string;
  inlineData?: { mimeType: string; data: string };
  functionCall?: { name: string; args: Record<string, unknown> };
  functionResponse?: { name: string; response: Record<string, unknown> };
}

interface GeminiContent {
  role: 'user' | 'model';
  parts: GeminiPart[];
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
  tools?: Array<{
    functionDeclarations: Array<{
      name: string;
      description: string;
      parameters: Record<string, unknown>;
    }>;
  }>;
  toolConfig?: {
    functionCallingConfig: {
      mode: string;
      allowedFunctionNames?: string[];
    };
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
    function_call: true,
    reasoning: false,
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
   * 支持 tool_calls / function_call / function_response / image_url 转换
   */
  private async convertMessages(messages: ChatCompletionRequest['messages']): Promise<GeminiContent[]> {
    // 构建 tool_call_id → name 映射，用于 tool 角色消息转换
    const toolCallIdToName = new Map<string, string>();
    for (const msg of messages) {
      if (msg.role === 'assistant' && msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          toolCallIdToName.set(tc.id, tc.function.name);
        }
      }
    }

    const contents: GeminiContent[] = [];

    for (const msg of messages) {
      if (msg.role === 'system') {
        continue;
      }

      // tool 角色 → user 角色 + functionResponse part
      if (msg.role === 'tool') {
        const name = toolCallIdToName.get(msg.tool_call_id || '') || 'unknown';
        contents.push({
          role: 'user',
          parts: [{
            functionResponse: {
              name,
              response: { result: contentToString(msg.content) },
            },
          }],
        });
        continue;
      }

      // assistant 含 tool_calls → functionCall parts + text
      if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
        const parts: GeminiPart[] = [];
        const text = contentToString(msg.content);
        if (text) {
          parts.push({ text });
        }
        for (const tc of msg.tool_calls) {
          parts.push({
            functionCall: {
              name: tc.function.name,
              args: safeJsonParse(tc.function.arguments, {}),
            },
          });
        }
        contents.push({ role: 'model', parts });
        continue;
      }

      // 多模态 content（image_url）
      if (Array.isArray(msg.content)) {
        const parts: GeminiPart[] = [];
        for (const part of msg.content) {
          if (part.type === 'text' && part.text) {
            parts.push({ text: part.text });
          } else if (part.type === 'image_url' && part.image_url?.url) {
            const imageData = await fetchImageAsBase64(part.image_url.url);
            parts.push({
              inlineData: {
                mimeType: imageData.mimeType,
                data: imageData.data,
              },
            });
          }
        }
        const role: 'user' | 'model' = msg.role === 'assistant' ? 'model' : 'user';
        contents.push({ role, parts });
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
   * 支持 functionCall parts → tool_calls
   */
  private convertResponse(model: string, geminiResp: GeminiResponse): ChatCompletionResponse {
    const candidate = geminiResp.candidates[0];
    const parts = candidate?.content?.parts || [];

    const textParts = parts.filter((p): p is GeminiPart & { text: string } => typeof p.text === 'string');
    const functionCallParts = parts.filter((p): p is GeminiPart & { functionCall: { name: string; args: Record<string, unknown> } } => !!p.functionCall);

    const message: {
      role: 'assistant';
      content: string;
      tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
    } = {
      role: 'assistant',
      content: textParts.map((p) => p.text).join('') || '',
    };

    if (functionCallParts.length > 0) {
      message.tool_calls = functionCallParts.map((p, i) => ({
        id: `call_${i}`,
        type: 'function' as const,
        function: {
          name: p.functionCall.name,
          arguments: JSON.stringify(p.functionCall.args),
        },
      }));
    }

    const finishReason = candidate?.finishReason;

    return {
      id: `chatcmpl-${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [
        {
          index: 0,
          message,
          finish_reason:
            finishReason === 'STOP'
              ? 'stop'
              : finishReason === 'MAX_TOKENS'
                ? 'length'
                : null,
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
      contents: await this.convertMessages(request.messages),
      ...(systemInstruction ? { systemInstruction: { parts: [{ text: systemInstruction }] } } : {}),
      generationConfig: {
        temperature: request.temperature,
        topP: request.top_p,
        maxOutputTokens: request.max_tokens,
        stopSequences: request.stop ? (Array.isArray(request.stop) ? request.stop : [request.stop]) : undefined,
      },
    };

    // 转换 tools 定义
    if (request.tools && request.tools.length > 0) {
      geminiRequest.tools = [{
        functionDeclarations: request.tools.map((t) => ({
          name: t.function.name,
          description: t.function.description,
          parameters: t.function.parameters,
        })),
      }];
    }

    // 转换 tool_choice
    if (request.tool_choice) {
      if (request.tool_choice === 'none') {
        geminiRequest.toolConfig = { functionCallingConfig: { mode: 'NONE' } };
      } else if (request.tool_choice === 'auto') {
        geminiRequest.toolConfig = { functionCallingConfig: { mode: 'AUTO' } };
      } else if (request.tool_choice === 'required') {
        geminiRequest.toolConfig = { functionCallingConfig: { mode: 'ANY' } };
      } else if (typeof request.tool_choice === 'object' && request.tool_choice.type === 'function') {
        geminiRequest.toolConfig = {
          functionCallingConfig: {
            mode: 'ANY',
            allowedFunctionNames: [request.tool_choice.function.name],
          },
        };
      }
    }

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
      contents: await this.convertMessages(request.messages),
      ...(systemInstruction ? { systemInstruction: { parts: [{ text: systemInstruction }] } } : {}),
      generationConfig: {
        temperature: request.temperature,
        topP: request.top_p,
        maxOutputTokens: request.max_tokens,
      },
    };

    // 转换 tools 定义
    if (request.tools && request.tools.length > 0) {
      geminiRequest.tools = [{
        functionDeclarations: request.tools.map((t) => ({
          name: t.function.name,
          description: t.function.description,
          parameters: t.function.parameters,
        })),
      }];
    }

    // 转换 tool_choice
    if (request.tool_choice) {
      if (request.tool_choice === 'none') {
        geminiRequest.toolConfig = { functionCallingConfig: { mode: 'NONE' } };
      } else if (request.tool_choice === 'auto') {
        geminiRequest.toolConfig = { functionCallingConfig: { mode: 'AUTO' } };
      } else if (request.tool_choice === 'required') {
        geminiRequest.toolConfig = { functionCallingConfig: { mode: 'ANY' } };
      } else if (typeof request.tool_choice === 'object' && request.tool_choice.type === 'function') {
        geminiRequest.toolConfig = {
          functionCallingConfig: {
            mode: 'ANY',
            allowedFunctionNames: [request.tool_choice.function.name],
          },
        };
      }
    }

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
              const parts = data.candidates?.[0]?.content?.parts || [];
              const textParts = parts.filter((p: { text?: string }) => typeof p.text === 'string');
              const functionCallParts = parts.filter((p: { functionCall?: unknown }) => !!p.functionCall);

              const delta: Record<string, unknown> = { role: 'assistant' };
              if (textParts.length > 0) {
                delta.content = textParts.map((p: { text?: string }) => p.text).join('');
              }
              if (functionCallParts.length > 0) {
                delta.tool_calls = functionCallParts.map((p: { functionCall?: { name: string; args: Record<string, unknown> } }, i: number) => ({
                  index: i,
                  id: `call_${i}`,
                  type: 'function',
                  function: {
                    name: p.functionCall!.name,
                    arguments: JSON.stringify(p.functionCall!.args),
                  },
                }));
              }

              const finishReason = data.candidates?.[0]?.finishReason;
              const chunk = {
                id: `chatcmpl-${Date.now()}`,
                object: 'chat.completion.chunk',
                created: Math.floor(Date.now() / 1000),
                model,
                choices: [
                  {
                    index: 0,
                    delta,
                    finish_reason:
                      finishReason === 'STOP'
                        ? 'stop'
                        : finishReason === 'MAX_TOKENS'
                          ? 'length'
                          : null,
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
