import { AzureOpenAIProvider } from '../../src/providers/azure-openai';
import type { ChatCompletionRequest, EmbeddingRequest, IProviderConfig } from '../../src/types';

const mockFetchWithAgent = jest.fn();
jest.mock('../../src/utils/http-client', () => ({
  fetchWithAgent: (...args: unknown[]) => mockFetchWithAgent(...args),
}));

describe('AzureOpenAIProvider', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
    mockFetchWithAgent.mockReset();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('URL and headers', () => {
    it('should build correct URL', () => {
      process.env.AZURE_OPENAI_RESOURCE = 'my-resource';
      process.env.AZURE_OPENAI_DEPLOYMENT = 'gpt-4o';
      process.env.AZURE_OPENAI_API_KEY = 'test-key';

      const provider = new AzureOpenAIProvider();
      const url = (provider as unknown as { buildAzureUrl: (path: string) => string }).buildAzureUrl('/chat/completions');
      expect(url).toBe('https://my-resource.openai.azure.com/openai/deployments/gpt-4o/chat/completions?api-version=2024-02-01');
    });

    it('should use api-key header', () => {
      process.env.AZURE_OPENAI_RESOURCE = 'my-resource';
      process.env.AZURE_OPENAI_DEPLOYMENT = 'gpt-4o';
      process.env.AZURE_OPENAI_API_KEY = 'test-key';

      const provider = new AzureOpenAIProvider();
      const headers = (provider as unknown as { buildAzureHeaders: () => Record<string, string> }).buildAzureHeaders();
      expect(headers['api-key']).toBe('test-key');
      expect(headers['Authorization']).toBeUndefined();
    });

    it('should use custom api version', () => {
      process.env.AZURE_OPENAI_RESOURCE = 'my-resource';
      process.env.AZURE_OPENAI_DEPLOYMENT = 'gpt-4o';
      process.env.AZURE_OPENAI_API_KEY = 'test-key';
      process.env.AZURE_OPENAI_API_VERSION = '2024-06-01';

      const provider = new AzureOpenAIProvider();
      const url = (provider as unknown as { buildAzureUrl: (path: string) => string }).buildAzureUrl('/embeddings');
      expect(url).toBe('https://my-resource.openai.azure.com/openai/deployments/gpt-4o/embeddings?api-version=2024-06-01');
    });
  });

  describe('chat', () => {
    it('should return chat completion on success', async () => {
      process.env.AZURE_OPENAI_RESOURCE = 'my-resource';
      process.env.AZURE_OPENAI_DEPLOYMENT = 'gpt-4o';
      process.env.AZURE_OPENAI_API_KEY = 'test-key';

      const provider = new AzureOpenAIProvider();

      const mockResponse = {
        id: 'chat-1',
        object: 'chat.completion',
        created: 1,
        model: 'gpt-4o',
        choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      };

      mockFetchWithAgent.mockResolvedValue({
        ok: true,
        json: async () => mockResponse,
      });

      const config: IProviderConfig = {
        provider: 'azure-openai',
        base_url: 'https://my-resource.openai.azure.com',
        api_key: 'test-key',
      };

      const request: ChatCompletionRequest = {
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'hello' }],
      };

      const result = await provider.chat(request, config);

      expect(result).toEqual(mockResponse);
      expect(mockFetchWithAgent).toHaveBeenCalledWith(
        'https://my-resource.openai.azure.com/openai/deployments/gpt-4o/chat/completions?api-version=2024-02-01',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'Content-Type': 'application/json',
            'api-key': 'test-key',
          }),
        })
      );
    });

    it('should throw on error response', async () => {
      process.env.AZURE_OPENAI_RESOURCE = 'my-resource';
      process.env.AZURE_OPENAI_DEPLOYMENT = 'gpt-4o';
      process.env.AZURE_OPENAI_API_KEY = 'test-key';

      const provider = new AzureOpenAIProvider();

      mockFetchWithAgent.mockResolvedValue({
        ok: false,
        status: 400,
        statusText: 'Bad Request',
        json: async () => ({ message: 'Invalid model' }),
      });

      const config: IProviderConfig = {
        provider: 'azure-openai',
        base_url: 'https://my-resource.openai.azure.com',
        api_key: 'test-key',
      };

      const request: ChatCompletionRequest = {
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'hello' }],
      };

      await expect(provider.chat(request, config)).rejects.toThrow('Invalid model');
    });

    it('should throw default HTTP error when no message in body', async () => {
      process.env.AZURE_OPENAI_RESOURCE = 'my-resource';
      process.env.AZURE_OPENAI_DEPLOYMENT = 'gpt-4o';
      process.env.AZURE_OPENAI_API_KEY = 'test-key';

      const provider = new AzureOpenAIProvider();

      mockFetchWithAgent.mockResolvedValue({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        json: async () => ({}),
      });

      const config: IProviderConfig = {
        provider: 'azure-openai',
        base_url: 'https://my-resource.openai.azure.com',
        api_key: 'test-key',
      };

      const request: ChatCompletionRequest = {
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'hello' }],
      };

      await expect(provider.chat(request, config)).rejects.toThrow('HTTP 500: Internal Server Error');
    });
  });

  describe('chatStream', () => {
    it('should return parsed stream on success', async () => {
      process.env.AZURE_OPENAI_RESOURCE = 'my-resource';
      process.env.AZURE_OPENAI_DEPLOYMENT = 'gpt-4o';
      process.env.AZURE_OPENAI_API_KEY = 'test-key';

      const provider = new AzureOpenAIProvider();

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

      const config: IProviderConfig = {
        provider: 'azure-openai',
        base_url: 'https://my-resource.openai.azure.com',
        api_key: 'test-key',
      };

      const request: ChatCompletionRequest = {
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'hello' }],
      };

      const result = await provider.chatStream(request, config);

      expect(result).toBeInstanceOf(ReadableStream);
      expect(mockFetchWithAgent).toHaveBeenCalledWith(
        expect.stringContaining('/chat/completions'),
        expect.objectContaining({
          headers: expect.objectContaining({
            'api-key': 'test-key',
          }),
        })
      );
    });

    it('should throw on error response', async () => {
      process.env.AZURE_OPENAI_RESOURCE = 'my-resource';
      process.env.AZURE_OPENAI_DEPLOYMENT = 'gpt-4o';
      process.env.AZURE_OPENAI_API_KEY = 'test-key';

      const provider = new AzureOpenAIProvider();

      mockFetchWithAgent.mockResolvedValue({
        ok: false,
        status: 429,
        statusText: 'Too Many Requests',
        json: async () => ({ message: 'Rate limited' }),
      });

      const config: IProviderConfig = {
        provider: 'azure-openai',
        base_url: 'https://my-resource.openai.azure.com',
        api_key: 'test-key',
      };

      const request: ChatCompletionRequest = {
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'hello' }],
      };

      await expect(provider.chatStream(request, config)).rejects.toThrow('Rate limited');
    });

    it('should use custom parseError for stream errors', async () => {
      process.env.AZURE_OPENAI_RESOURCE = 'my-resource';
      process.env.AZURE_OPENAI_DEPLOYMENT = 'gpt-4o';
      process.env.AZURE_OPENAI_API_KEY = 'test-key';

      const provider = new AzureOpenAIProvider();

      mockFetchWithAgent.mockResolvedValue({
        ok: false,
        status: 500,
        statusText: 'Error',
        json: async () => ({ message: 'fail' }),
      });

      const config: IProviderConfig = {
        provider: 'azure-openai',
        base_url: 'https://my-resource.openai.azure.com',
        api_key: 'test-key',
      };

      const request: ChatCompletionRequest = {
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'hello' }],
      };

      await expect(provider.chatStream(request, config)).rejects.toThrow('fail');
    });
  });

  describe('embed', () => {
    it('should return embedding response on success', async () => {
      process.env.AZURE_OPENAI_RESOURCE = 'my-resource';
      process.env.AZURE_OPENAI_DEPLOYMENT = 'text-embedding-3';
      process.env.AZURE_OPENAI_API_KEY = 'test-key';

      const provider = new AzureOpenAIProvider();

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

      const config: IProviderConfig = {
        provider: 'azure-openai',
        base_url: 'https://my-resource.openai.azure.com',
        api_key: 'test-key',
      };

      const request: EmbeddingRequest = {
        model: 'text-embedding-3',
        input: 'hello',
      };

      const result = await provider.embed(request, config);

      expect(result).toEqual(mockResponse);
      expect(mockFetchWithAgent).toHaveBeenCalledWith(
        'https://my-resource.openai.azure.com/openai/deployments/text-embedding-3/embeddings?api-version=2024-02-01',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'api-key': 'test-key',
          }),
          body: expect.stringContaining('"encoding_format":"float"'),
        })
      );
    });

    it('should include dimensions when provided', async () => {
      process.env.AZURE_OPENAI_RESOURCE = 'my-resource';
      process.env.AZURE_OPENAI_DEPLOYMENT = 'text-embedding-3';
      process.env.AZURE_OPENAI_API_KEY = 'test-key';

      const provider = new AzureOpenAIProvider();

      mockFetchWithAgent.mockResolvedValue({
        ok: true,
        json: async () => ({
          object: 'list',
          data: [{ object: 'embedding', embedding: [0.1], index: 0 }],
          model: 'text-embedding-3',
          usage: { prompt_tokens: 1, total_tokens: 1 },
        }),
      });

      const config: IProviderConfig = {
        provider: 'azure-openai',
        base_url: 'https://my-resource.openai.azure.com',
        api_key: 'test-key',
      };

      const request: EmbeddingRequest = {
        model: 'text-embedding-3',
        input: 'hello',
        dimensions: 256,
      };

      await provider.embed(request, config);

      const callBody = JSON.parse(mockFetchWithAgent.mock.calls[0][1].body);
      expect(callBody.dimensions).toBe(256);
    });

    it('should throw on error response', async () => {
      process.env.AZURE_OPENAI_RESOURCE = 'my-resource';
      process.env.AZURE_OPENAI_DEPLOYMENT = 'text-embedding-3';
      process.env.AZURE_OPENAI_API_KEY = 'test-key';

      const provider = new AzureOpenAIProvider();

      mockFetchWithAgent.mockResolvedValue({
        ok: false,
        status: 400,
        statusText: 'Bad Request',
        json: async () => ({ message: 'Invalid input' }),
      });

      const config: IProviderConfig = {
        provider: 'azure-openai',
        base_url: 'https://my-resource.openai.azure.com',
        api_key: 'test-key',
      };

      const request: EmbeddingRequest = {
        model: 'text-embedding-3',
        input: 'hello',
      };

      await expect(provider.embed(request, config)).rejects.toThrow('Invalid input');
    });
  });
});
