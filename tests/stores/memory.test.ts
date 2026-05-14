/**
 * 内存存储测试
 */
import { MemoryKVStore } from '../../src/../src/stores/memory';

describe('MemoryKVStore', () => {
  let store: MemoryKVStore;

  beforeEach(() => {
    store = new MemoryKVStore('test');
  });

  describe('connect/disconnect', () => {
    it('should connect without error', async () => {
      await store.connect();
      expect(store.isConnected()).toBe(true);
    });

    it('should disconnect and clear data', async () => {
      await store.set('key', 'value');
      await store.disconnect();
      // Memory store remains connected but data is cleared
      expect(await store.get('key')).toBeNull();
    });
  });

  describe('set/get', () => {
    it('should set and get string value', async () => {
      await store.set('key', 'value');
      const result = await store.get('key');
      expect(result).toBe('value');
    });

    it('should return null for non-existent key', async () => {
      const result = await store.get('nonexistent');
      expect(result).toBeNull();
    });

    it('should set with TTL', async () => {
      await store.set('key', 'value', 100);
      const result = await store.get('key');
      expect(result).toBe('value');
    });
  });

  describe('delete', () => {
    it('should delete existing key', async () => {
      await store.set('key', 'value');
      const deleted = await store.delete('key');
      expect(deleted).toBe(true);
      expect(await store.get('key')).toBeNull();
    });

    it('should return false for non-existent key', async () => {
      const deleted = await store.delete('nonexistent');
      expect(deleted).toBe(false);
    });
  });

  describe('exists', () => {
    it('should return true for existing key', async () => {
      await store.set('key', 'value');
      const exists = await store.exists('key');
      expect(exists).toBe(true);
    });

    it('should return false for non-existent key', async () => {
      const exists = await store.exists('nonexistent');
      expect(exists).toBe(false);
    });
  });

  describe('incr', () => {
    it('should increment counter', async () => {
      const first = await store.incr('counter');
      const second = await store.incr('counter');
      expect(second).toBe(first + 1);
    });
  });

  describe('hSet/hGet/hGetAll', () => {
    it('should set and get hash field', async () => {
      await store.hSet('hash', 'field', 'value');
      const result = await store.hGet('hash', 'field');
      expect(result).toBe('value');
    });

    it('should get all hash fields', async () => {
      await store.hSet('hash', 'field1', 'value1');
      await store.hSet('hash', 'field2', 'value2');
      const result = await store.hGetAll('hash');
      expect(result.field1).toBe('value1');
      expect(result.field2).toBe('value2');
    });

    it('should delete hash fields', async () => {
      await store.hSet('hash', 'field', 'value');
      const deleted = await store.hDel('hash', 'field');
      expect(deleted).toBe(1);
    });
  });

  describe('lPush/lRange', () => {
    it('should push and get list values', async () => {
      await store.lPush('list', 'a', 'b', 'c');
      const result = await store.lRange('list', 0, -1);
      expect(result).toContain('c');
      expect(result).toContain('b');
      expect(result).toContain('a');
    });

    it('should trim list', async () => {
      await store.lPush('list', 'a', 'b', 'c', 'd', 'e');
      await store.lTrim('list', 0, 2);
      const result = await store.lRange('list', 0, -1);
      expect(result.length).toBeLessThanOrEqual(3);
    });
  });

  describe('keys', () => {
    it('should return keys matching pattern', async () => {
      await store.set('key1', 'value1');
      await store.set('key2', 'value2');
      await store.set('otherkey', 'value3');
      const result = await store.keys('key*');
      // Keys are returned without prefix
      expect(result).toContain('key1');
      expect(result).toContain('key2');
      expect(result).not.toContain('otherkey');
    });
  });

  describe('delByPattern', () => {
    it('should delete keys matching pattern', async () => {
      await store.set('test:key1', 'value1');
      await store.set('test:key2', 'value2');
      await store.set('other:key', 'value3');
      const count = await store.delByPattern('test:*');
      expect(count).toBe(2);
    });
  });
});