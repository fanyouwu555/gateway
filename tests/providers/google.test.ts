/**
 * Google Provider Tests
 */
import { GoogleProvider } from '../../src/providers/google';
import type { ChatCompletionRequest, EmbeddingRequest, IProviderConfig } from '../../src/types';

const mockFetchWithAgent = jest.fn();
jest.mock('../../src/utils/http-client', () => ({
  fetchWithAgent: (...args: unknown[]) => mockFetchWithAgent(...args),
}));

describe('GoogleProvider', () => {
  const providerConfig: IProviderConfig = {
    provider: 'google',
    base_url: 'https://generativelanguage.googleapis.com/v1beta',
    api_key: 'google-test-key',
  };

  beforeEach(() => {
    mockFetchWithAgent.mockReset();
  });

  describe('capabilities', () => {
    it('should be registered', () => {
      const provider = new GoogleProvider();
      expect(provider.name).toBe('google');
    });

    it('should support chat and streaming', () => {
      const provider = new GoogleProvider();
      expect(provider.capabilities.chat).toBe(true);
      expect(provider.capabilities.streaming).toBe(true);
    });

    it('should not support embed', () => {
      const provider = new GoogleProvider();
      expect(provider.capabilities.embed).toBe(false);
    });
  });

  describe('convertMessages', () => {
    it('should skip system messages (they are handled via systemInstruction parameter)', () => {
      const provider = new GoogleProvider();
      const request: ChatCompletionRequest = {
        model: 'gemini-2.0-flash',
        messages: [
          { role: 'system', content: 'You are helpful' },
          { role: 'user', content: 'hello' },
          { role: 'assistant', content: 'hi' },
        ],
      };

      const result = (provider as unknown as { convertMessages: (messages: ChatCompletionRequest['messages']) => { role: string; parts: { text: string }[] }[] }).convertMessages(request.messages);

      // System messages are skipped and sent via the 'systemInstruction' parameter instead
      expect(result).toEqual([
        { role: 'user', parts: [{ text: 'hello' }] },
        { role: 'model', parts: [{ text: 'hi' }] },
      ]);
    });

    it('should convert assistant to model role', () => {
      const provider = new GoogleProvider();
      const request: ChatCompletionRequest = {
        model: 'gemini-2.0-flash',
        messages: [
          { role: 'user', content: 'hello' },
          { role: 'assistant', content: 'hi there' },
        ],
      };

      const result = (provider as unknown as { convertMessages: (messages: ChatCompletionRequest['messages']) => { role: string; parts: { text: string }[] }[] }).convertMessages(request.messages);

      expect(result).toEqual([
        { role: 'user', parts: [{ text: 'hello' }] },
        { role: 'model', parts: [{ text: 'hi there' }] },
      ]);
    });
  });

  describe('convertResponse', () => {
    it('should convert Gemini response to OpenAI format', () => {
      const provider = new GoogleProvider();
      const geminiResp = {
        candidates: [
          {
            content: { role: 'model', parts: [{ text: 'Hello!' }] },
            finishReason: 'STOP',
          },
        ],
        usageMetadata: {
          promptTokenCount: 10,
          candidatesTokenCount: 5,
          totalTokenCount: 15,
        },
      };

      const result = (provider as any).convertResponse('gemini-2.0-flash', geminiResp);

      expect(result.model).toBe('gemini-2.0-flash');
      expect(result.object).toBe('chat.completion');
      expect(result.choices[0].message.role).toBe('assistant');
      expect(result.choices[0].message.content).toBe('Hello!');
      expect(result.choices[0].finish_reason).toBe('stop');
      expect(result.usage.prompt_tokens).toBe(10);
      expect(result.usage.completion_tokens).toBe(5);
      expect(result.usage.total_tokens).toBe(15);
    });

    it('should map non-STOP finishReason to length', () => {
      const provider = new GoogleProvider();
      const geminiResp = {
        candidates: [
          {
            content: { role: 'model', parts: [{ text: 'truncated' }] },
            finishReason: 'MAX_TOKENS',
          },
        ],
        usageMetadata: {
          promptTokenCount: 5,
          candidatesTokenCount: 3,
          totalTokenCount: 8,
        },
      };

      const result = (provider as any).convertResponse('gemini-2.0-flash', geminiResp);
      expect(result.choices[0].finish_reason).toBe('length');
    });

    it('should handle missing usageMetadata', () => {
      const provider = new GoogleProvider();
      const geminiResp = {
        candidates: [
          {
            content: { role: 'model', parts: [{ text: 'Hello!' }] },
            finishReason: 'STOP',
          },
        ],
      };

      const result = (provider as any).convertResponse('gemini-2.0-flash', geminiResp);
      expect(result.usage.prompt_tokens).toBe(0);
      expect(result.usage.completion_tokens).toBe(0);
      expect(result.usage.total_tokens).toBe(0);
    });
  });

  describe('chat', () => {
    it('should return chat completion on success', async () => {
      const provider = new GoogleProvider();

      const mockResponse = {
        candidates: [
          {
            content: { role: 'model', parts: [{ text: 'Hello!' }] },
            finishReason: 'STOP',
          },
        ],
        usageMetadata: {
          promptTokenCount: 10,
          candidatesTokenCount: 5,
          totalTokenCount: 15,
        },
      };

      mockFetchWithAgent.mockResolvedValue({
        ok: true,
        json: async () => mockResponse,
      });

      const request: ChatCompletionRequest = {
        model: 'gemini-2.0-flash',
        messages: [{ role: 'user', content: 'hello' }],
      };

      const result = await provider.chat(request, providerConfig);

      expect(result.choices[0].message.content).toBe('Hello!');
      expect(result.choices[0].finish_reason).toBe('stop');
      expect(mockFetchWithAgent).toHaveBeenCalledWith(
        'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'Content-Type': 'application/json',
            'x-goog-api-key': 'google-test-key',
          }),
        })
      );
    });

    it('should use default model when not provided', async () => {
      const provider = new GoogleProvider();

      mockFetchWithAgent.mockResolvedValue({
        ok: true,
        json: async () => ({
          candidates: [{ content: { role: 'model', parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
          usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
        }),
      });

      const request: ChatCompletionRequest = {
        model: '',
        messages: [{ role: 'user', content: 'hello' }],
      };

      await provider.chat(request, providerConfig);

      expect(mockFetchWithAgent).toHaveBeenCalledWith(
        expect.stringContaining('gemini-2.0-flash'),
        expect.any(Object)
      );
    });

    it('should include generationConfig when provided', async () => {
      const provider = new GoogleProvider();

      mockFetchWithAgent.mockResolvedValue({
        ok: true,
        json: async () => ({
          candidates: [{ content: { role: 'model', parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
          usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
        }),
      });

      const request: ChatCompletionRequest = {
        model: 'gemini-2.0-flash',
        messages: [{ role: 'user', content: 'hello' }],
        temperature: 0.5,
        top_p: 0.9,
        max_tokens: 256,
        stop: ['stop1', 'stop2'],
      };

      await provider.chat(request, providerConfig);

      const callBody = JSON.parse(mockFetchWithAgent.mock.calls[0][1].body);
      expect(callBody.generationConfig.temperature).toBe(0.5);
      expect(callBody.generationConfig.topP).toBe(0.9);
      expect(callBody.generationConfig.maxOutputTokens).toBe(256);
      expect(callBody.generationConfig.stopSequences).toEqual(['stop1', 'stop2']);
    });

    it('should handle string stop value', async () => {
      const provider = new GoogleProvider();

      mockFetchWithAgent.mockResolvedValue({
        ok: true,
        json: async () => ({
          candidates: [{ content: { role: 'model', parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
          usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
        }),
      });

      const request: ChatCompletionRequest = {
        model: 'gemini-2.0-flash',
        messages: [{ role: 'user', content: 'hello' }],
        stop: 'end',
      };

      await provider.chat(request, providerConfig);

      const callBody = JSON.parse(mockFetchWithAgent.mock.calls[0][1].body);
      expect(callBody.generationConfig.stopSequences).toEqual(['end']);
    });

    it('should throw on error response', async () => {
      const provider = new GoogleProvider();

      mockFetchWithAgent.mockResolvedValue({
        ok: false,
        status: 400,
        statusText: 'Bad Request',
        json: async () => ({ message: 'Invalid API key' }),
      });

      const request: ChatCompletionRequest = {
        model: 'gemini-2.0-flash',
        messages: [{ role: 'user', content: 'hello' }],
      };

      await expect(provider.chat(request, providerConfig)).rejects.toThrow('Invalid API key');
    });
  });

  describe('chatStream', () => {
    it('should return parsed stream on success', async () => {
      const provider = new GoogleProvider();

      const encoder = new TextEncoder();
      const source = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode('data: {"candidates":[{"content":{"parts":[{"text":"Hello"}]},"finishReason":"STOP"}]}\n\n'));
          controller.close();
        },
      });

      mockFetchWithAgent.mockResolvedValue({
        ok: true,
        body: source,
      });

      const request: ChatCompletionRequest = {
        model: 'gemini-2.0-flash',
        messages: [{ role: 'user', content: 'hello' }],
      };

      const result = await provider.chatStream(request, providerConfig);
      expect(result).toBeInstanceOf(ReadableStream);

      const reader = result.getReader();
      const chunks: string[] = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(new TextDecoder().decode(value));
      }

      expect(chunks.length).toBe(1);
      expect(chunks[0]).toContain('chat.completion.chunk');
      expect(chunks[0]).toContain('Hello');
      expect(chunks[0]).toContain('stop');
    });

    it('should skip [DONE] lines', async () => {
      const provider = new GoogleProvider();

      const encoder = new TextEncoder();
      const source = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
        },
      });

      mockFetchWithAgent.mockResolvedValue({
        ok: true,
        body: source,
      });

      const request: ChatCompletionRequest = {
        model: 'gemini-2.0-flash',
        messages: [{ role: 'user', content: 'hello' }],
      };

      const result = await provider.chatStream(request, providerConfig);
      const reader = result.getReader();
      const chunks: string[] = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(new TextDecoder().decode(value));
      }

      expect(chunks.length).toBe(0);
    });

    it('should throw on error response', async () => {
      const provider = new GoogleProvider();

      mockFetchWithAgent.mockResolvedValue({
        ok: false,
        status: 429,
        statusText: 'Too Many Requests',
        json: async () => ({ error: { message: 'Rate limited' } }),
      });

      const request: ChatCompletionRequest = {
        model: 'gemini-2.0-flash',
        messages: [{ role: 'user', content: 'hello' }],
      };

      await expect(provider.chatStream(request, providerConfig)).rejects.toThrow('Rate limited');
    });

    it('should use stream endpoint with alt=sse', async () => {
      const provider = new GoogleProvider();

      const source = new ReadableStream({
        start(controller) {
          controller.close();
        },
      });

      mockFetchWithAgent.mockResolvedValue({
        ok: true,
        body: source,
      });

      const request: ChatCompletionRequest = {
        model: 'gemini-2.0-flash',
        messages: [{ role: 'user', content: 'hello' }],
      };

      await provider.chatStream(request, providerConfig);

      expect(mockFetchWithAgent).toHaveBeenCalledWith(
        expect.stringContaining(':streamGenerateContent?alt=sse'),
        expect.any(Object)
      );
    });
  });

  describe('embed', () => {
    it('should throw error because embed is not supported', async () => {
      const provider = new GoogleProvider();

      const request: EmbeddingRequest = {
        model: 'gemini-2.0-flash',
        input: 'hello',
      };

      await expect(provider.embed(request, providerConfig)).rejects.toThrow('Google Gemini does not support embeddings via the chat API');
    });
  });
});
