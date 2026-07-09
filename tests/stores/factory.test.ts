/**
 * Storage Factory Tests
 */
import {
  StorageFactory,
  initStorageFactory,
  getStorageFactory,
  resetStorageFactory,
  createKVStore,
} from '../../src/stores/factory';
import { MemoryKVStore } from '../../src/stores/memory';

const mockWriteLog = jest.fn();
jest.mock('../../src/utils/logger', () => ({
  writeLog: (...args: unknown[]) => mockWriteLog(...args),
}));

const MockRedisKVStore = jest.fn();
jest.mock('../../src/stores/redis', () => ({
  RedisKVStore: class {
    constructor(client: unknown, prefix: string) {
      MockRedisKVStore({ client, prefix });
    }
  },
}));

jest.mock('../../src/config', () => ({
  getRedisConfig: () => ({ host: 'localhost', port: 6379 }),
}));

jest.mock('ioredis', () => {
  const MockRedis = jest.fn().mockImplementation(() => ({
    status: 'ready',
    on: jest.fn(),
    once: jest.fn(),
    disconnect: jest.fn(),
  }));
  return MockRedis;
});

describe('StorageFactory', () => {
  beforeEach(() => {
    resetStorageFactory();
    MockRedisKVStore.mockClear();
    mockWriteLog.mockClear();
    delete process.env.STORAGE_TYPE;
  });

  describe('createKVStore', () => {
    it('should create MemoryKVStore when type is memory', () => {
      const factory = new StorageFactory({ type: 'memory' });
      const store = factory.createKVStore('test');
      expect(store).toBeInstanceOf(MemoryKVStore);
      expect(store.type).toBe('memory');
    });

    it('should create RedisKVStore when type is redis', () => {
      const factory = new StorageFactory({ type: 'redis' });
      factory.createKVStore('test');
      expect(MockRedisKVStore).toHaveBeenCalledWith(
        expect.objectContaining({ prefix: 'test' })
      );
    });

    it('should fallback to MemoryKVStore for unknown type', () => {
      const factory = new StorageFactory({ type: 'unknown' as 'memory' });
      const store = factory.createKVStore('test');
      expect(store).toBeInstanceOf(MemoryKVStore);
    });
  });

  describe('initStorageFactory', () => {
    it('should create factory with explicit config', () => {
      const factory = initStorageFactory({ type: 'memory' });
      expect(factory).toBeInstanceOf(StorageFactory);
      expect(mockWriteLog).toHaveBeenCalledWith('info', 'Storage initialized', { type: 'memory' });
    });

    it('should create factory with env STORAGE_TYPE', () => {
      process.env.STORAGE_TYPE = 'redis';
      const factory = initStorageFactory();
      expect(factory).toBeInstanceOf(StorageFactory);
      expect(mockWriteLog).toHaveBeenCalledWith('info', 'Storage initialized', { type: 'redis' });
    });

    it('should default to memory when env is not set', () => {
      const factory = initStorageFactory();
      expect(factory).toBeInstanceOf(StorageFactory);
      expect(mockWriteLog).toHaveBeenCalledWith('info', 'Storage initialized', { type: 'memory' });
    });
  });

  describe('getStorageFactory', () => {
    it('should return existing factory', () => {
      const created = initStorageFactory({ type: 'memory' });
      const retrieved = getStorageFactory();
      expect(retrieved).toBe(created);
    });

    it('should auto-initialize when no factory exists', () => {
      const factory = getStorageFactory();
      expect(factory).toBeInstanceOf(StorageFactory);
      expect(mockWriteLog).toHaveBeenCalled();
    });
  });

  describe('resetStorageFactory', () => {
    it('should reset global factory', () => {
      initStorageFactory({ type: 'memory' });
      resetStorageFactory();
      const factory = getStorageFactory();
      expect(mockWriteLog).toHaveBeenCalledTimes(2);
      expect(factory).toBeInstanceOf(StorageFactory);
    });
  });

  describe('createKVStore convenience', () => {
    it('should create MemoryKVStore by default', () => {
      const store = createKVStore('convenience');
      expect(store).toBeInstanceOf(MemoryKVStore);
      expect(store.type).toBe('memory');
    });

    it('should create RedisKVStore when STORAGE_TYPE is redis', () => {
      process.env.STORAGE_TYPE = 'redis';
      createKVStore('redis-test');
      expect(MockRedisKVStore).toHaveBeenCalledWith(
        expect.objectContaining({ prefix: 'redis-test' })
      );
    });
  });
});
