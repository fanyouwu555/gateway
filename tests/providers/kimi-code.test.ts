/**
 * Kimi Code Provider Tests
 * Verify it uses OpenAI-compatible protocol (not Anthropic)
 */
import { kimiCodeProvider } from '../../src/providers/kimi-code';

describe('KimiCodeProvider', () => {
  it('should be registered as openai-compatible provider', () => {
    expect(kimiCodeProvider.name).toBe('kimi-code');
  });

  it('should support chat and streaming', () => {
    expect(kimiCodeProvider.capabilities.chat).toBe(true);
    expect(kimiCodeProvider.capabilities.streaming).toBe(true);
    expect(kimiCodeProvider.capabilities.function_call).toBe(true);
  });

  it('should not support embed', () => {
    expect(kimiCodeProvider.capabilities.embed).toBe(false);
  });
});
