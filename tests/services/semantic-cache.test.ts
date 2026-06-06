import { SemanticCacheService, initSemanticCache, getSemanticCache } from '../../src/services/semantic-cache';
import { MemoryVectorStore } from '../../src/stores/vector-memory';
import { resetEmbeddingCache } from '../../src/services/embedding';
import { resetProviderDeps } from '../../src/providers';

const mockGetEmbedding = jest.fn();
jest.mock('../../src/services/embedding', () => {
  const actual = jest.requireActual('../../src/services/embedding');
  return {
    ...actual,
    getEmbedding: (...args: unknown[]) => mockGetEmbedding(...args),
  };
});

describe('SemanticCacheService', () => {
  let service: SemanticCacheService;

  beforeEach(() => {
    mockGetEmbedding.mockReset();
    const store = new MemoryVectorStore({ maxEntries: 100 });
    service = new SemanticCacheService({
      vectorStore: store,
      threshold: 0.85,
      enabled: true,
    });
    initSemanticCache({ enabled: true, threshold: 0.85, backend: 'memory', max_entries: 100 });
  });

  afterEach(() => {
    resetEmbeddingCache();
    resetProviderDeps();
    if (getSemanticCache()) {
      getSemanticCache()!.clear();
    }
  });

  it('should return null when disabled', async () => {
    const disabled = new SemanticCacheService({ enabled: false });
    const result = await disabled.findSimilar({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] } as any, 't1');
    expect(result).toBeNull();
  });

  it('should cache and retrieve by semantic similarity', async () => {
    mockGetEmbedding.mockResolvedValue([1, 0, 0]);

    await service.storeEmbedding(
      { model: 'gpt-4o', messages: [{ role: 'user', content: 'hello world' }] } as any,
      '{"choices":[{"message":{"content":"Hi!"}}]}',
      't1'
    );

    const result = await service.findSimilar(
      { model: 'gpt-4o', messages: [{ role: 'user', content: 'hello world' }] } as any,
      't1'
    );

    expect(result).toBe('{"choices":[{"message":{"content":"Hi!"}}]}');
  });

  it('should skip for stream requests', async () => {
    const result = await service.findSimilar(
      { model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }], stream: true } as any,
      't1'
    );
    expect(result).toBeNull();
  });

  it('should skip for long conversations', async () => {
    const messages = Array.from({ length: 5 }, () => ({ role: 'user', content: 'hi' }));
    const result = await service.findSimilar(
      { model: 'gpt-4o', messages } as any,
      't1'
    );
    expect(result).toBeNull();
  });
});
