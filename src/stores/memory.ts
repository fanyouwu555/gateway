/**
 * 内存存储实现
 * 作为 Redis 不可用时的降级方案
 */
import type { IKVStore, StorageType } from './interface';

interface CacheEntry {
  value: string;
  expireAt?: number;
}

interface HashEntry {
  [field: string]: string;
}

interface ListEntry {
  head: string[];
  tail: string[];
}

/**
 * 内存 Key-Value 存储
 */
export class MemoryKVStore implements IKVStore {
  type: StorageType = 'memory';
  private cache = new Map<string, CacheEntry>();
  private hashes = new Map<string, HashEntry>();
  private lists = new Map<string, ListEntry>();
  private counters = new Map<string, number>();
  private prefix: string;

  constructor(prefix: string = '') {
    this.prefix = prefix;
  }

  private fullKey(key: string): string {
    return `${this.prefix}:${key}`;
  }

  async connect(): Promise<void> {
    // 内存存储无需连接
  }

  async disconnect(): Promise<void> {
    this.cache.clear();
    this.hashes.clear();
    this.lists.clear();
    this.counters.clear();
  }

  isConnected(): boolean {
    return true;
  }

  async set(key: string, value: string, ttl?: number): Promise<void> {
    const fullKey = this.fullKey(key);
    const entry: CacheEntry = {
      value,
      expireAt: ttl ? Date.now() + ttl : undefined,
    };
    this.cache.set(fullKey, entry);
  }

  async get(key: string): Promise<string | null> {
    const fullKey = this.fullKey(key);
    const entry = this.cache.get(fullKey);

    if (!entry) return null;

    // 检查过期
    if (entry.expireAt && Date.now() > entry.expireAt) {
      this.cache.delete(fullKey);
      return null;
    }

    return entry.value;
  }

  async delete(key: string): Promise<boolean> {
    const fullKey = this.fullKey(key);
    return this.cache.delete(fullKey);
  }

  async expire(key: string, ttl: number): Promise<boolean> {
    const fullKey = this.fullKey(key);
    const entry = this.cache.get(fullKey);

    if (!entry) return false;

    entry.expireAt = Date.now() + ttl;
    return true;
  }

  async exists(key: string): Promise<boolean> {
    const fullKey = this.fullKey(key);
    const entry = this.cache.get(fullKey);

    if (!entry) return false;

    if (entry.expireAt && Date.now() > entry.expireAt) {
      this.cache.delete(fullKey);
      return false;
    }

    return true;
  }

  async incr(key: string): Promise<number> {
    const fullKey = this.fullKey(key);
    const current = this.counters.get(fullKey) || 0;
    const next = current + 1;
    this.counters.set(fullKey, next);
    return next;
  }

  async hSet(key: string, field: string, value: string): Promise<void> {
    const fullKey = this.fullKey(key);
    let hash = this.hashes.get(fullKey);
    if (!hash) {
      hash = {};
      this.hashes.set(fullKey, hash);
    }
    hash[field] = value;
  }

  async hGet(key: string, field: string): Promise<string | null> {
    const fullKey = this.fullKey(key);
    const hash = this.hashes.get(fullKey);
    return hash?.[field] ?? null;
  }

  async hGetAll(key: string): Promise<Record<string, string>> {
    const fullKey = this.fullKey(key);
    const hash = this.hashes.get(fullKey);
    return hash ? { ...hash } : {};
  }

  async hDel(key: string, ...fields: string[]): Promise<number> {
    const fullKey = this.fullKey(key);
    const hash = this.hashes.get(fullKey);
    if (!hash) return 0;

    let deleted = 0;
    for (const field of fields) {
      if (field in hash) {
        delete hash[field];
        deleted++;
      }
    }

    return deleted;
  }

  async lPush(key: string, ...values: string[]): Promise<number> {
    const fullKey = this.fullKey(key);
    let list = this.lists.get(fullKey);
    if (!list) {
      list = { head: [], tail: [] };
      this.lists.set(fullKey, list);
    }

    list.head = [...values.reverse(), ...list.head];
    return list.head.length + list.tail.length;
  }

  async lRange(key: string, start: number, stop: number): Promise<string[]> {
    const fullKey = this.fullKey(key);
    const list = this.lists.get(fullKey);
    if (!list) return [];

    const combined = [...list.head, ...list.tail];
    const len = combined.length;

    // 标准化索引
    const startIndex = start < 0 ? len + start : start;
    const stopIndex = stop < 0 ? len + stop : stop;

    // 裁剪范围
    if (startIndex >= len || stopIndex < 0) return [];
    const startIdx = Math.max(0, startIndex);
    const stopIdx = Math.min(len - 1, stopIndex);

    return combined.slice(startIdx, stopIdx + 1);
  }

  async lTrim(key: string, start: number, stop: number): Promise<void> {
    const fullKey = this.fullKey(key);
    const list = this.lists.get(fullKey);
    if (!list) return;

    const combined = [...list.head, ...list.tail];
    const len = combined.length;

    const startIndex = start < 0 ? len + start : start;
    const stopIndex = stop < 0 ? len + stop : stop;

    if (startIndex >= len || stopIndex < 0) {
      this.lists.delete(fullKey);
      return;
    }

    const startIdx = Math.max(0, startIndex);
    const stopIdx = Math.min(len - 1, stopIndex);
    const keep = combined.slice(startIdx, stopIdx + 1);

    // 分成 head 和 tail
    list.head = keep.slice(0, 100); // 简单分割
    list.tail = keep.slice(100);
  }

  async keys(pattern: string): Promise<string[]> {
    const regex = new RegExp('^' + this.prefix + ':' + pattern.replace('*', '.*'));
    const result: string[] = [];

    for (const key of this.cache.keys()) {
      if (regex.test(key)) {
        result.push(key.substring(this.prefix.length + 1));
      }
    }

    return result;
  }

  async delByPattern(pattern: string): Promise<number> {
    const regex = new RegExp('^' + this.prefix + ':' + pattern.replace('*', '.*'));
    let count = 0;

    for (const key of this.cache.keys()) {
      if (regex.test(key)) {
        this.cache.delete(key);
        count++;
      }
    }

    for (const key of this.hashes.keys()) {
      if (regex.test(key)) {
        this.hashes.delete(key);
        count++;
      }
    }

    for (const key of this.lists.keys()) {
      if (regex.test(key)) {
        this.lists.delete(key);
        count++;
      }
    }

    for (const key of this.counters.keys()) {
      if (regex.test(key)) {
        this.counters.delete(key);
        count++;
      }
    }

    return count;
  }
}

/**
 * 内存存储工厂
 */
export class MemoryStorageFactory {
  createKVStore(prefix: string): IKVStore {
    return new MemoryKVStore(prefix);
  }
}

export const memoryStorageFactory = new MemoryStorageFactory();