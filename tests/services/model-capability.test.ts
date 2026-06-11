/**
 * 模型能力服务测试
 */
import {
  inferRequirements,
  parsePoolCapabilities,
  checkCapabilityMatch,
  formatCapabilityError,
} from '../../src/services/model-capability';
import type { ChatCompletionRequest, IProviderCapabilities } from '../../src/types';

describe('Model Capability Service', () => {
  describe('inferRequirements', () => {
    it('should detect vision requirement from image_url content', () => {
      const request: ChatCompletionRequest = {
        model: 'gpt-4o',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image_url', image_url: { url: 'https://example.com/image.png' } },
              { type: 'text', text: 'Describe this image' },
            ],
          },
        ],
      };
      const reqs = inferRequirements(request);
      expect(reqs.vision).toBe(true);
      expect(reqs.function_call).toBe(false);
      expect(reqs.streaming).toBe(false);
    });

    it('should detect function_call requirement from tools', () => {
      const request: ChatCompletionRequest = {
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'Hello' }],
        tools: [
          {
            type: 'function',
            function: { name: 'get_weather', description: 'Get weather', parameters: {} },
          },
        ],
      };
      const reqs = inferRequirements(request);
      expect(reqs.function_call).toBe(true);
      expect(reqs.vision).toBe(false);
    });

    it('should detect streaming requirement', () => {
      const request: ChatCompletionRequest = {
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'Hello' }],
        stream: true,
      };
      const reqs = inferRequirements(request);
      expect(reqs.streaming).toBe(true);
    });

    it('should detect reasoning from model name hint', () => {
      const request: ChatCompletionRequest = {
        model: 'deepseek-reasoner',
        messages: [{ role: 'user', content: 'Hello' }],
      };
      const reqs = inferRequirements(request);
      expect(reqs.reasoning).toBe(true);
    });

    it('should detect reasoning from o1 model name', () => {
      const request: ChatCompletionRequest = {
        model: 'o1-preview',
        messages: [{ role: 'user', content: 'Hello' }],
      };
      const reqs = inferRequirements(request);
      expect(reqs.reasoning).toBe(true);
    });

    it('should return no requirements for simple text request', () => {
      const request: ChatCompletionRequest = {
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'Hello' }],
      };
      const reqs = inferRequirements(request);
      expect(reqs.vision).toBe(false);
      expect(reqs.function_call).toBe(false);
      expect(reqs.reasoning).toBe(false);
      expect(reqs.streaming).toBe(false);
    });

    it('should detect multiple requirements', () => {
      const request: ChatCompletionRequest = {
        model: 'o1',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image_url', image_url: { url: 'https://example.com/image.png' } },
              { type: 'text', text: 'Analyze' },
            ],
          },
        ],
        tools: [{ type: 'function', function: { name: 'calc', description: 'calc', parameters: {} } }],
        stream: true,
      };
      const reqs = inferRequirements(request);
      expect(reqs.vision).toBe(true);
      expect(reqs.function_call).toBe(true);
      expect(reqs.reasoning).toBe(true);
      expect(reqs.streaming).toBe(true);
    });
  });

  describe('parsePoolCapabilities', () => {
    it('should convert capability strings to IProviderCapabilities partial', () => {
      const caps = parsePoolCapabilities(['chat', 'vision', 'function_call']);
      expect(caps.chat).toBe(true);
      expect(caps.vision).toBe(true);
      expect(caps.function_call).toBe(true);
      expect(caps.embed).toBeUndefined();
      expect(caps.streaming).toBeUndefined();
      expect(caps.reasoning).toBeUndefined();
    });

    it('should handle empty array', () => {
      const caps = parsePoolCapabilities([]);
      expect(Object.keys(caps).length).toBe(0);
    });

    it('should ignore unknown capability strings', () => {
      const caps = parsePoolCapabilities(['chat', 'unknown_capability', 'vision']);
      expect(caps.chat).toBe(true);
      expect(caps.vision).toBe(true);
      expect((caps as Record<string, unknown>).unknown_capability).toBeUndefined();
    });
  });

  describe('checkCapabilityMatch', () => {
    it('should return empty array when all requirements are met', () => {
      const reqs = { vision: true, function_call: true, reasoning: false, streaming: false };
      const caps: Partial<IProviderCapabilities> = {
        vision: true,
        function_call: true,
        streaming: true,
      };
      const missing = checkCapabilityMatch(reqs, caps);
      expect(missing).toEqual([]);
    });

    it('should return missing capabilities when requirements are not met', () => {
      const reqs = { vision: true, function_call: true, reasoning: false, streaming: true };
      const caps: Partial<IProviderCapabilities> = {
        chat: true,
        streaming: true,
      };
      const missing = checkCapabilityMatch(reqs, caps);
      expect(missing).toContain('vision');
      expect(missing).toContain('function_call');
      expect(missing).not.toContain('streaming');
      expect(missing).not.toContain('reasoning');
    });

    it('should return empty array when capabilities are unknown (null)', () => {
      const reqs = { vision: true, function_call: true, reasoning: false, streaming: false };
      const missing = checkCapabilityMatch(reqs, null);
      expect(missing).toEqual([]);
    });

    it('should only check capabilities that are required', () => {
      const reqs = { vision: false, function_call: false, reasoning: false, streaming: false };
      const caps: Partial<IProviderCapabilities> = {};
      const missing = checkCapabilityMatch(reqs, caps);
      expect(missing).toEqual([]);
    });
  });

  describe('formatCapabilityError', () => {
    it('should format single missing capability', () => {
      const msg = formatCapabilityError('deepseek-chat', ['vision']);
      expect(msg).toContain("Model 'deepseek-chat' does not support required capabilities: vision");
      expect(msg).toContain('Please use a model that supports these features');
    });

    it('should format multiple missing capabilities', () => {
      const msg = formatCapabilityError('some-model', ['vision', 'function_call']);
      expect(msg).toContain('vision, function_call');
    });
  });
});
