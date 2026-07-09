/**
 * Redis 存储测试
 * 测试 RedisKVStore 的 KV/哈希/列表操作
 * 使用 jest mock 模拟 ioredis
 */
const mockRedisMethods = {
  on: jest.fn(),
  once: jest.fn(),
  connect: jest.fn().mockResolvedValue(undefined),
  quit: jest.fn().mockResolvedValue(undefined),
  disconnect: jest.fn(),
  set: jest.fn().mockResolvedValue('OK'),
  setex: jest.fn().mockResolvedValue('OK'),
  get: jest.fn().mockResolvedValue(null),
  del: jest.fn().mockResolvedValue(1),
  expire: jest.fn().mockResolvedValue(1),
  exists: jest.fn().mockResolvedValue(0),
  incr: jest.fn().mockResolvedValue(1),
  hset: jest.fn().mockResolvedValue(1),
  hget: jest.fn().mockResolvedValue(null),
  hgetall: jest.fn().mockResolvedValue({}),
  hdel: jest.fn().mockResolvedValue(1),
  lpush: jest.fn().mockResolvedValue(1),
  lrange: jest.fn().mockResolvedValue([]),
  ltrim: jest.fn().mockResolvedValue('OK'),
  scan: jest.fn().mockResolvedValue(['0', []]),
  keys: jest.fn().mockResolvedValue([]),
  removeListener: jest.fn(),
  status: 'ready',
};

jest.mock('ioredis', () => {
  const MockRedis = jest.fn().mockImplementation(() => mockRedisMethods);
  return MockRedis;
});

import { RedisKVStore } from '../src/stores/redis';
import type Redis from 'ioredis';

describe('RedisKVStore', () => {
  let store: RedisKVStore;
  let mockRedis: jest.Mocked<Redis>;

  beforeEach(async () => {
    mockRedis = { ...mockRedisMethods } as unknown as jest.Mocked<Redis>;
    store = new RedisKVStore(mockRedis as unknown as Redis, 'test');
    await store.connect();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('connect/disconnect', () => {
    it('should connect to Redis', async () => {
      expect(store.isConnected()).toBe(true);
    });

    it('should mark as disconnected without closing shared client', async () => {
      await store.disconnect();
      expect(store.isConnected()).toBe(false);
      expect(mockRedis.quit).not.toHaveBeenCalled();
    });

    it('should resolve immediately if client is already ready', async () => {
      mockRedis.status = 'ready';
      const s = new RedisKVStore(mockRedis as unknown as Redis, 'test2');
      await s.connect();
      expect(s.isConnected()).toBe(true);
    });

    it('should wait for ready event when client is not ready', async () => {
      mockRedis.status = 'connecting';
      const s = new RedisKVStore(mockRedis as unknown as Redis, 'test3');
      const promise = s.connect();
      // simulate ready event
      const readyHandler = mockRedis.once.mock.calls.find((c) => c[0] === 'ready')?.[1];
      if (readyHandler) {
        readyHandler();
      }
      await promise;
      expect(s.isConnected()).toBe(true);
    });
  });

  describe('set/get', () => {
    it('should set a value without TTL', async () => {
      mockRedis.set.mockResolvedValue('OK');
      await store.set('mykey', 'myvalue');
      expect(mockRedis.set).toHaveBeenCalledWith('test:mykey', 'myvalue');
    });

    it('should set a value with TTL', async () => {
      mockRedis.setex.mockResolvedValue('OK');
      await store.set('mykey', 'myvalue', 60000);
      expect(mockRedis.setex).toHaveBeenCalledWith('test:mykey', 60, 'myvalue');
    });

    it('should get a value', async () => {
      mockRedis.get.mockResolvedValue('stored-value');
      const result = await store.get('mykey');
      expect(result).toBe('stored-value');
      expect(mockRedis.get).toHaveBeenCalledWith('test:mykey');
    });

    it('should return null for missing key', async () => {
      mockRedis.get.mockResolvedValue(null);
      const result = await store.get('nonexistent');
      expect(result).toBeNull();
    });
  });

  describe('delete', () => {
    it('should delete an existing key', async () => {
      mockRedis.del.mockResolvedValue(1);
      const result = await store.delete('mykey');
      expect(result).toBe(true);
    });

    it('should return false for non-existent key', async () => {
      mockRedis.del.mockResolvedValue(0);
      const result = await store.delete('nonexistent');
      expect(result).toBe(false);
    });
  });

  describe('expire', () => {
    it('should set TTL on key', async () => {
      mockRedis.expire.mockResolvedValue(1);
      const result = await store.expire('mykey', 10000);
      expect(result).toBe(true);
      expect(mockRedis.expire).toHaveBeenCalledWith('test:mykey', 10);
    });
  });

  describe('exists', () => {
    it('should return true for existing key', async () => {
      mockRedis.exists.mockResolvedValue(1);
      const result = await store.exists('mykey');
      expect(result).toBe(true);
    });

    it('should return false for non-existent key', async () => {
      mockRedis.exists.mockResolvedValue(0);
      const result = await store.exists('nonexistent');
      expect(result).toBe(false);
    });
  });

  describe('incr', () => {
    it('should increment a counter', async () => {
      mockRedis.incr.mockResolvedValue(5);
      const result = await store.incr('counter');
      expect(result).toBe(5);
      expect(mockRedis.incr).toHaveBeenCalledWith('test:counter');
    });
  });

  describe('hash operations', () => {
    it('should set a hash field', async () => {
      mockRedis.hset.mockResolvedValue(1);
      await store.hSet('hash', 'field', 'value');
      expect(mockRedis.hset).toHaveBeenCalledWith('test:hash', 'field', 'value');
    });

    it('should get a hash field', async () => {
      mockRedis.hget.mockResolvedValue('stored-value');
      const result = await store.hGet('hash', 'field');
      expect(result).toBe('stored-value');
    });

    it('should get all hash fields', async () => {
      mockRedis.hgetall.mockResolvedValue({ field1: 'val1', field2: 'val2' });
      const result = await store.hGetAll('hash');
      expect(result).toEqual({ field1: 'val1', field2: 'val2' });
    });
  });

  describe('list operations', () => {
    it('should push to a list', async () => {
      mockRedis.lpush.mockResolvedValue(3);
      const result = await store.lPush('list', 'a', 'b', 'c');
      expect(result).toBe(3);
      expect(mockRedis.lpush).toHaveBeenCalledWith('test:list', 'a', 'b', 'c');
    });

    it('should get a range from list', async () => {
      mockRedis.lrange.mockResolvedValue(['a', 'b', 'c']);
      const result = await store.lRange('list', 0, -1);
      expect(result).toEqual(['a', 'b', 'c']);
    });

    it('should trim a list', async () => {
      mockRedis.ltrim.mockResolvedValue('OK');
      await store.lTrim('list', 0, 100);
      expect(mockRedis.ltrim).toHaveBeenCalledWith('test:list', 0, 100);
    });
  });

  describe('key pattern operations', () => {
    it('should get keys by pattern', async () => {
      // store.keys() uses SCAN internally, then strips the prefix
      mockRedis.scan.mockResolvedValue(['0', ['test:k1', 'test:k2']]);
      const result = await store.keys('k*');
      expect(result).toEqual(['k1', 'k2']);
    });
  });
});
