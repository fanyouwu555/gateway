import { togetherProvider } from '../../src/providers/together';

describe('Together AI Provider', () => {
  it('should have correct name', () => {
    expect(togetherProvider.name).toBe('together');
  });

  it('should support chat and embed', () => {
    expect(togetherProvider.capabilities.chat).toBe(true);
    expect(togetherProvider.capabilities.embed).toBe(true);
    expect(togetherProvider.capabilities.streaming).toBe(true);
  });
});
