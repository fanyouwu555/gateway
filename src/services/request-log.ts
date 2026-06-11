/**
 * 请求/响应日志服务
 *
 * 可配置地记录每次请求的 body、response body，
 * 支持管理面板检索。使用环形缓冲避免内存溢出。
 * 支持内存存储（默认）和 Redis 持久化（可选）。
 */
import type { IRequestLogDetail } from '../types';
import { getConfig } from '../config';
import { createKVStore } from '../stores/factory';
import type { IKVStore } from '../stores/interface';
import { writeLog } from '../utils/logger';
import { shouldUseRedis } from '../utils';

/**
 * 日志过滤条件
 */
export type RequestLogFilter = {
  start?: number;
  end?: number;
  tenant_id?: string;
  model?: string;
  status_code?: number;
  limit?: number;
  offset?: number;
}

/**
 * 请求日志存储
 * 支持内存存储 + 可选 Redis 持久化
 */
export class RequestLogStore {
  private logs: IRequestLogDetail[] = [];
  private readonly maxSize: number;
  private enabled: boolean;
  private sampleRate: number;
  private maxBodySize: number;

  private useRedis = false;
  private store: IKVStore | null = null;
  private readonly storageKey = 'request_logs';
  private readonly maxStorageSize = 10000;

  constructor() {
    const cfg = getConfig().request_logging || {};
    this.maxSize = 1000;
    this.enabled = cfg.enabled ?? false;
    this.sampleRate = cfg.sample_rate ?? 1.0;
    this.maxBodySize = cfg.max_body_size ?? 4096;

    this.useRedis = shouldUseRedis('REQUEST_LOG_STORAGE');
    if (this.useRedis) {
      this.store = createKVStore('request_logs');
    }
  }

  /**
   * 初始化存储连接，从 Redis 加载历史数据
   */
  async init(): Promise<void> {
    if (this.useRedis && this.store) {
      await this.store.connect();
      await this.loadFromStorage();
    }
  }

  /**
   * 从存储加载历史日志到内存
   */
  private async loadFromStorage(): Promise<void> {
    if (!this.store) return;
    try {
      const items = await this.store.lRange(this.storageKey, 0, this.maxSize - 1);
      if (items && items.length > 0) {
        const parsed: IRequestLogDetail[] = [];
        for (const item of items) {
          try {
            parsed.push(JSON.parse(item) as IRequestLogDetail);
          } catch {
            // 忽略损坏的数据
          }
        }
        this.logs = parsed;
        writeLog('info', 'Request logs loaded from storage', { count: this.logs.length });
      }
    } catch (err) {
      writeLog('warn', 'Failed to load request logs from storage', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * 判断是否应该记录本次请求
   */
  shouldSample(): boolean {
    if (!this.enabled) return false;
    return Math.random() < this.sampleRate;
  }

  /**
   * 截断过大的 body
   */
  private truncateBody(body: string): string {
    if (body.length <= this.maxBodySize) return body;
    return body.slice(0, this.maxBodySize) + '... [truncated]';
  }

  /**
   * 添加日志
   */
  add(log: IRequestLogDetail): void {
    if (!this.enabled) return;
    if (log.request_body) {
      log.request_body = this.truncateBody(log.request_body);
    }
    if (log.response_body) {
      log.response_body = this.truncateBody(log.response_body);
    }
    this.logs.push(log);
    if (this.logs.length > this.maxSize) {
      this.logs.shift();
    }

    // 异步写入 Redis
    if (this.useRedis && this.store) {
      this.store.lPush(this.storageKey, JSON.stringify(log)).catch((err) => {
        writeLog('warn', 'Failed to push request log to storage', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
      this.store.lTrim(this.storageKey, 0, this.maxStorageSize - 1).catch((err) => {
        writeLog('warn', 'Failed to trim request log storage', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }
  }

  /**
   * 按条件查询日志
   */
  getLogs(filter: RequestLogFilter = {}): IRequestLogDetail[] {
    let result = [...this.logs];

    if (filter.start) {
      result = result.filter((log) => log.timestamp >= filter.start!);
    }
    if (filter.end) {
      result = result.filter((log) => log.timestamp <= filter.end!);
    }
    if (filter.tenant_id) {
      result = result.filter((log) => log.tenant_id === filter.tenant_id);
    }
    if (filter.model) {
      result = result.filter((log) => log.model === filter.model);
    }
    if (filter.status_code !== undefined) {
      result = result.filter((log) => log.status_code === filter.status_code);
    }

    // 按时间倒序
    result.sort((a, b) => b.timestamp - a.timestamp);

    const offset = filter.offset ?? 0;
    const limit = filter.limit ?? 100;
    return result.slice(offset, offset + limit);
  }

  /**
   * 获取日志总数
   */
  getTotalCount(): number {
    return this.logs.length;
  }

  /**
   * 清空日志
   */
  clear(): void {
    this.logs = [];
    if (this.useRedis && this.store) {
      this.store.delete(this.storageKey).catch(() => {});
    }
  }
}

// 单例
let logStore = new RequestLogStore();

/**
 * 初始化请求日志存储
 */
export async function initRequestLogStore(): Promise<void> {
  await logStore.init();
}

/**
 * 重置请求日志存储（用于测试隔离）
 */
export function resetRequestLogStore(): void {
  logStore = new RequestLogStore();
}

/**
 * 获取请求日志存储实例
 */
export function getRequestLogStore(): RequestLogStore {
  return logStore;
}
