/**
 * 请求/响应日志服务
 *
 * 可配置地记录每次请求的 body、response body，
 * 支持管理面板检索。使用环形缓冲避免内存溢出。
 */
import type { IRequestLogDetail } from '../types';
import { getConfig } from '../config';

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
 */
class RequestLogStore {
  private logs: IRequestLogDetail[] = [];
  private readonly maxSize: number;
  private enabled: boolean;
  private sampleRate: number;
  private maxBodySize: number;

  constructor() {
    const cfg = getConfig().request_logging || {};
    this.maxSize = 1000;
    this.enabled = cfg.enabled ?? false;
    this.sampleRate = cfg.sample_rate ?? 1.0;
    this.maxBodySize = cfg.max_body_size ?? 4096;
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
  }

  /**
   * 按条件查询日志
   */
  getLogs(filter: RequestLogFilter = {}): IRequestLogDetail[] {
    let result = [...this.logs];

    if (filter.start) {
      result = result.filter((l) => l.timestamp >= filter.start!);
    }
    if (filter.end) {
      result = result.filter((l) => l.timestamp <= filter.end!);
    }
    if (filter.tenant_id) {
      result = result.filter((l) => l.tenant_id === filter.tenant_id);
    }
    if (filter.model) {
      result = result.filter((l) => l.model === filter.model);
    }
    if (filter.status_code !== undefined) {
      result = result.filter((l) => l.status_code === filter.status_code);
    }

    // 默认按时间降序
    result.sort((a, b) => b.timestamp - a.timestamp);

    const offset = filter.offset ?? 0;
    const limit = filter.limit ?? 50;
    return result.slice(offset, offset + limit);
  }

  /**
   * 获取日志总数
   */
  getTotalCount(): number {
    return this.logs.length;
  }

  /**
   * 清空
   */
  clear(): void {
    this.logs = [];
  }
}

// 单例
let _instance: RequestLogStore | null = null;

export function getRequestLogStore(): RequestLogStore {
  if (!_instance) {
    _instance = new RequestLogStore();
  }
  return _instance;
}

export function resetRequestLogStore(): void {
  _instance = null;
}

export { RequestLogStore };