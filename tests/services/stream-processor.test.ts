/**
 * Stream Processor Tests
 */
import { processSSEStream } from '../../src/services/stream-processor';

function createSSEStream(lines: string[]): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream({
    pull(controller) {
      if (index >= lines.length) {
        controller.close();
        return;
      }
      controller.enqueue(new TextEncoder().encode(lines[index++]));
    },
  });
}

describe('processSSEStream', () => {
  it('should accumulate content from SSE chunks', async () => {
    const stream = createSSEStream([
      'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":" world"}}]}\n\n',
      'data: [DONE]\n\n',
    ]);
    const result = await processSSEStream(stream.getReader());
    expect(result.content).toBe('Hello world');
    expect(result.error).toBeUndefined();
  });

  it('should capture finish_reason', async () => {
    const stream = createSSEStream([
      'data: {"choices":[{"delta":{"content":"Hi"},"finish_reason":"stop"}]}\n\n',
    ]);
    const result = await processSSEStream(stream.getReader());
    expect(result.finishReason).toBe('stop');
  });

  it('should capture usage from chunks', async () => {
    const stream = createSSEStream([
      'data: {"choices":[{"delta":{"content":"Test"}}],"usage":{"prompt_tokens":10,"completion_tokens":5}}\n\n',
    ]);
    const result = await processSSEStream(stream.getReader());
    expect(result.usage.prompt_tokens).toBe(10);
    expect(result.usage.completion_tokens).toBe(5);
  });

  it('should call onChunk for each parsed chunk', async () => {
    const onChunk = jest.fn();
    const stream = createSSEStream([
      'data: {"choices":[{"delta":{"content":"A"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"B"}}]}\n\n',
    ]);
    await processSSEStream(stream.getReader(), { onChunk });
    expect(onChunk).toHaveBeenCalledTimes(2);
    expect(onChunk.mock.calls[0][0]).toMatchObject({ choices: [{ delta: { content: 'A' } }] });
  });

  it('should accumulate reasoning_content', async () => {
    const stream = createSSEStream([
      'data: {"choices":[{"delta":{"content":"Ans","reasoning_content":"Think"}}]}\n\n',
    ]);
    const result = await processSSEStream(stream.getReader());
    expect(result.reasoningContent).toBe('Think');
    expect(result.content).toBe('Ans');
  });

  it('should accumulate tool_calls', async () => {
    const stream = createSSEStream([
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"get"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"x\\":1}"}}]}}]}\n\n',
    ]);
    const result = await processSSEStream(stream.getReader());
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls![0].id).toBe('call_1');
    expect(result.toolCalls![0].function.name).toBe('get');
    expect(result.toolCalls![0].function.arguments).toBe('{"x":1}');
  });

  it('should skip malformed SSE lines without error', async () => {
    const stream = createSSEStream([
      'not a data line\n\n',
      'data: not valid json\n\n',
      'data: {"choices":[{"delta":{"content":"OK"}}]}\n\n',
    ]);
    const result = await processSSEStream(stream.getReader());
    expect(result.content).toBe('OK');
    expect(result.error).toBeUndefined();
  });

  it('should handle stream abort', async () => {
    const controller = new AbortController();
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n'));
      },
    });

    setTimeout(() => controller.abort(), 10);

    const result = await processSSEStream(stream.getReader(), { signal: controller.signal });
    expect(result.error?.message).toBe('Stream aborted');
  });

  it('should return empty result for empty stream', async () => {
    const stream = createSSEStream([]);
    const result = await processSSEStream(stream.getReader());
    expect(result.content).toBe('');
    expect(result.usage.total_tokens).toBe(0);
  });
});
