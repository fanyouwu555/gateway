/**
 * OpenAICompatibleProvider Tests
 */
import { OpenAICompatibleProvider } from '../../src/providers/openai-compatible';
import type { ChatCompletionRequest, EmbeddingRequest, IProviderConfig } from '../../src/types';

const mockFetchWithAgent = jest.fn();
jest.mock('../../src/utils/http-client', () => ({
  fetchWithAgent: (...args: unknown[]) => mockFetchWithAgent(...args),
}));

describe('OpenAICompatibleProvider', () => {
  beforeEach(() => {
    mockFetchWithAgent.mockReset();
  });

  describe('constructor', () => {
    it('should create provider with minimal config', () => {
      const provider = new OpenAICompatibleProvider({
        name: 'test-provider',
        capabilities: { chat: true, embed: false, streaming: false, vision: false, function_call: false },
      });

      expect(provider.name).toBe('test-provider');
      expect(provider.capabilities.chat).toBe(true);
      expect(provider.capabilities.embed).toBe(false);
    });

    it('should create provider with fields config', () => {
      const provider = new OpenAICompatibleProvider({
        name: 'full-provider',
        capabilities: { chat: true, embed: true, streaming: true, vision: true, function_call: true },
        fields: {
          presencePenalty: true,
          frequencyPenalty: true,
          user: true,
          tools: true,
          logprobs: true,
        },
      });

      expect(provider.capabilities.function_call).toBe(true);
      expect(provider.capabilities.vision).toBe(true);
    });

    it('should create provider with extraHeaders', () => {
      const provider = new OpenAICompatibleProvider({
        name: 'header-provider',
        capabilities: { chat: true, embed: false, streaming: false, vision: false, function_call: false },
        extraHeaders: { 'X-Custom': 'value' },
      });

      expect(provider.name).toBe('header-provider');
    });

    it('should create provider with custom parseError', () => {
      const customParse = jest.fn().mockReturnValue('custom error');
      const provider = new OpenAICompatibleProvider({
        name: 'error-provider',
        capabilities: { chat: true, embed: false, streaming: false, vision: false, function_call: false },
        parseError: customParse,
      });

      expect(provider.name).toBe('error-provider');
    });
  });

  describe('buildChatBody', () => {
    it('should include basic fields', () => {
      const provider = new OpenAICompatibleProvider({
        name: 'test',
        capabilities: { chat: true, embed: false, streaming: false, vision: false, function_call: false },
      });

      const request: ChatCompletionRequest = {
        model: 'gpt-4',
        messages: [{ role: 'user', content: 'hello' }],
      };

      const body = (provider as unknown as { buildChatBody: (req: ChatCompletionRequest, stream: boolean) => Record<string, unknown> }).buildChatBody(request, false);

      expect(body.model).toBe('gpt-4');
      expect(body.messages).toEqual([{ role: 'user', content: 'hello' }]);
      expect(body.stream).toBe(false);
    });

    it('should include optional fields when provided', () => {
      const provider = new OpenAICompatibleProvider({
        name: 'test',
        capabilities: { chat: true, embed: false, streaming: false, vision: false, function_call: false },
      });

      const request: ChatCompletionRequest = {
        model: 'gpt-4',
        messages: [{ role: 'user', content: 'hello' }],
        temperature: 0.5,
        top_p: 0.9,
        max_tokens: 100,
        stop: ['stop'],
      };

      const body = (provider as unknown as { buildChatBody: (req: ChatCompletionRequest, stream: boolean) => Record<string, unknown> }).buildChatBody(request, true);

      expect(body.temperature).toBe(0.5);
      expect(body.top_p).toBe(0.9);
      expect(body.max_tokens).toBe(100);
      expect(body.stop).toEqual(['stop']);
      expect(body.stream).toBe(true);
    });

    it('should include presence_penalty when field is enabled and provided', () => {
      const provider = new OpenAICompatibleProvider({
        name: 'test',
        capabilities: { chat: true, embed: false, streaming: false, vision: false, function_call: false },
        fields: { presencePenalty: true },
      });

      const request: ChatCompletionRequest = {
        model: 'gpt-4',
        messages: [{ role: 'user', content: 'hello' }],
        presence_penalty: 0.5,
      };

      const body = (provider as unknown as { buildChatBody: (req: ChatCompletionRequest, stream: boolean) => Record<string, unknown> }).buildChatBody(request, false);

      expect(body.presence_penalty).toBe(0.5);
    });

    it('should not include presence_penalty when field is disabled', () => {
      const provider = new OpenAICompatibleProvider({
        name: 'test',
        capabilities: { chat: true, embed: false, streaming: false, vision: false, function_call: false },
      });

      const request: ChatCompletionRequest = {
        model: 'gpt-4',
        messages: [{ role: 'user', content: 'hello' }],
        presence_penalty: 0.5,
      };

      const body = (provider as unknown as { buildChatBody: (req: ChatCompletionRequest, stream: boolean) => Record<string, unknown> }).buildChatBody(request, false);

      expect(body.presence_penalty).toBeUndefined();
    });

    it('should include frequency_penalty when field is enabled and provided', () => {
      const provider = new OpenAICompatibleProvider({
        name: 'test',
        capabilities: { chat: true, embed: false, streaming: false, vision: false, function_call: false },
        fields: { frequencyPenalty: true },
      });

      const request: ChatCompletionRequest = {
        model: 'gpt-4',
        messages: [{ role: 'user', content: 'hello' }],
        frequency_penalty: 0.5,
      };

      const body = (provider as unknown as { buildChatBody: (req: ChatCompletionRequest, stream: boolean) => Record<string, unknown> }).buildChatBody(request, false);

      expect(body.frequency_penalty).toBe(0.5);
    });

    it('should not include frequency_penalty when field is disabled', () => {
      const provider = new OpenAICompatibleProvider({
        name: 'test',
        capabilities: { chat: true, embed: false, streaming: false, vision: false, function_call: false },
      });

      const request: ChatCompletionRequest = {
        model: 'gpt-4',
        messages: [{ role: 'user', content: 'hello' }],
        frequency_penalty: 0.5,
      };

      const body = (provider as unknown as { buildChatBody: (req: ChatCompletionRequest, stream: boolean) => Record<string, unknown> }).buildChatBody(request, false);

      expect(body.frequency_penalty).toBeUndefined();
    });

    it('should include user when field is enabled and provided', () => {
      const provider = new OpenAICompatibleProvider({
        name: 'test',
        capabilities: { chat: true, embed: false, streaming: false, vision: false, function_call: false },
        fields: { user: true },
      });

      const request: ChatCompletionRequest = {
        model: 'gpt-4',
        messages: [{ role: 'user', content: 'hello' }],
        user: 'user-123',
      };

      const body = (provider as unknown as { buildChatBody: (req: ChatCompletionRequest, stream: boolean) => Record<string, unknown> }).buildChatBody(request, false);

      expect(body.user).toBe('user-123');
    });

    it('should not include user when field is disabled', () => {
      const provider = new OpenAICompatibleProvider({
        name: 'test',
        capabilities: { chat: true, embed: false, streaming: false, vision: false, function_call: false },
      });

      const request: ChatCompletionRequest = {
        model: 'gpt-4',
        messages: [{ role: 'user', content: 'hello' }],
        user: 'user-123',
      };

      const body = (provider as unknown as { buildChatBody: (req: ChatCompletionRequest, stream: boolean) => Record<string, unknown> }).buildChatBody(request, false);

      expect(body.user).toBeUndefined();
    });

    it('should include tools and tool_choice when field is enabled and provided', () => {
      const provider = new OpenAICompatibleProvider({
        name: 'test',
        capabilities: { chat: true, embed: false, streaming: false, vision: false, function_call: true },
        fields: { tools: true },
      });

      const request: ChatCompletionRequest = {
        model: 'gpt-4',
        messages: [{ role: 'user', content: 'hello' }],
        tools: [{ type: 'function', function: { name: 'fn', description: 'desc', parameters: {} } }],
        tool_choice: { type: 'function', function: { name: 'fn' } },
      };

      const body = (provider as unknown as { buildChatBody: (req: ChatCompletionRequest, stream: boolean) => Record<string, unknown> }).buildChatBody(request, false);

      expect(body.tools).toEqual(request.tools);
      expect(body.tool_choice).toEqual(request.tool_choice);
    });

    it('should not include tools when field is disabled', () => {
      const provider = new OpenAICompatibleProvider({
        name: 'test',
        capabilities: { chat: true, embed: false, streaming: false, vision: false, function_call: false },
      });

      const request: ChatCompletionRequest = {
        model: 'gpt-4',
        messages: [{ role: 'user', content: 'hello' }],
        tools: [{ type: 'function', function: { name: 'fn', description: 'desc', parameters: {} } }],
        tool_choice: { type: 'function', function: { name: 'fn' } },
      };

      const body = (provider as unknown as { buildChatBody: (req: ChatCompletionRequest, stream: boolean) => Record<string, unknown> }).buildChatBody(request, false);

      expect(body.tools).toBeUndefined();
      expect(body.tool_choice).toBeUndefined();
    });

    it('should not include tools when tools array is empty', () => {
      const provider = new OpenAICompatibleProvider({
        name: 'test',
        capabilities: { chat: true, embed: false, streaming: false, vision: false, function_call: true },
        fields: { tools: true },
      });

      const request: ChatCompletionRequest = {
        model: 'gpt-4',
        messages: [{ role: 'user', content: 'hello' }],
        tools: [],
      };

      const body = (provider as unknown as { buildChatBody: (req: ChatCompletionRequest, stream: boolean) => Record<string, unknown> }).buildChatBody(request, false);

      expect(body.tools).toBeUndefined();
    });
  });

  describe('chat', () => {
    const providerConfig: IProviderConfig = {
      provider: 'test',
      base_url: 'https://api.test.com/v1',
      api_key: 'sk-test',
    };

    it('should return chat completion on success', async () => {
      const provider = new OpenAICompatibleProvider({
        name: 'test',
        capabilities: { chat: true, embed: false, streaming: false, vision: false, function_call: false },
      });

      const mockResponse = {
        id: 'chat-1',
        object: 'chat.completion',
        created: 1,
        model: 'gpt-4',
        choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      };

      mockFetchWithAgent.mockResolvedValue({
        ok: true,
        json: async () => mockResponse,
      });

      const request: ChatCompletionRequest = {
        model: 'gpt-4',
        messages: [{ role: 'user', content: 'hello' }],
      };

      const result = await provider.chat(request, providerConfig);

      expect(result).toEqual(mockResponse);
      expect(mockFetchWithAgent).toHaveBeenCalledWith(
        'https://api.test.com/v1/chat/completions',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'Content-Type': 'application/json',
            Authorization: 'Bearer sk-test',
          }),
        })
      );
    });

    it('should throw on error response', async () => {
      const provider = new OpenAICompatibleProvider({
        name: 'test',
        capabilities: { chat: true, embed: false, streaming: false, vision: false, function_call: false },
      });

      mockFetchWithAgent.mockResolvedValue({
        ok: false,
        status: 400,
        statusText: 'Bad Request',
        json: async () => ({ message: 'Invalid model' }),
      });

      const request: ChatCompletionRequest = {
        model: 'gpt-4',
        messages: [{ role: 'user', content: 'hello' }],
      };

      await expect(provider.chat(request, providerConfig)).rejects.toThrow('Invalid model');
    });

    it('should throw default HTTP error when no message in body', async () => {
      const provider = new OpenAICompatibleProvider({
        name: 'test',
        capabilities: { chat: true, embed: false, streaming: false, vision: false, function_call: false },
      });

      mockFetchWithAgent.mockResolvedValue({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        json: async () => ({}),
      });

      const request: ChatCompletionRequest = {
        model: 'gpt-4',
        messages: [{ role: 'user', content: 'hello' }],
      };

      await expect(provider.chat(request, providerConfig)).rejects.toThrow('HTTP 500: Internal Server Error');
    });

    it('should include extraHeaders in request', async () => {
      const provider = new OpenAICompatibleProvider({
        name: 'test',
        capabilities: { chat: true, embed: false, streaming: false, vision: false, function_call: false },
        extraHeaders: { 'X-Custom': 'value' },
      });

      const mockResponse = {
        id: 'chat-1',
        object: 'chat.completion',
        created: 1,
        model: 'gpt-4',
        choices: [],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      };

      mockFetchWithAgent.mockResolvedValue({
        ok: true,
        json: async () => mockResponse,
      });

      const request: ChatCompletionRequest = {
        model: 'gpt-4',
        messages: [{ role: 'user', content: 'hello' }],
      };

      await provider.chat(request, providerConfig);

      expect(mockFetchWithAgent).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            'X-Custom': 'value',
          }),
        })
      );
    });
  });

  describe('chatStream', () => {
    const providerConfig: IProviderConfig = {
      provider: 'test',
      base_url: 'https://api.test.com/v1',
      api_key: 'sk-test',
    };

    it('should return parsed stream on success', async () => {
      const provider = new OpenAICompatibleProvider({
        name: 'test',
        capabilities: { chat: true, embed: false, streaming: true, vision: false, function_call: false },
      });

      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode('data: {"id":"1","choices":[]}\n\n'));
          controller.close();
        },
      });

      mockFetchWithAgent.mockResolvedValue({
        ok: true,
        body: stream,
      });

      const request: ChatCompletionRequest = {
        model: 'gpt-4',
        messages: [{ role: 'user', content: 'hello' }],
      };

      const result = await provider.chatStream(request, providerConfig);

      expect(result).toBeInstanceOf(ReadableStream);
    });

    it('should throw on error response', async () => {
      const provider = new OpenAICompatibleProvider({
        name: 'test',
        capabilities: { chat: true, embed: false, streaming: true, vision: false, function_call: false },
      });

      mockFetchWithAgent.mockResolvedValue({
        ok: false,
        status: 429,
        statusText: 'Too Many Requests',
        json: async () => ({ error: { message: 'Rate limited' } }),
      });

      const request: ChatCompletionRequest = {
        model: 'gpt-4',
        messages: [{ role: 'user', content: 'hello' }],
      };

      await expect(provider.chatStream(request, providerConfig)).rejects.toThrow('Rate limited');
    });

    it('should use custom parseError for stream errors', async () => {
      const customParse = jest.fn().mockReturnValue('stream error');
      const provider = new OpenAICompatibleProvider({
        name: 'test',
        capabilities: { chat: true, embed: false, streaming: true, vision: false, function_call: false },
        parseError: customParse,
      });

      mockFetchWithAgent.mockResolvedValue({
        ok: false,
        status: 500,
        statusText: 'Error',
        json: async () => ({ message: 'fail' }),
      });

      const request: ChatCompletionRequest = {
        model: 'gpt-4',
        messages: [{ role: 'user', content: 'hello' }],
      };

      await expect(provider.chatStream(request, providerConfig)).rejects.toThrow('stream error');
      expect(customParse).toHaveBeenCalled();
    });
  });

  describe('embed', () => {
    const providerConfig: IProviderConfig = {
      provider: 'test',
      base_url: 'https://api.test.com/v1',
      api_key: 'sk-test',
    };

    it('should throw when embed is not supported', async () => {
      const provider = new OpenAICompatibleProvider({
        name: 'test',
        capabilities: { chat: true, embed: false, streaming: false, vision: false, function_call: false },
      });

      const request: EmbeddingRequest = {
        model: 'text-embedding-3',
        input: 'hello',
      };

      await expect(provider.embed(request, providerConfig)).rejects.toThrow('test does not support embeddings');
    });

    it('should return embedding response when supported', async () => {
      const provider = new OpenAICompatibleProvider({
        name: 'test',
        capabilities: { chat: true, embed: true, streaming: false, vision: false, function_call: false },
      });

      const mockResponse = {
        object: 'list',
        data: [{ object: 'embedding', embedding: [0.1, 0.2], index: 0 }],
        model: 'text-embedding-3',
        usage: { prompt_tokens: 1, total_tokens: 1 },
      };

      mockFetchWithAgent.mockResolvedValue({
        ok: true,
        json: async () => mockResponse,
      });

      const request: EmbeddingRequest = {
        model: 'text-embedding-3',
        input: 'hello',
      };

      const result = await provider.embed(request, providerConfig);

      expect(result).toEqual(mockResponse);
      expect(mockFetchWithAgent).toHaveBeenCalledWith(
        'https://api.test.com/v1/embeddings',
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('"encoding_format":"float"'),
        })
      );
    });

    it('should include dimensions when provided', async () => {
      const provider = new OpenAICompatibleProvider({
        name: 'test',
        capabilities: { chat: true, embed: true, streaming: false, vision: false, function_call: false },
      });

      mockFetchWithAgent.mockResolvedValue({
        ok: true,
        json: async () => ({
          object: 'list',
          data: [{ object: 'embedding', embedding: [0.1], index: 0 }],
          model: 'text-embedding-3',
          usage: { prompt_tokens: 1, total_tokens: 1 },
        }),
      });

      const request: EmbeddingRequest = {
        model: 'text-embedding-3',
        input: 'hello',
        dimensions: 256,
      };

      await provider.embed(request, providerConfig);

      const callBody = JSON.parse(mockFetchWithAgent.mock.calls[0][1].body);
      expect(callBody.dimensions).toBe(256);
    });

    it('should not include dimensions when undefined', async () => {
      const provider = new OpenAICompatibleProvider({
        name: 'test',
        capabilities: { chat: true, embed: true, streaming: false, vision: false, function_call: false },
      });

      mockFetchWithAgent.mockResolvedValue({
        ok: true,
        json: async () => ({
          object: 'list',
          data: [{ object: 'embedding', embedding: [0.1], index: 0 }],
          model: 'text-embedding-3',
          usage: { prompt_tokens: 1, total_tokens: 1 },
        }),
      });

      const request: EmbeddingRequest = {
        model: 'text-embedding-3',
        input: 'hello',
      };

      await provider.embed(request, providerConfig);

      const callBody = JSON.parse(mockFetchWithAgent.mock.calls[0][1].body);
      expect(callBody.dimensions).toBeUndefined();
    });

    it('should use custom encoding_format when provided', async () => {
      const provider = new OpenAICompatibleProvider({
        name: 'test',
        capabilities: { chat: true, embed: true, streaming: false, vision: false, function_call: false },
      });

      mockFetchWithAgent.mockResolvedValue({
        ok: true,
        json: async () => ({
          object: 'list',
          data: [{ object: 'embedding', embedding: [0.1], index: 0 }],
          model: 'text-embedding-3',
          usage: { prompt_tokens: 1, total_tokens: 1 },
        }),
      });

      const request: EmbeddingRequest = {
        model: 'text-embedding-3',
        input: 'hello',
        encoding_format: 'base64',
      };

      await provider.embed(request, providerConfig);

      const callBody = JSON.parse(mockFetchWithAgent.mock.calls[0][1].body);
      expect(callBody.encoding_format).toBe('base64');
    });
  });
});
