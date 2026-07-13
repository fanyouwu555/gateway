/**
 * Redis 存储实现
 * 生产环境推荐使用 Redis 作为持久化层
 */
import type { Redis } from 'ioredis';
import type { IKVStore, StorageType, Pipeline } from './interface';

/**
 * Redis 配置
 */
export interface RedisConfig {
  host?: string;
  port?: number;
  url?: string;
  password?: string;
  db?: number;
  prefix?: string;
  connectionTimeout?: number;
  maxRetries?: number;
}

/**
 * Redis Key-Value 存储
 */
export class RedisKVStore implements IKVStore {
  type: StorageType = 'redis';
  private client: Redis;
  private prefix: string;
  private connected = false;

  constructor(client: Redis, prefix: string) {
    this.client = client;
    this.prefix = prefix;
  }

  private fullKey(key: string): string {
    return `${this.prefix}:${key}`;
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    // 如果全局 client 已连接则直接使用
    if (this.client.status === 'ready' || this.client.status === 'connect') {
      this.connected = true;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const onReady = () => {
        this.connected = true;
        this.client.removeListener('error', onError);
        resolve();
      };
      const onError = (err: Error) => {
        this.client.removeListener('ready', onReady);
        reject(err);
      };
      this.client.once('ready', onReady);
      this.client.once('error', onError);
      // lazyConnect: true 时需要主动触发连接（避免重复调用）
      if (this.client.status === 'wait') {
        this.client.connect().catch((err: Error) => {
          this.client.removeListener('ready', onReady);
          this.client.removeListener('error', onError);
          reject(err);
        });
      }
    });
  }

  async disconnect(): Promise<void> {
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected;
  }

  async set(key: string, value: string, ttl?: number): Promise<void> {
    const fullKey = this.fullKey(key);
    if (ttl) {
      await this.client.setex(fullKey, Math.floor(ttl / 1000), value);
    } else {
      await this.client.set(fullKey, value);
    }
  }

  async get(key: string): Promise<string | null> {
    const fullKey = this.fullKey(key);
    return this.client.get(fullKey);
  }

  async delete(key: string): Promise<boolean> {
    const fullKey = this.fullKey(key);
    const result = await this.client.del(fullKey);
    return result > 0;
  }

  async expire(key: string, ttl: number): Promise<boolean> {
    const fullKey = this.fullKey(key);
    const result = await this.client.expire(fullKey, Math.floor(ttl / 1000));
    return result === 1;
  }

  async exists(key: string): Promise<boolean> {
    const fullKey = this.fullKey(key);
    const result = await this.client.exists(fullKey);
    return result === 1;
  }

  async incr(key: string): Promise<number> {
    const fullKey = this.fullKey(key);
    return this.client.incr(fullKey);
  }

  async hSet(key: string, field: string, value: string): Promise<void> {
    const fullKey = this.fullKey(key);
    await this.client.hset(fullKey, field, value);
  }

  async hGet(key: string, field: string): Promise<string | null> {
    const fullKey = this.fullKey(key);
    return this.client.hget(fullKey, field);
  }

  async hGetAll(key: string): Promise<Record<string, string>> {
    const fullKey = this.fullKey(key);
    return this.client.hgetall(fullKey);
  }

  async hDel(key: string, ...fields: string[]): Promise<number> {
    const fullKey = this.fullKey(key);
    return this.client.hdel(fullKey, ...fields);
  }

  async lPush(key: string, ...values: string[]): Promise<number> {
    const fullKey = this.fullKey(key);
    return this.client.lpush(fullKey, ...values);
  }

  async lRange(key: string, start: number, stop: number): Promise<string[]> {
    const fullKey = this.fullKey(key);
    return this.client.lrange(fullKey, start, stop);
  }

  async lTrim(key: string, start: number, stop: number): Promise<void> {
    const fullKey = this.fullKey(key);
    await this.client.ltrim(fullKey, start, stop);
  }

  async keys(pattern: string): Promise<string[]> {
    // 使用 SCAN 避免阻塞
    const fullPattern = this.fullKey(pattern);
    const result: string[] = [];
    let cursor = '0';

    do {
      const [newCursor, keys] = await this.client.scan(cursor, 'MATCH', fullPattern, 'COUNT', 100);
      cursor = newCursor;
      for (const key of keys) {
        // 移除前缀
        result.push(key.substring(this.prefix.length + 1));
      }
    } while (cursor !== '0');

    return result;
  }

  async delByPattern(pattern: string): Promise<number> {
    const keys = await this.keys(pattern);
    if (keys.length === 0) return 0;

    return this.client.del(...keys.map((k) => this.fullKey(k)));
  }

  pipeline(): Pipeline {
    const redisPipeline = this.client.pipeline();
    const prefix = this.prefix;
    const fullKey = (key: string) => `${prefix}:${key}`;

    return {
      set(key: string, value: string, ttl?: number) {
        const fk = fullKey(key);
        if (ttl) {
          redisPipeline.setex(fk, Math.floor(ttl / 1000), value);
        } else {
          redisPipeline.set(fk, value);
        }
        return this;
      },
      get(key: string) {
        redisPipeline.get(fullKey(key));
        return this;
      },
      delete(key: string) {
        redisPipeline.del(fullKey(key));
        return this;
      },
      expire(key: string, ttl: number) {
        redisPipeline.expire(fullKey(key), Math.floor(ttl / 1000));
        return this;
      },
      exists(key: string) {
        redisPipeline.exists(fullKey(key));
        return this;
      },
      incr(key: string) {
        redisPipeline.incr(fullKey(key));
        return this;
      },
      hSet(key: string, field: string, value: string) {
        redisPipeline.hset(fullKey(key), field, value);
        return this;
      },
      hGet(key: string, field: string) {
        redisPipeline.hget(fullKey(key), field);
        return this;
      },
      hGetAll(key: string) {
        redisPipeline.hgetall(fullKey(key));
        return this;
      },
      hDel(key: string, ...fields: string[]) {
        redisPipeline.hdel(fullKey(key), ...fields);
        return this;
      },
      lPush(key: string, ...values: string[]) {
        redisPipeline.lpush(fullKey(key), ...values);
        return this;
      },
      lRange(key: string, start: number, stop: number) {
        redisPipeline.lrange(fullKey(key), start, stop);
        return this;
      },
      lTrim(key: string, start: number, stop: number) {
        redisPipeline.ltrim(fullKey(key), start, stop);
        return this;
      },
      keys(pattern: string) {
        // keys 不适合 pipeline，但保持接口一致
        redisPipeline.keys(fullKey(pattern));
        return this;
      },
      delByPattern(pattern: string) {
        // delByPattern 不适合 pipeline，但保持接口一致
        redisPipeline.keys(fullKey(pattern));
        return this;
      },
      async exec(): Promise<unknown[]> {
        const results = await redisPipeline.exec();
        return (results || []).map((r) => (r as unknown[])[1]);
      },
    };
  }
}

// 从环境变量创建 Redis 配置
export function createRedisConfigFromEnv(): RedisConfig | null {
  const redisUrl = process.env.REDIS_URL;
  if (redisUrl) {
    return { url: redisUrl };
  }

  const host = process.env.REDIS_HOST;
  if (!host) {
    return null;
  }

  return {
    host,
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
    password: process.env.REDIS_PASSWORD,
    db: parseInt(process.env.REDIS_DB || '0', 10),
    prefix: process.env.REDIS_PREFIX || 'gateway',
    maxRetries: parseInt(process.env.REDIS_MAX_RETRIES || '3', 10),
  };
}
