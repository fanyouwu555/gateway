/**
 * Redis 存储实现
 * 生产环境推荐使用 Redis 作为持久化层
 */
import Redis, { type RedisOptions } from 'ioredis';
import type { IKVStore, StorageType } from './interface';
import { writeLog } from '../utils/logger';

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
  private client: Redis | null = null;
  private prefix: string;
  private config: RedisConfig;
  private connected = false;

  constructor(config: RedisConfig) {
    this.config = config;
    this.prefix = config.prefix || 'gateway';
  }

  private fullKey(key: string): string {
    return `${this.prefix}:${key}`;
  }

  async connect(): Promise<void> {
    if (this.client && this.connected) return;

    // 如果之前有未成功连接的 client，清理后重试
    if (this.client && !this.connected) {
      try {
        await this.client.disconnect();
      } catch {
        // 忽略断开错误
      }
      this.client = null;
    }

    if (this.client) return;

    const options: RedisOptions = {
      host: this.config.host || 'localhost',
      port: this.config.port || 6379,
      password: this.config.password,
      db: this.config.db || 0,
      retryStrategy: (times: number) => {
        if (times > (this.config.maxRetries || 3)) {
          return null; // 停止重试
        }
        return Math.min(times * 200, 2000);
      },
      connectTimeout: this.config.connectionTimeout || 10000,
      lazyConnect: true,
    };

    // 如果提供 URL，优先使用 URL
    if (this.config.url) {
      this.client = new Redis(this.config.url, options);
    } else {
      this.client = new Redis(options);
    }

    this.client.on('error', (err) => {
      writeLog('error', 'Redis connection error', { error: err.message, prefix: this.prefix });
      this.connected = false;
    });

    this.client.on('connect', () => {
      writeLog('info', 'Redis connected', { prefix: this.prefix });
      this.connected = true;
    });

    try {
      await this.client.connect();
      this.connected = true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      writeLog('error', 'Redis initial connection failed — falling back to in-memory', {
        error: msg,
        prefix: this.prefix,
        host: this.config.host || 'localhost',
        port: this.config.port || 6379,
      });
      throw err;
    }
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      await this.client.quit();
      this.client = null;
      this.connected = false;
    }
  }

  isConnected(): boolean {
    return this.connected && this.client !== null;
  }

  async set(key: string, value: string, ttl?: number): Promise<void> {
    if (!this.client) throw new Error('Redis not connected');
    const fullKey = this.fullKey(key);
    if (ttl) {
      await this.client.setex(fullKey, Math.floor(ttl / 1000), value);
    } else {
      await this.client.set(fullKey, value);
    }
  }

  async get(key: string): Promise<string | null> {
    if (!this.client) throw new Error('Redis not connected');
    const fullKey = this.fullKey(key);
    return this.client.get(fullKey);
  }

  async delete(key: string): Promise<boolean> {
    if (!this.client) throw new Error('Redis not connected');
    const fullKey = this.fullKey(key);
    const result = await this.client.del(fullKey);
    return result > 0;
  }

  async expire(key: string, ttl: number): Promise<boolean> {
    if (!this.client) throw new Error('Redis not connected');
    const fullKey = this.fullKey(key);
    const result = await this.client.expire(fullKey, Math.floor(ttl / 1000));
    return result === 1;
  }

  async exists(key: string): Promise<boolean> {
    if (!this.client) throw new Error('Redis not connected');
    const fullKey = this.fullKey(key);
    const result = await this.client.exists(fullKey);
    return result === 1;
  }

  async incr(key: string): Promise<number> {
    if (!this.client) throw new Error('Redis not connected');
    const fullKey = this.fullKey(key);
    return this.client.incr(fullKey);
  }

  async hSet(key: string, field: string, value: string): Promise<void> {
    if (!this.client) throw new Error('Redis not connected');
    const fullKey = this.fullKey(key);
    await this.client.hset(fullKey, field, value);
  }

  async hGet(key: string, field: string): Promise<string | null> {
    if (!this.client) throw new Error('Redis not connected');
    const fullKey = this.fullKey(key);
    return this.client.hget(fullKey, field);
  }

  async hGetAll(key: string): Promise<Record<string, string>> {
    if (!this.client) throw new Error('Redis not connected');
    const fullKey = this.fullKey(key);
    return this.client.hgetall(fullKey);
  }

  async hDel(key: string, ...fields: string[]): Promise<number> {
    if (!this.client) throw new Error('Redis not connected');
    const fullKey = this.fullKey(key);
    return this.client.hdel(fullKey, ...fields);
  }

  async lPush(key: string, ...values: string[]): Promise<number> {
    if (!this.client) throw new Error('Redis not connected');
    const fullKey = this.fullKey(key);
    return this.client.lpush(fullKey, ...values);
  }

  async lRange(key: string, start: number, stop: number): Promise<string[]> {
    if (!this.client) throw new Error('Redis not connected');
    const fullKey = this.fullKey(key);
    return this.client.lrange(fullKey, start, stop);
  }

  async lTrim(key: string, start: number, stop: number): Promise<void> {
    if (!this.client) throw new Error('Redis not connected');
    const fullKey = this.fullKey(key);
    await this.client.ltrim(fullKey, start, stop);
  }

  async keys(pattern: string): Promise<string[]> {
    if (!this.client) throw new Error('Redis not connected');
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

    if (!this.client) throw new Error('Redis not connected');
    return this.client.del(...keys.map((k) => this.fullKey(k)));
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