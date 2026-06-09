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

    it('should support reasoning', () => {
      const provider = new AnthropicProvider();
      expect(provider.capabilities.reasoning).toBe(true);
    });
  });

  describe('convertMessages', () => {
    it('should skip system messages (they are handled via system parameter)', async () => {
      const provider = new AnthropicProvider();
      const request: ChatCompletionRequest = {
        model: 'claude-3-opus',
        messages: [
          { role: 'system', content: 'You are a helpful assistant' },
          { role: 'user', content: 'hello' },
          { role: 'assistant', content: 'hi' },
        ],
      };

      const result = await (provider as unknown as { convertMessages: (messages: ChatCompletionRequest['messages']) => Promise<Array<{ role: string; content: unknown }>> }).convertMessages(request.messages);

      // System messages are skipped and sent via the 'system' parameter instead
      expect(result).toEqual([
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi' },
      ]);
    });

    it('should keep user and assistant roles', async () => {
      const provider = new AnthropicProvider();
      const request: ChatCompletionRequest = {
        model: 'claude-3-opus',
        messages: [
          { role: 'user', content: 'hello' },
          { role: 'assistant', content: 'hi there' },
        ],
      };

      const result = await (provider as unknown as { convertMessages: (messages: ChatCompletionRequest['messages']) => Promise<Array<{ role: string; content: unknown }>> }).convertMessages(request.messages);

      expect(result).toEqual([
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi there' },
      ]);
    });

    it('should convert tool role messages to tool_result blocks', async () => {
      const provider = new AnthropicProvider();
      const request: ChatCompletionRequest = {
        model: 'claude-3-opus',
        messages: [
          { role: 'user', content: 'What is the weather?' },
          {
            role: 'assistant',
            content: '',
            tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{}' } }],
          },
          { role: 'tool', content: 'Sunny, 25°C', tool_call_id: 'call_1' },
        ],
      };

      const result = await (provider as unknown as { convertMessages: (messages: ChatCompletionRequest['messages']) => Promise<Array<{ role: string; content: unknown }>> }).convertMessages(request.messages);

      expect(result).toEqual([
        { role: 'user', content: 'What is the weather?' },
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'call_1', name: 'get_weather', input: {} }],
        },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'Sunny, 25°C' }],
        },
      ]);
    });

    it('should convert image_url parts to image blocks', async () => {
      const provider = new AnthropicProvider();
      const request: ChatCompletionRequest = {
        model: 'claude-3-opus',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'What is in this image?' },
              { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,/9j/4AAQ' } },
            ],
          },
        ],
      };

      const result = await (provider as unknown as { convertMessages: (messages: ChatCompletionRequest['messages']) => Promise<Array<{ role: string; content: unknown }>> }).convertMessages(request.messages);

      expect(result).toEqual([
        {
          role: 'user',
          content: [
            { type: 'text', text: 'What is in this image?' },
            { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: '/9j/4AAQ' } },
          ],
        },
      ]);
    });

    it('should convert assistant tool_calls to tool_use blocks with text', async () => {
      const provider = new AnthropicProvider();
      const request: ChatCompletionRequest = {
        model: 'claude-3-opus',
        messages: [
          {
            role: 'assistant',
            content: 'Let me check',
            tool_calls: [
              { id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"location":"Beijing"}' } },
            ],
          },
        ],
      };

      const result = await (provider as unknown as { convertMessages: (messages: ChatCompletionRequest['messages']) => Promise<Array<{ role: string; content: unknown }>> }).convertMessages(request.messages);

      expect(result).toEqual([
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Let me check' },
            { type: 'tool_use', id: 'call_1', name: 'get_weather', input: { location: 'Beijing' } },
          ],
        },
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

    it('should convert tools and tool_choice in request body', async () => {
      const provider = new AnthropicProvider();

      mockFetchWithAgent.mockResolvedValue({
        ok: true,
        json: async () => ({
          id: 'msg_tool',
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
        tools: [{ type: 'function', function: { name: 'get_weather', description: 'Get weather', parameters: { type: 'object' } } }],
        tool_choice: { type: 'function', function: { name: 'get_weather' } },
      };

      await provider.chat(request, providerConfig);

      const callBody = JSON.parse(mockFetchWithAgent.mock.calls[0][1].body);
      expect(callBody.tools).toEqual([{
        name: 'get_weather',
        description: 'Get weather',
        input_schema: { type: 'object' },
      }]);
      expect(callBody.tool_choice).toEqual({ type: 'tool', name: 'get_weather' });
    });

    it('should convert tool_choice auto/none/required', async () => {
      const provider = new AnthropicProvider();

      mockFetchWithAgent.mockResolvedValue({
        ok: true,
        json: async () => ({
          id: 'msg_tc',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: 'ok' }],
          model: 'claude-3-opus',
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
      });

      // auto
      await provider.chat({
        model: 'claude-3-opus',
        messages: [{ role: 'user', content: 'hi' }],
        tool_choice: 'auto',
      } as ChatCompletionRequest, providerConfig);
      expect(JSON.parse(mockFetchWithAgent.mock.calls[0][1].body).tool_choice).toEqual({ type: 'auto' });

      // none
      await provider.chat({
        model: 'claude-3-opus',
        messages: [{ role: 'user', content: 'hi' }],
        tool_choice: 'none',
      } as ChatCompletionRequest, providerConfig);
      expect(JSON.parse(mockFetchWithAgent.mock.calls[1][1].body).tool_choice).toEqual({ type: 'none' });

      // required
      await provider.chat({
        model: 'claude-3-opus',
        messages: [{ role: 'user', content: 'hi' }],
        tool_choice: 'required',
      } as ChatCompletionRequest, providerConfig);
      expect(JSON.parse(mockFetchWithAgent.mock.calls[2][1].body).tool_choice).toEqual({ type: 'any' });
    });

    it('should map tool_use response to tool_calls', async () => {
      const provider = new AnthropicProvider();

      mockFetchWithAgent.mockResolvedValue({
        ok: true,
        json: async () => ({
          id: 'msg_tu',
          type: 'message',
          role: 'assistant',
          content: [
            { type: 'text', text: 'Let me check' },
            { type: 'tool_use', id: 'tu_1', name: 'get_weather', input: { location: 'Beijing' } },
          ],
          model: 'claude-3-opus',
          stop_reason: 'tool_use',
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 20 },
        }),
      });

      const request: ChatCompletionRequest = {
        model: 'claude-3-opus',
        messages: [{ role: 'user', content: 'Weather?' }],
      };

      const result = await provider.chat(request, providerConfig);

      expect(result.choices[0].message.content).toBe('Let me check');
      expect(result.choices[0].message.tool_calls).toEqual([{
        id: 'tu_1',
        type: 'function',
        function: {
          name: 'get_weather',
          arguments: '{"location":"Beijing"}',
        },
      }]);
      expect(result.choices[0].finish_reason).toBe('tool_calls');
    });

    it('should extract thinking blocks to reasoning_content', async () => {
      const provider = new AnthropicProvider();

      mockFetchWithAgent.mockResolvedValue({
        ok: true,
        json: async () => ({
          id: 'msg_think',
          type: 'message',
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'Let me analyze this step by step.' },
            { type: 'text', text: 'The answer is 42.' },
          ],
          model: 'claude-3-opus',
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 15 },
        }),
      });

      const request: ChatCompletionRequest = {
        model: 'claude-3-opus',
        messages: [{ role: 'user', content: 'What is the answer?' }],
      };

      const result = await provider.chat(request, providerConfig);

      expect(result.choices[0].message.content).toBe('The answer is 42.');
      expect(result.choices[0].message.reasoning_content).toBe('Let me analyze this step by step.');
      expect(result.choices[0].finish_reason).toBe('stop');
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

    it('should convert tools in stream request body', async () => {
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
        tools: [{ type: 'function', function: { name: 'get_weather', description: 'desc', parameters: {} } }],
      };

      await provider.chatStream(request, providerConfig);

      const callBody = JSON.parse(mockFetchWithAgent.mock.calls[0][1].body);
      expect(callBody.tools).toEqual([{ name: 'get_weather', description: 'desc', input_schema: {} }]);
    });

    it('should parse stream tool_use blocks', async () => {
      const provider = new AnthropicProvider();

      const encoder = new TextEncoder();
      const source = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(
            'data: {"type":"message_start","message":{"id":"msg_01","model":"claude-3-opus"}}\n\n'
          ));
          controller.enqueue(encoder.encode(
            'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"tu_1","name":"get_weather"}}\n\n'
          ));
          controller.enqueue(encoder.encode(
            'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"location\\":\\"Beijing\\"}"}}\n\n'
          ));
          controller.enqueue(encoder.encode(
            'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"}}\n\n'
          ));
          controller.close();
        },
      });

      mockFetchWithAgent.mockResolvedValue({
        ok: true,
        body: source,
      });

      const request: ChatCompletionRequest = {
        model: 'claude-3-opus',
        messages: [{ role: 'user', content: 'Weather?' }],
      };

      const result = await provider.chatStream(request, providerConfig);
      const reader = result.getReader();
      const chunks: string[] = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(new TextDecoder().decode(value));
      }

      // tool_use start
      expect(chunks[0]).toContain('tool_calls');
      expect(chunks[0]).toContain('get_weather');
      // input_json_delta
      expect(chunks[1]).toContain('Beijing');
      // finish_reason
      expect(chunks[2]).toContain('"finish_reason":"tool_calls"');
    });

    it('should parse thinking_delta to reasoning_content in stream', async () => {
      const provider = new AnthropicProvider();

      const encoder = new TextEncoder();
      const source = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(
            'data: {"type":"message_start","message":{"id":"msg_01","model":"claude-3-opus"}}\n\n'
          ));
          controller.enqueue(encoder.encode(
            'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"Let me think"}}\n\n'
          ));
          controller.enqueue(encoder.encode(
            'data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"The answer is 42."}}\n\n'
          ));
          controller.enqueue(encoder.encode(
            'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n'
          ));
          controller.close();
        },
      });

      mockFetchWithAgent.mockResolvedValue({
        ok: true,
        body: source,
      });

      const request: ChatCompletionRequest = {
        model: 'claude-3-opus',
        messages: [{ role: 'user', content: 'What is the answer?' }],
      };

      const result = await provider.chatStream(request, providerConfig);
      const reader = result.getReader();
      const chunks: string[] = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(new TextDecoder().decode(value));
      }

      // thinking_delta → reasoning_content
      expect(chunks[0]).toContain('reasoning_content');
      expect(chunks[0]).toContain('Let me think');
      // text_delta → content
      expect(chunks[1]).toContain('The answer is 42.');
      // finish_reason
      expect(chunks[2]).toContain('"finish_reason":"stop"');
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
