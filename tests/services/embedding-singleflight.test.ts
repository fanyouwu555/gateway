import { getEmbedding } from '../../src/services/embedding';

jest.mock('../../src/providers', () => ({
  createEmbedding: jest.fn().mockImplementation(async () => ({
    data: [{ embedding: [0.1, 0.2, 0.3] }],
  })),
}));

import { createEmbedding } from '../../src/providers';
import { resetEmbeddingCache } from '../../src/services/embedding';

describe('Embedding Singleflight', () => {
  const mockCreateEmbedding = createEmbedding as jest.Mock;

  beforeEach(() => {
    mockCreateEmbedding.mockClear();
    resetEmbeddingCache();
  });

  it('should deduplicate concurrent embedding requests', async () => {
    const promise1 = getEmbedding('hello world');
    const promise2 = getEmbedding('hello world');
    const promise3 = getEmbedding('hello world');

    const [r1, r2, r3] = await Promise.all([promise1, promise2, promise3]);

    expect(r1).toEqual([0.1, 0.2, 0.3]);
    expect(r2).toEqual([0.1, 0.2, 0.3]);
    expect(r3).toEqual([0.1, 0.2, 0.3]);
    expect(mockCreateEmbedding).toHaveBeenCalledTimes(1);
  });

  it('should allow subsequent requests after first resolves', async () => {
    await getEmbedding('another text');
    expect(mockCreateEmbedding).toHaveBeenCalledTimes(1);

    await getEmbedding('another text');
    // Second call should use cache, not createEmbedding
    expect(mockCreateEmbedding).toHaveBeenCalledTimes(1);
  });
});
