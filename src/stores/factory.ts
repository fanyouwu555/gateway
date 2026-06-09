/**
 * 存储工厂 - 创建 Memory 或 Redis 存储
 */
import type { IKVStore, StorageType } from './interface';
import { MemoryKVStore } from './memory';
import { RedisKVStore, createRedisConfigFromEnv, type RedisConfig } from './redis';
import { writeLog } from '../utils/logger';

/**
 * 存储配置
 */
export interface StorageConfig {
  type: StorageType;
  redis?: RedisConfig;
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
      if (this.config.redis) {
        return new RedisKVStore({ ...this.config.redis, prefix });
      }
      // 从环境变量创建
      const redisConfig = createRedisConfigFromEnv();
      if (redisConfig) {
        return new RedisKVStore({ ...redisConfig, prefix });
      }
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
}

/**
 * 创建 KV 存储的便捷方法
 */
export function createKVStore(prefix: string): IKVStore {
  return getStorageFactory().createKVStore(prefix);
}

export type { IKVStore } from './interface';