import { MemoryVectorStore } from '../../src/stores/vector-memory';

describe('MemoryVectorStore', () => {
  let store: MemoryVectorStore;

  beforeEach(() => {
    store = new MemoryVectorStore({ maxEntries: 100 });
  });

  afterEach(() => {
    store.clear();
  });

  it('should insert and search vectors', async () => {
    const v1 = [1, 0, 0];
    const v2 = [0.9, 0.1, 0];
    await store.insert('id1', v1, { namespace: 'ns1', model: 'gpt-4o' });
    await store.insert('id2', [0, 1, 0], { namespace: 'ns1', model: 'gpt-4o' });

    const results = await store.search(v2, 1, 0.85, 'ns1');
    expect(results.length).toBe(1);
    expect(results[0].id).toBe('id1');
    expect(results[0].score).toBeGreaterThan(0.85);
  });

  it('should respect namespace isolation', async () => {
    await store.insert('id1', [1, 0, 0], { namespace: 'nsA' });
    const results = await store.search([1, 0, 0], 1, 0.5, 'nsB');
    expect(results.length).toBe(0);
  });

  it('should evict oldest when maxEntries exceeded', async () => {
    const smallStore = new MemoryVectorStore({ maxEntries: 2 });
    await smallStore.insert('a', [1, 0, 0], { namespace: 'ns' });
    await smallStore.insert('b', [0, 1, 0], { namespace: 'ns' });
    await smallStore.insert('c', [0, 0, 1], { namespace: 'ns' });

    const results = await smallStore.search([1, 0, 0], 1, 0.5, 'ns');
    expect(results.length).toBe(0); // 'a' evicted
  });

  it('should delete by id', async () => {
    await store.insert('id1', [1, 0, 0], { namespace: 'ns1' });
    await store.delete('id1');
    const results = await store.search([1, 0, 0], 1, 0.5, 'ns1');
    expect(results.length).toBe(0);
  });

  it('should return correct count', async () => {
    expect(store.count()).toBe(0);
    await store.insert('id1', [1, 0, 0], { namespace: 'ns1' });
    expect(store.count()).toBe(1);
  });
});
