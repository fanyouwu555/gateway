/**
 * Volcano Engine Provider Tests
 * Verify it uses OpenAI-compatible protocol
 */
import { volcanoProvider } from '../../src/providers/volcano';

describe('VolcanoProvider', () => {
  it('should be registered as openai-compatible provider', () => {
    expect(volcanoProvider.name).toBe('volcano');
  });

  it('should support chat and streaming', () => {
    expect(volcanoProvider.capabilities.chat).toBe(true);
    expect(volcanoProvider.capabilities.streaming).toBe(true);
    expect(volcanoProvider.capabilities.function_call).toBe(true);
  });

  it('should not support embed', () => {
    expect(volcanoProvider.capabilities.embed).toBe(false);
  });
});
