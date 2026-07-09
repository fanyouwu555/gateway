/**
 * 存储工厂 - 创建 Memory 或 Redis 存储
 */
import Redis from 'ioredis';
import type { IKVStore, StorageType } from './interface';
import { MemoryKVStore } from './memory';
import { RedisKVStore } from './redis';
import { getRedisConfig } from '../config';
import { writeLog } from '../utils/logger';

/**
 * 存储配置
 */
export interface StorageConfig {
  type: StorageType;
}

let globalRedisClient: Redis | null = null;

function getSharedRedisClient(): Redis {
  if (!globalRedisClient) {
    const cfg = getRedisConfig();
    if (cfg.url) {
      globalRedisClient = new Redis(cfg.url, {
        db: cfg.db,
        retryStrategy: (times) => Math.min(times * 200, 2000),
        lazyConnect: true,
      });
    } else {
      globalRedisClient = new Redis({
        host: cfg.host,
        port: cfg.port,
        password: cfg.password,
        db: cfg.db,
        retryStrategy: (times) => Math.min(times * 200, 2000),
        lazyConnect: true,
      });
    }
    globalRedisClient.on('error', (err) => writeLog('error', 'Redis shared client error', { error: err.message }));
  }
  return globalRedisClient;
}

export function resetSharedRedisClient(): void {
  if (globalRedisClient) {
    globalRedisClient.disconnect();
    globalRedisClient = null;
  }
}

function shouldUseRedis(): boolean {
  return (process.env.STORAGE_TYPE as StorageType) === 'redis';
}

/**
 * 存储工厂实现
 */
export class StorageFactory {
  private config: StorageConfig;

  constructor(config: StorageConfig) {
    this.config = config;
  }

  createKVStore(prefix: string): IKVStore {
    if (this.config.type === 'redis') {
      const client = getSharedRedisClient();
      return new RedisKVStore(client, prefix);
    }

    // 默认使用内存
    return new MemoryKVStore(prefix);
  }
}

// 全局存储实例
let globalFactory: StorageFactory | null = null;

/**
 * 初始化存储工厂
 */
export function initStorageFactory(config?: StorageConfig): StorageFactory {
  // 默认配置 - 从环境变量判断
  const defaultConfig: StorageConfig = config || {
    type: (process.env.STORAGE_TYPE as StorageType) || 'memory',
  };

  globalFactory = new StorageFactory(defaultConfig);
  writeLog('info', 'Storage initialized', { type: defaultConfig.type });
  return globalFactory;
}

/**
 * 获取存储工厂
 */
export function getStorageFactory(): StorageFactory {
  if (!globalFactory) {
    globalFactory = initStorageFactory();
  }
  return globalFactory;
}

/**
 * 重置存储工厂（用于测试隔离）
 */
export function resetStorageFactory(): void {
  globalFactory = null;
  resetSharedRedisClient();
}

/**
 * 创建 KV 存储的便捷方法
 */
export function createKVStore(prefix: string): IKVStore {
  const useRedis = shouldUseRedis();
  if (useRedis) {
    const client = getSharedRedisClient();
    return new RedisKVStore(client, prefix);
  }
  return new MemoryKVStore(prefix);
}

export type { IKVStore } from './interface';
