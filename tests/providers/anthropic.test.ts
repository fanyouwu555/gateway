/**
 * Anthropic Provider Tests
 */
import { AnthropicProvider } from '../../src/providers/anthropic';
import type { ChatCompletionRequest, EmbeddingRequest, IProviderConfig } from '../../src/types';

const mockFetchWithAgent = jest.fn();
jest.mock('../../src/utils/http-client', () => ({
  fetchWithAgent: (...args: unknown[]) => mockFetchWithAgent(...args),
}));

describe('AnthropicProvider', () => {
  const providerConfig: IProviderConfig = {
    provider: 'anthropic',
    base_url: 'https://api.anthropic.com/v1',
    api_key: 'sk-ant-test',
  };

  beforeEach(() => {
    mockFetchWithAgent.mockReset();
  });

  describe('capabilities', () => {
    it('should be registered', () => {
      const provider = new AnthropicProvider();
      expect(provider.name).toBe('anthropic');
    });

    it('should support chat and streaming', () => {
      const provider = new AnthropicProvider();
      expect(provider.capabilities.chat).toBe(true);
      expect(provider.capabilities.streaming).toBe(true);
    });

    it('should not support embed', () => {
      const provider = new AnthropicProvider();
      expect(provider.capabilities.embed).toBe(false);
    });
  });

  describe('convertMessages', () => {
    it('should skip system messages (they are handled via system parameter)', () => {
      const provider = new AnthropicProvider();
      const request: ChatCompletionRequest = {
        model: 'claude-3-opus',
        messages: [
          { role: 'system', content: 'You are a helpful assistant' },
          { role: 'user', content: 'hello' },
          { role: 'assistant', content: 'hi' },
        ],
      };

      const result = (provider as unknown as { convertMessages: (messages: ChatCompletionRequest['messages']) => { role: string; content: string }[] }).convertMessages(request.messages);

      // System messages are skipped and sent via the 'system' parameter instead
      expect(result).toEqual([
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi' },
      ]);
    });

    it('should keep user and assistant roles', () => {
      const provider = new AnthropicProvider();
      const request: ChatCompletionRequest = {
        model: 'claude-3-opus',
        messages: [
          { role: 'user', content: 'hello' },
          { role: 'assistant', content: 'hi there' },
        ],
      };

      const result = (provider as unknown as { convertMessages: (messages: ChatCompletionRequest['messages']) => { role: string; content: string }[] }).convertMessages(request.messages);

      expect(result).toEqual([
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi there' },
      ]);
    });
  });

  describe('chat', () => {
    it('should return chat completion on success', async () => {
      const provider = new AnthropicProvider();

      const mockResponse = {
        id: 'msg_01',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'Hello!' }],
        model: 'claude-3-opus',
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 5 },
      };

      mockFetchWithAgent.mockResolvedValue({
        ok: true,
        json: async () => mockResponse,
      });

      const request: ChatCompletionRequest = {
        model: 'claude-3-opus',
        messages: [{ role: 'user', content: 'hello' }],
      };

      const result = await provider.chat(request, providerConfig);

      expect(result.id).toBe('msg_01');
      expect(result.object).toBe('chat.completion');
      expect(result.model).toBe('claude-3-opus');
      expect(result.choices[0].message.role).toBe('assistant');
      expect(result.choices[0].message.content).toBe('Hello!');
      expect(result.choices[0].finish_reason).toBe('stop');
      expect(result.usage.prompt_tokens).toBe(10);
      expect(result.usage.completion_tokens).toBe(5);
      expect(result.usage.total_tokens).toBe(15);

      expect(mockFetchWithAgent).toHaveBeenCalledWith(
        'https://api.anthropic.com/v1/messages',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'Content-Type': 'application/json',
            'anthropic-version': '2023-06-01',
            'x-api-key': 'sk-ant-test',
          }),
        })
      );
    });

    it('should map stop_reason max_tokens to length', async () => {
      const provider = new AnthropicProvider();

      mockFetchWithAgent.mockResolvedValue({
        ok: true,
        json: async () => ({
          id: 'msg_02',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: 'truncated' }],
          model: 'claude-3-opus',
          stop_reason: 'max_tokens',
          stop_sequence: null,
          usage: { input_tokens: 5, output_tokens: 3 },
        }),
      });

      const request: ChatCompletionRequest = {
        model: 'claude-3-opus',
        messages: [{ role: 'user', content: 'hello' }],
      };

      const result = await provider.chat(request, providerConfig);
      expect(result.choices[0].finish_reason).toBe('length');
    });

    it('should include temperature and top_p when provided', async () => {
      const provider = new AnthropicProvider();

      mockFetchWithAgent.mockResolvedValue({
        ok: true,
        json: async () => ({
          id: 'msg_03',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: 'ok' }],
          model: 'claude-3-opus',
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
      });

      const request: ChatCompletionRequest = {
        model: 'claude-3-opus',
        messages: [{ role: 'user', content: 'hello' }],
        temperature: 0.5,
        top_p: 0.9,
        max_tokens: 256,
      };

      await provider.chat(request, providerConfig);

      const callBody = JSON.parse(mockFetchWithAgent.mock.calls[0][1].body);
      expect(callBody.temperature).toBe(0.5);
      expect(callBody.top_p).toBe(0.9);
      expect(callBody.max_tokens).toBe(256);
    });

    it('should use default max_tokens when not provided', async () => {
      const provider = new AnthropicProvider();

      mockFetchWithAgent.mockResolvedValue({
        ok: true,
        json: async () => ({
          id: 'msg_04',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: 'ok' }],
          model: 'claude-3-opus',
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
      });

      const request: ChatCompletionRequest = {
        model: 'claude-3-opus',
        messages: [{ role: 'user', content: 'hello' }],
      };

      await provider.chat(request, providerConfig);

      const callBody = JSON.parse(mockFetchWithAgent.mock.calls[0][1].body);
      expect(callBody.max_tokens).toBe(1024);
    });

    it('should throw on error response', async () => {
      const provider = new AnthropicProvider();

      mockFetchWithAgent.mockResolvedValue({
        ok: false,
        status: 400,
        statusText: 'Bad Request',
        json: async () => ({ message: 'Invalid request' }),
      });

      const request: ChatCompletionRequest = {
        model: 'claude-3-opus',
        messages: [{ role: 'user', content: 'hello' }],
      };

      await expect(provider.chat(request, providerConfig)).rejects.toThrow('Invalid request');
    });
  });

  describe('chatStream', () => {
    it('should return parsed stream on success', async () => {
      const provider = new AnthropicProvider();

      const encoder = new TextEncoder();
      const source = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode('data: {"type":"content_block_delta","id":"msg_01","model":"claude-3-opus","delta":{"text":"Hello"}}\n\n'));
          controller.enqueue(encoder.encode('data: {"type":"message_delta","id":"msg_01","model":"claude-3-opus","delta":{"stop_reason":"end_turn"}}\n\n'));
          controller.close();
        },
      });

      mockFetchWithAgent.mockResolvedValue({
        ok: true,
        body: source,
      });

      const request: ChatCompletionRequest = {
        model: 'claude-3-opus',
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

      expect(chunks.length).toBe(2);
      expect(chunks[0]).toContain('chat.completion.chunk');
      expect(chunks[0]).toContain('Hello');
      expect(chunks[1]).toContain('finish_reason');
      expect(chunks[1]).toContain('stop');
    });

    it('should map stream stop_reason max_tokens to length', async () => {
      const provider = new AnthropicProvider();

      const encoder = new TextEncoder();
      const source = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode('data: {"type":"message_delta","id":"msg_01","model":"claude-3-opus","delta":{"stop_reason":"max_tokens"}}\n\n'));
          controller.close();
        },
      });

      mockFetchWithAgent.mockResolvedValue({
        ok: true,
        body: source,
      });

      const request: ChatCompletionRequest = {
        model: 'claude-3-opus',
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

      expect(chunks[0]).toContain('length');
    });

    it('should throw on error response', async () => {
      const provider = new AnthropicProvider();

      mockFetchWithAgent.mockResolvedValue({
        ok: false,
        status: 429,
        statusText: 'Too Many Requests',
        json: async () => ({ error: { message: 'Rate limited' } }),
      });

      const request: ChatCompletionRequest = {
        model: 'claude-3-opus',
        messages: [{ role: 'user', content: 'hello' }],
      };

      await expect(provider.chatStream(request, providerConfig)).rejects.toThrow('Rate limited');
    });

    it('should include stream flag in body', async () => {
      const provider = new AnthropicProvider();

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
        model: 'claude-3-opus',
        messages: [{ role: 'user', content: 'hello' }],
      };

      await provider.chatStream(request, providerConfig);

      const callBody = JSON.parse(mockFetchWithAgent.mock.calls[0][1].body);
      expect(callBody.stream).toBe(true);
    });
  });

  describe('embed', () => {
    it('should throw error because embed is not supported', async () => {
      const provider = new AnthropicProvider();

      const request: EmbeddingRequest = {
        model: 'claude-3-opus',
        input: 'hello',
      };

      await expect(provider.embed(request, providerConfig)).rejects.toThrow('Anthropic does not support Embedding API');
    });
  });
});
