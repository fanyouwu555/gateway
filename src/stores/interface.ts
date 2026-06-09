/**
 * 存储接口定义
 * 统一内存和 Redis 存储的抽象层
 */

/**
 * 存储类型
 */
export type StorageType = 'memory' | 'redis';

/**
 * 基础存储接口
 */
export interface IStorage {
  /** 存储类型 */
  type: StorageType;

  /** 连接/初始化 */
  connect(): Promise<void>;

  /** 断开连接 */
  disconnect(): Promise<void>;

  /** 是否已连接 */
  isConnected(): boolean;
}

/**
 * Key-Value 存储接口
 */
export interface IKVStore extends IStorage {
  /** 设置值 */
  set(key: string, value: string, ttl?: number): Promise<void>;

  /** 获取值 */
  get(key: string): Promise<string | null>;

  /** 删除值 */
  delete(key: string): Promise<boolean>;

  /** 设置过期时间 */
  expire(key: string, ttl: number): Promise<boolean>;

  /** 检查键是否存在 */
  exists(key: string): Promise<boolean>;

  /** 自增 */
  incr(key: string): Promise<number>;

  /** 设置哈希 */
  hSet(key: string, field: string, value: string): Promise<void>;

  /** 获取哈希 */
  hGet(key: string, field: string): Promise<string | null>;

  /** 获取所有哈希字段 */
  hGetAll(key: string): Promise<Record<string, string>>;

  /** 删除哈希字段 */
  hDel(key: string, ...fields: string[]): Promise<number>;

  /** 列表操作 - 从左侧推入 */
  lPush(key: string, ...values: string[]): Promise<number>;

  /** 列表操作 - 获取范围 */
  lRange(key: string, start: number, stop: number): Promise<string[]>;

  /** 列表操作 - 修剪 */
  lTrim(key: string, start: number, stop: number): Promise<void>;

  /** 获取键前缀匹配的所有键 */
  keys(pattern: string): Promise<string[]>;

  /** 删除匹配的所有键 */
  delByPattern(pattern: string): Promise<number>;
}
