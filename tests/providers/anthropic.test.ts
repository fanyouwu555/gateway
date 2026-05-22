/**
 * Anthropic Provider Tests
 */
import { anthropicProvider } from '../../src/providers/anthropic';

describe('AnthropicProvider', () => {
  it('should be registered', () => {
    expect(anthropicProvider.name).toBe('anthropic');
  });

  it('should support chat and streaming', () => {
    expect(anthropicProvider.capabilities.chat).toBe(true);
    expect(anthropicProvider.capabilities.streaming).toBe(true);
  });

  it('should not support embed', () => {
    expect(anthropicProvider.capabilities.embed).toBe(false);
  });
});
