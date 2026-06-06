/**
 * BaseProvider 测试
 */
import { BaseProvider } from '../../src/providers/base';
import type { IProviderConfig, ChatCompletionResponse, EmbeddingResponse } from '../../src/types';

// Mock fetchWithAgent
const mockFetchWithAgent = jest.fn();
jest.mock('../../src/utils/http-client', () => ({
  fetchWithAgent: (...args: unknown[]) => mockFetchWithAgent(...args),
}));

class TestProvider extends BaseProvider {
  name = 'test';
  capabilities = { chat: true, embed: true, streaming: true, vision: false, function_call: false };

  async chat(): Promise<ChatCompletionResponse> {
    return { id: '1', object: 'chat.completion', created: 1, model: 'test', choices: [], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } };
  }

  async chatStream(): Promise<ReadableStream> {
    return new ReadableStream();
  }

  async embed(): Promise<EmbeddingResponse> {
    return { object: 'list', data: [], model: 'test', usage: { prompt_tokens: 0, total_tokens: 0 } };
  }
}

describe('BaseProvider', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('buildHeaders', () => {
    it('should build basic headers', () => {
      const provider = new TestProvider();
      const config: IProviderConfig = { provider: 'test', base_url: 'http://localhost', api_key: 'sk-test' };
      const headers = (provider as any).buildHeaders(config);
      expect(headers).toEqual({
        'Content-Type': 'application/json',
        'Authorization': 'Bearer sk-test',
      });
    });

    it('should build headers without api_key', () => {
      const provider = new TestProvider();
      const config: IProviderConfig = { provider: 'test', base_url: 'http://localhost' };
      const headers = (provider as any).buildHeaders(config);
      expect(headers).toEqual({
        'Content-Type': 'application/json',
      });
    });

    it('should merge custom headers', () => {
      const provider = new TestProvider();
      const config: IProviderConfig = { provider: 'test', base_url: 'http://localhost', api_key: 'sk-test', headers: { 'X-Custom': 'value' } };
      const headers = (provider as any).buildHeaders(config);
      expect(headers).toEqual({
        'Content-Type': 'application/json',
        'Authorization': 'Bearer sk-test',
        'X-Custom': 'value',
      });
    });
  });

  describe('fetch', () => {
    it('should return parsed json on success', async () => {
      const provider = new TestProvider();
      mockFetchWithAgent.mockResolvedValue({
        ok: true,
        json: async () => ({ result: 'ok' }),
      });

      const result = await (provider as any).fetch('http://localhost/api', { method: 'POST' });
      expect(result).toEqual({ result: 'ok' });
      expect(mockFetchWithAgent).toHaveBeenCalledWith('http://localhost/api', expect.objectContaining({ method: 'POST', signal: expect.any(AbortSignal) }));
    });

    it('should throw on non-ok response with error message', async () => {
      const provider = new TestProvider();
      mockFetchWithAgent.mockResolvedValue({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        json: async () => ({ message: 'Something went wrong' }),
      });

      await expect((provider as any).fetch('http://localhost/api', {})).rejects.toThrow('Something went wrong');
    });

    it('should throw on non-ok response with fallback message', async () => {
      const provider = new TestProvider();
      mockFetchWithAgent.mockResolvedValue({
        ok: false,
        status: 404,
        statusText: 'Not Found',
        json: async () => ({}),
      });

      await expect((provider as any).fetch('http://localhost/api', {})).rejects.toThrow('HTTP 404: Not Found');
    });

    it('should throw on non-ok response when json parse fails', async () => {
      const provider = new TestProvider();
      mockFetchWithAgent.mockResolvedValue({
        ok: false,
        status: 503,
        statusText: 'Service Unavailable',
        json: async () => { throw new Error('invalid json'); },
      });

      await expect((provider as any).fetch('http://localhost/api', {})).rejects.toThrow('HTTP 503: Service Unavailable');
    });
  });

  describe('parseStream', () => {
    it('should parse SSE stream and emit chunks', async () => {
      const provider = new TestProvider();
      const encoder = new TextEncoder();
      const source = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode('data: {"id":"1","choices":[]}\n\n'));
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
        },
      });

      const stream = (provider as any).parseStream(source);
      const reader = stream.getReader();
      const chunks: string[] = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(new TextDecoder().decode(value));
      }

      expect(chunks.length).toBeGreaterThan(0);
      expect(chunks[0]).toContain('chat.completion.chunk');
    });

    it('should handle empty stream', async () => {
      const provider = new TestProvider();
      const source = new ReadableStream({
        start(controller) {
          controller.close();
        },
      });

      const stream = (provider as any).parseStream(source);
      const reader = stream.getReader();
      const { done } = await reader.read();
      expect(done).toBe(true);
    });

    it('should handle cancel', async () => {
      const provider = new TestProvider();
      let cancelled = false;
      const source = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
        },
        cancel() {
          cancelled = true;
        },
      });

      const stream = (provider as any).parseStream(source);
      const reader = stream.getReader();
      await reader.cancel();
      expect(cancelled).toBe(true);
    });
  });
});
