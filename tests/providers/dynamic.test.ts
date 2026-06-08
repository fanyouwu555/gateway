/**
 * 动态 Provider 测试
 */
import { DynamicProvider } from '../../src/providers/dynamic';
import type { DynamicProviderConfig, ChatCompletionRequest, EmbeddingRequest, IProviderConfig } from '../../src/types';

const mockFetchWithAgent = jest.fn();
jest.mock('../../src/utils/http-client', () => ({
  fetchWithAgent: (...args: unknown[]) => mockFetchWithAgent(...args),
}));

describe('DynamicProvider', () => {
  const providerConfig: IProviderConfig = {
    provider: 'dynamic',
    base_url: 'https://api.example.com',
    api_key: 'dynamic-test-key',
  };

  beforeEach(() => {
    mockFetchWithAgent.mockReset();
  });

  describe('constructor', () => {
    it('should create provider with config name', () => {
      const config: DynamicProviderConfig = {
        name: 'my-provider',
        base_url: 'https://api.example.com',
        endpoints: {
          chat: '/chat',
        },
      };

      const provider = new DynamicProvider(config);
      expect(provider.name).toBe('my-provider');
    });

    it('should set capabilities based on endpoints', () => {
      const config: DynamicProviderConfig = {
        name: 'chat-only',
        base_url: 'https://api.example.com',
        endpoints: {
          chat: '/chat',
        },
      };

      const provider = new DynamicProvider(config);
      expect(provider.capabilities.chat).toBe(true);
      expect(provider.capabilities.embed).toBe(false);
      expect(provider.capabilities.streaming).toBe(false);
    });

    it('should support all capabilities when all endpoints defined', () => {
      const config: DynamicProviderConfig = {
        name: 'full-provider',
        base_url: 'https://api.example.com',
        endpoints: {
          chat: '/chat',
          chat_stream: '/chat/stream',
          embeddings: '/embed',
          models: '/models',
        },
        capabilities: {
          vision: true,
          function_call: true,
        },
      };

      const provider = new DynamicProvider(config);
      expect(provider.capabilities.chat).toBe(true);
      expect(provider.capabilities.embed).toBe(true);
      expect(provider.capabilities.streaming).toBe(true);
      expect(provider.capabilities.vision).toBe(true);
      expect(provider.capabilities.function_call).toBe(true);
    });
  });

  describe('buildDynamicHeaders', () => {
    it('should use default Authorization header', () => {
      const config: DynamicProviderConfig = {
        name: 'test',
        base_url: 'https://api.example.com',
        endpoints: { chat: '/chat' },
      };

      const provider = new DynamicProvider(config);
      const headers = (provider as unknown as { buildDynamicHeaders: (config: IProviderConfig) => Record<string, string> }).buildDynamicHeaders(providerConfig);
      expect(headers['Authorization']).toBe('Bearer dynamic-test-key');
      expect(headers['Content-Type']).toBe('application/json');
    });

    it('should support custom auth header', () => {
      const config: DynamicProviderConfig = {
        name: 'test',
        base_url: 'https://api.example.com',
        auth_header: 'X-API-Key',
        endpoints: { chat: '/chat' },
      };

      const provider = new DynamicProvider(config);
      const headers = (provider as unknown as { buildDynamicHeaders: (config: IProviderConfig) => Record<string, string> }).buildDynamicHeaders(providerConfig);
      expect(headers['X-API-Key']).toBe('Bearer dynamic-test-key');
      expect(headers['Authorization']).toBeUndefined();
    });

    it('should support custom auth prefix', () => {
      const config: DynamicProviderConfig = {
        name: 'test',
        base_url: 'https://api.example.com',
        auth_prefix: 'ApiKey',
        endpoints: { chat: '/chat' },
      };

      const provider = new DynamicProvider(config);
      const headers = (provider as unknown as { buildDynamicHeaders: (config: IProviderConfig) => Record<string, string> }).buildDynamicHeaders(providerConfig);
      expect(headers['Authorization']).toBe('ApiKey dynamic-test-key');
    });

    it('should merge custom headers from config', () => {
      const config: DynamicProviderConfig = {
        name: 'test',
        base_url: 'https://api.example.com',
        endpoints: { chat: '/chat' },
      };

      const provider = new DynamicProvider(config);
      const customConfig: IProviderConfig = {
        ...providerConfig,
        headers: { 'X-Custom': 'value' },
      };
      const headers = (provider as unknown as { buildDynamicHeaders: (config: IProviderConfig) => Record<string, string> }).buildDynamicHeaders(customConfig);
      expect(headers['X-Custom']).toBe('value');
    });

    it('should not include auth header when api_key is missing', () => {
      const config: DynamicProviderConfig = {
        name: 'test',
        base_url: 'https://api.example.com',
        endpoints: { chat: '/chat' },
      };

      const provider = new DynamicProvider(config);
      const noKeyConfig: IProviderConfig = {
        provider: 'dynamic',
        base_url: 'https://api.example.com',
      };
      const headers = (provider as unknown as { buildDynamicHeaders: (config: IProviderConfig) => Record<string, string> }).buildDynamicHeaders(noKeyConfig);
      expect(headers['Authorization']).toBeUndefined();
    });
  });

  describe('chat', () => {
    it('should return chat completion on success', async () => {
      const config: DynamicProviderConfig = {
        name: 'test',
        base_url: 'https://api.example.com',
        endpoints: { chat: '/chat' },
      };

      const provider = new DynamicProvider(config);

      const mockResponse = {
        id: 'chat-1',
        object: 'chat.completion',
        created: 1,
        model: 'test-model',
        choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      };

      mockFetchWithAgent.mockResolvedValue({
        ok: true,
        json: async () => mockResponse,
      });

      const request: ChatCompletionRequest = {
        model: 'test-model',
        messages: [{ role: 'user', content: 'hello' }],
      };

      const result = await provider.chat(request, providerConfig);

      expect(result).toEqual(mockResponse);
      expect(mockFetchWithAgent).toHaveBeenCalledWith(
        'https://api.example.com/chat',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'Content-Type': 'application/json',
            Authorization: 'Bearer dynamic-test-key',
          }),
        })
      );
    });

    it('should use default endpoint when chat is not configured', async () => {
      const config: DynamicProviderConfig = {
        name: 'test',
        base_url: 'https://api.example.com',
        endpoints: {},
      };

      const provider = new DynamicProvider(config);

      mockFetchWithAgent.mockResolvedValue({
        ok: true,
        json: async () => ({
          id: 'chat-1',
          object: 'chat.completion',
          created: 1,
          model: 'test-model',
          choices: [],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      });

      const request: ChatCompletionRequest = {
        model: 'test-model',
        messages: [{ role: 'user', content: 'hello' }],
      };

      await provider.chat(request, providerConfig);

      expect(mockFetchWithAgent).toHaveBeenCalledWith(
        'https://api.example.com/chat/completions',
        expect.any(Object)
      );
    });

    it('should include optional fields in body when provided', async () => {
      const config: DynamicProviderConfig = {
        name: 'test',
        base_url: 'https://api.example.com',
        endpoints: { chat: '/chat' },
      };

      const provider = new DynamicProvider(config);

      mockFetchWithAgent.mockResolvedValue({
        ok: true,
        json: async () => ({
          id: 'chat-1',
          object: 'chat.completion',
          created: 1,
          model: 'test-model',
          choices: [],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      });

      const request: ChatCompletionRequest = {
        model: 'test-model',
        messages: [{ role: 'user', content: 'hello' }],
        temperature: 0.5,
        top_p: 0.9,
        max_tokens: 100,
        stop: ['stop'],
        presence_penalty: 0.2,
        frequency_penalty: 0.3,
        user: 'user-123',
      };

      await provider.chat(request, providerConfig);

      const callBody = JSON.parse(mockFetchWithAgent.mock.calls[0][1].body);
      expect(callBody.temperature).toBe(0.5);
      expect(callBody.top_p).toBe(0.9);
      expect(callBody.max_tokens).toBe(100);
      expect(callBody.stop).toEqual(['stop']);
      expect(callBody.presence_penalty).toBe(0.2);
      expect(callBody.frequency_penalty).toBe(0.3);
      expect(callBody.user).toBe('user-123');
      expect(callBody.stream).toBe(false);
    });

    it('should include tools and tool_choice in body when provided', async () => {
      const config: DynamicProviderConfig = {
        name: 'test',
        base_url: 'https://api.example.com',
        endpoints: { chat: '/chat' },
      };

      const provider = new DynamicProvider(config);

      mockFetchWithAgent.mockResolvedValue({
        ok: true,
        json: async () => ({
          id: 'chat-1',
          object: 'chat.completion',
          created: 1,
          model: 'test-model',
          choices: [],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      });

      const request: ChatCompletionRequest = {
        model: 'test-model',
        messages: [{ role: 'user', content: 'hello' }],
        tools: [{ type: 'function', function: { name: 'fn', description: 'desc', parameters: {} } }],
        tool_choice: { type: 'function', function: { name: 'fn' } },
      };

      await provider.chat(request, providerConfig);

      const callBody = JSON.parse(mockFetchWithAgent.mock.calls[0][1].body);
      expect(callBody.tools).toEqual(request.tools);
      expect(callBody.tool_choice).toEqual(request.tool_choice);
    });

    it('should not include tools when tools array is empty', async () => {
      const config: DynamicProviderConfig = {
        name: 'test',
        base_url: 'https://api.example.com',
        endpoints: { chat: '/chat' },
      };

      const provider = new DynamicProvider(config);

      mockFetchWithAgent.mockResolvedValue({
        ok: true,
        json: async () => ({
          id: 'chat-1',
          object: 'chat.completion',
          created: 1,
          model: 'test-model',
          choices: [],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      });

      const request: ChatCompletionRequest = {
        model: 'test-model',
        messages: [{ role: 'user', content: 'hello' }],
        tools: [],
      };

      await provider.chat(request, providerConfig);

      const callBody = JSON.parse(mockFetchWithAgent.mock.calls[0][1].body);
      expect(callBody.tools).toBeUndefined();
    });

    it('should throw on error response', async () => {
      const config: DynamicProviderConfig = {
        name: 'test',
        base_url: 'https://api.example.com',
        endpoints: { chat: '/chat' },
      };

      const provider = new DynamicProvider(config);

      mockFetchWithAgent.mockResolvedValue({
        ok: false,
        status: 400,
        statusText: 'Bad Request',
        json: async () => ({ message: 'Invalid request' }),
      });

      const request: ChatCompletionRequest = {
        model: 'test-model',
        messages: [{ role: 'user', content: 'hello' }],
      };

      await expect(provider.chat(request, providerConfig)).rejects.toThrow('Invalid request');
    });
  });

  describe('chatStream', () => {
    it('should return parsed stream on success', async () => {
      const config: DynamicProviderConfig = {
        name: 'test',
        base_url: 'https://api.example.com',
        endpoints: { chat_stream: '/chat/stream' },
      };

      const provider = new DynamicProvider(config);

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
        model: 'test-model',
        messages: [{ role: 'user', content: 'hello' }],
      };

      const result = await provider.chatStream(request, providerConfig);

      expect(result).toBeInstanceOf(ReadableStream);
      expect(mockFetchWithAgent).toHaveBeenCalledWith(
        'https://api.example.com/chat/stream',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            Authorization: 'Bearer dynamic-test-key',
          }),
        })
      );
    });

    it('should fallback to chat endpoint when chat_stream is not configured', async () => {
      const config: DynamicProviderConfig = {
        name: 'test',
        base_url: 'https://api.example.com',
        endpoints: { chat: '/chat' },
      };

      const provider = new DynamicProvider(config);

      const stream = new ReadableStream({
        start(controller) {
          controller.close();
        },
      });

      mockFetchWithAgent.mockResolvedValue({
        ok: true,
        body: stream,
      });

      const request: ChatCompletionRequest = {
        model: 'test-model',
        messages: [{ role: 'user', content: 'hello' }],
      };

      await provider.chatStream(request, providerConfig);

      expect(mockFetchWithAgent).toHaveBeenCalledWith(
        'https://api.example.com/chat',
        expect.any(Object)
      );
    });

    it('should set stream to true in body', async () => {
      const config: DynamicProviderConfig = {
        name: 'test',
        base_url: 'https://api.example.com',
        endpoints: { chat_stream: '/chat/stream' },
      };

      const provider = new DynamicProvider(config);

      const stream = new ReadableStream({
        start(controller) {
          controller.close();
        },
      });

      mockFetchWithAgent.mockResolvedValue({
        ok: true,
        body: stream,
      });

      const request: ChatCompletionRequest = {
        model: 'test-model',
        messages: [{ role: 'user', content: 'hello' }],
      };

      await provider.chatStream(request, providerConfig);

      const callBody = JSON.parse(mockFetchWithAgent.mock.calls[0][1].body);
      expect(callBody.stream).toBe(true);
    });

    it('should include tools and tool_choice in stream body when provided', async () => {
      const config: DynamicProviderConfig = {
        name: 'test',
        base_url: 'https://api.example.com',
        endpoints: { chat_stream: '/chat/stream' },
      };

      const provider = new DynamicProvider(config);

      const stream = new ReadableStream({
        start(controller) {
          controller.close();
        },
      });

      mockFetchWithAgent.mockResolvedValue({
        ok: true,
        body: stream,
      });

      const request: ChatCompletionRequest = {
        model: 'test-model',
        messages: [{ role: 'user', content: 'hello' }],
        tools: [{ type: 'function', function: { name: 'fn', description: 'desc', parameters: {} } }],
        tool_choice: 'auto',
      };

      await provider.chatStream(request, providerConfig);

      const callBody = JSON.parse(mockFetchWithAgent.mock.calls[0][1].body);
      expect(callBody.tools).toEqual(request.tools);
      expect(callBody.tool_choice).toBe('auto');
      expect(callBody.stream).toBe(true);
    });

    it('should throw on error response', async () => {
      const config: DynamicProviderConfig = {
        name: 'test',
        base_url: 'https://api.example.com',
        endpoints: { chat_stream: '/chat/stream' },
      };

      const provider = new DynamicProvider(config);

      mockFetchWithAgent.mockResolvedValue({
        ok: false,
        status: 429,
        statusText: 'Too Many Requests',
        json: async () => ({ error: { message: 'Rate limited' } }),
      });

      const request: ChatCompletionRequest = {
        model: 'test-model',
        messages: [{ role: 'user', content: 'hello' }],
      };

      await expect(provider.chatStream(request, providerConfig)).rejects.toThrow('Rate limited');
    });
  });

  describe('embed', () => {
    it('should return embedding response on success', async () => {
      const config: DynamicProviderConfig = {
        name: 'test',
        base_url: 'https://api.example.com',
        endpoints: { embeddings: '/embed' },
      };

      const provider = new DynamicProvider(config);

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
        'https://api.example.com/embed',
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('"encoding_format":"float"'),
        })
      );
    });

    it('should use default endpoint when embeddings is not configured', async () => {
      const config: DynamicProviderConfig = {
        name: 'test',
        base_url: 'https://api.example.com',
        endpoints: {},
      };

      const provider = new DynamicProvider(config);

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

      expect(mockFetchWithAgent).toHaveBeenCalledWith(
        'https://api.example.com/embeddings',
        expect.any(Object)
      );
    });

    it('should include dimensions when provided', async () => {
      const config: DynamicProviderConfig = {
        name: 'test',
        base_url: 'https://api.example.com',
        endpoints: { embeddings: '/embed' },
      };

      const provider = new DynamicProvider(config);

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

    it('should throw on error response', async () => {
      const config: DynamicProviderConfig = {
        name: 'test',
        base_url: 'https://api.example.com',
        endpoints: { embeddings: '/embed' },
      };

      const provider = new DynamicProvider(config);

      mockFetchWithAgent.mockResolvedValue({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        json: async () => ({ message: 'Server error' }),
      });

      const request: EmbeddingRequest = {
        model: 'text-embedding-3',
        input: 'hello',
      };

      await expect(provider.embed(request, providerConfig)).rejects.toThrow('Server error');
    });
  });
});
