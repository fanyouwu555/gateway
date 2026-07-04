/**
 * Token 计数服务测试
 */
import {
  accumulateStreamContent,
  countPromptTokens,
  countCompletionTokens,
  countTotalTokens,
} from '../../src/services/token-counter';

describe('Token Counter', () => {
  describe('accumulateStreamContent', () => {
    it('should append string delta to previous content', () => {
      expect(accumulateStreamContent('Hello', { content: ' world' })).toBe('Hello world');
    });

    it('should ignore non-string content', () => {
      expect(accumulateStreamContent('Hello', { content: [{ type: 'text', text: 'x' }] })).toBe('Hello');
    });

    it('should return previous when delta is empty', () => {
      expect(accumulateStreamContent('Hello', undefined)).toBe('Hello');
      expect(accumulateStreamContent('Hello', {})).toBe('Hello');
    });
  });

  describe('countPromptTokens', () => {
    it('should return positive count for simple messages', async () => {
      const count = await countPromptTokens(
        [{ role: 'user', content: 'Hello' }],
        'gpt-4o',
      );
      expect(count).toBeGreaterThan(0);
    });

    it('should count content parts array', async () => {
      const count = await countPromptTokens(
        [{ role: 'user', content: [{ type: 'text', text: 'Hello world' }] }],
        'gpt-4o',
      );
      expect(count).toBeGreaterThan(0);
    });

    it('should handle tool calls when tiktoken available', async () => {
      const count = await countPromptTokens(
        [{
          role: 'assistant',
          content: '',
          tool_calls: [{
            id: '1',
            type: 'function',
            function: { name: 'get_weather', arguments: '{"city":"bj"}' },
          }],
        }],
        'gpt-4o',
      );
      expect(count).toBeGreaterThan(0);
    });
  });

  describe('countCompletionTokens', () => {
    it('should return zero for empty text', async () => {
      const count = await countCompletionTokens('', 'gpt-4o');
      expect(count).toBe(0);
    });

    it('should return positive count for non-empty text', async () => {
      const count = await countCompletionTokens('Hello world', 'gpt-4o');
      expect(count).toBeGreaterThan(0);
    });
  });

  describe('countTotalTokens', () => {
    it('should sum prompt and completion tokens', async () => {
      const total = await countTotalTokens(
        [{ role: 'user', content: 'Hi' }],
        'Hi there',
        'gpt-4o',
      );
      const prompt = await countPromptTokens([{ role: 'user', content: 'Hi' }], 'gpt-4o');
      const completion = await countCompletionTokens('Hi there', 'gpt-4o');
      expect(total).toBe(prompt + completion);
    });
  });
});
