import { cohereProvider } from '../../src/providers/cohere';

describe('Cohere Provider', () => {
  it('should have correct name', () => {
    expect(cohereProvider.name).toBe('cohere');
  });

  it('should support chat and embed', () => {
    expect(cohereProvider.capabilities.chat).toBe(true);
    expect(cohereProvider.capabilities.embed).toBe(true);
    expect(cohereProvider.capabilities.streaming).toBe(true);
  });
});
