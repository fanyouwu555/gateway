/**
 * Redis Vector Store Tests
 * Uses jest mock to simulate ioredis (same pattern as redis.test.ts)
 */
jest.mock('ioredis', () => {
  const mockHset = jest.fn().mockResolvedValue(1);
  const mockHgetall = jest.fn().mockResolvedValue({});
  const mockHdel = jest.fn().mockResolvedValue(1);
  const mockHlen = jest.fn().mockResolvedValue(0);

  const MockRedis = jest.fn().mockImplementation(() => ({
    on: jest.fn(),
    connect: jest.fn().mockResolvedValue(undefined),
    quit: jest.fn().mockResolvedValue(undefined),
    hset: mockHset,
    hgetall: mockHgetall,
    hdel: mockHdel,
    hlen: mockHlen,
    del: jest.fn().mockResolvedValue(1),
  }));

  return Object.assign(MockRedis, {
    _mockHset: mockHset,
    _mockHgetall: mockHgetall,
    _mockHdel: mockHdel,
    _mockHlen: mockHlen,
  });
});

import { RedisVectorStore } from '../../src/stores/redis-vector';
import type Redis from 'ioredis';

const getMockRedis = (store: RedisVectorStore): jest.Mocked<Redis> => {
  const client = (store as unknown as { redis: Redis }).redis;
  return client as unknown as jest.Mocked<Redis>;
};

describe('RedisVectorStore', () => {
  let store: RedisVectorStore;
  let mockRedis: jest.Mocked<Redis>;

  beforeEach(async () => {
    store = new RedisVectorStore({ prefix: 'test:vector', maxEntries: 100 });
    await store.connect();
    mockRedis = getMockRedis(store);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('connect', () => {
    it('should connect to Redis', () => {
      expect(mockRedis.connect).toHaveBeenCalled();
    });
  });

  describe('insert and search', () => {
    it('should insert a vector and find it by similarity', async () => {
      const entryId = 'id1';
      const vector = [1, 0, 0];
      const metadata = { namespace: 'ns1', response: 'hello' };

      // Insert succeeds
      mockRedis.hset.mockResolvedValueOnce(1);
      // Search returns the inserted entry
      mockRedis.hgetall.mockResolvedValueOnce({
        [entryId]: JSON.stringify({ id: entryId, vector, metadata, insertedAt: Date.now() }),
      });

      await store.insert(entryId, vector, metadata);
      const results = await store.search([1, 0, 0], 1, 0.9, 'ns1');

      expect(results).toHaveLength(1);
      expect(results[0].id).toBe(entryId);
      expect(results[0].score).toBeGreaterThan(0.99);
    });

    it('should only return results above threshold', async () => {
      const entryId = 'id1';
      const vector = [1, 0, 0];
      const metadata = { namespace: 'ns1', response: 'hello' };

      mockRedis.hgetall.mockResolvedValueOnce({
        [entryId]: JSON.stringify({ id: entryId, vector, metadata, insertedAt: Date.now() }),
      });

      const results = await store.search([0, 1, 0], 1, 0.9, 'ns1');
      expect(results).toHaveLength(0);
    });

    it('should filter by namespace', async () => {
      const id1 = 'id1';
      const id2 = 'id2';

      mockRedis.hgetall.mockResolvedValueOnce({
        [id1]: JSON.stringify({ id: id1, vector: [1, 0, 0], metadata: { namespace: 'ns1', response: 'hello' }, insertedAt: Date.now() }),
        [id2]: JSON.stringify({ id: id2, vector: [1, 0, 0], metadata: { namespace: 'ns2', response: 'world' }, insertedAt: Date.now() }),
      });

      const results = await store.search([1, 0, 0], 10, 0.5, 'ns1');
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe(id1);
    });
  });

  describe('delete', () => {
    it('should delete an entry', async () => {
      mockRedis.hdel.mockResolvedValueOnce(1);
      await store.delete('id1');
      expect(mockRedis.hdel).toHaveBeenCalledWith('test:vector:entries', 'id1');
    });
  });

  describe('max entries enforcement', () => {
    it('should evict oldest entry when max reached', async () => {
      // hlen returns 100 (at limit of store.maxEntries=100), triggers eviction
      mockRedis.hlen.mockResolvedValueOnce(100);
      // hgetall returns two entries
      mockRedis.hgetall.mockResolvedValueOnce({
        id1: JSON.stringify({ id: 'id1', vector: [1, 0, 0], metadata: { namespace: 'ns1' }, insertedAt: 1000 }),
        id2: JSON.stringify({ id: 'id2', vector: [0, 1, 0], metadata: { namespace: 'ns1' }, insertedAt: 2000 }),
      });
      // hdel succeeds
      mockRedis.hdel.mockResolvedValueOnce(1);
      // hset succeeds
      mockRedis.hset.mockResolvedValueOnce(1);

      await store.insert('id3', [0, 0, 1], { namespace: 'ns1' });

      // Verify hdel was called to evict oldest entry
      expect(mockRedis.hdel).toHaveBeenCalled();
      const hdelCalls = mockRedis.hdel.mock.calls;
      expect(hdelCalls.length).toBeGreaterThan(0);
      expect(hdelCalls[hdelCalls.length - 1]).toEqual(['test:vector:entries', 'id1']);
    });
  });

  describe('clear', () => {
    it('should delete the hash key', () => {
      store.clear();
      // del is async but clear() is sync — it fires and forgets
      expect(mockRedis.del).toHaveBeenCalledWith('test:vector:entries');
    });
  });
});
