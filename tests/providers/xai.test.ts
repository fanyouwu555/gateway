import { xaiProvider } from '../../src/providers/xai';

describe('xaiProvider', () => {
  it('should have correct name and capabilities', () => {
    expect(xaiProvider.name).toBe('xai');
    expect(xaiProvider.capabilities.chat).toBe(true);
    expect(xaiProvider.capabilities.streaming).toBe(true);
    expect(xaiProvider.capabilities.vision).toBe(true);
    expect(xaiProvider.capabilities.function_call).toBe(true);
  });
});
