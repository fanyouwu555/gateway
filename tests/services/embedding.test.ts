import { resetProviderDeps } from '../../src/providers';

const mockCreateEmbedding = jest.fn();
jest.mock('../../src/providers', () => {
  const actual = jest.requireActual('../../src/providers');
  return {
    ...actual,
    createEmbedding: (...args: unknown[]) => mockCreateEmbedding(...args),
  };
});

describe('getEmbedding', () => {
  afterEach(() => {
    mockCreateEmbedding.mockClear();
    resetProviderDeps();
    delete process.env.EMBEDDING_ENABLED;
    jest.resetModules();
  });

  it('should return cached embedding on second call', async () => {
    const { getEmbedding, resetEmbeddingCache } = await import('../../src/services/embedding');
    mockCreateEmbedding.mockResolvedValue({
      data: [{ embedding: [0.1, 0.2, 0.3] }],
    });

    const v1 = await getEmbedding('hello world');
    const v2 = await getEmbedding('hello world');

    expect(v1).toEqual([0.1, 0.2, 0.3]);
    expect(v2).toEqual([0.1, 0.2, 0.3]);
    expect(mockCreateEmbedding).toHaveBeenCalledTimes(1);

    resetEmbeddingCache();
  });

  it('should hash long text for cache key', async () => {
    const { getEmbedding, resetEmbeddingCache } = await import('../../src/services/embedding');
    const text = 'a'.repeat(10000);
    mockCreateEmbedding.mockResolvedValue({
      data: [{ embedding: [0.1] }],
    });

    await getEmbedding(text);
    expect(mockCreateEmbedding).toHaveBeenCalledTimes(1);

    resetEmbeddingCache();
  });

  it('should skip if disabled', async () => {
    process.env.EMBEDDING_ENABLED = 'false';
    const { getEmbedding } = await import('../../src/services/embedding');
    const result = await getEmbedding('hello');
    expect(result).toBeNull();
  });
});
