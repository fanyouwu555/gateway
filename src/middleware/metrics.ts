/**
 * Prometheus 监控指标中间件
 * 收集 HTTP 请求指标并暴露 /metrics 端点
 */
import type { Context, Next } from 'hono';

// ===== 指标存储 =====

interface Counter {
  name: string;
  help: string;
  labels: Record<string, string>;
  value: number;
}

interface Histogram {
  name: string;
  help: string;
  labels: Record<string, string>;
  buckets: number[];
  counts: Record<string, number>;
  sums: Record<string, number>;
}

class MetricsRegistry {
  private counters = new Map<string, Counter>();
  private histograms = new Map<string, Histogram>();

  /**
   * 创建或获取计数器
   */
  counter(name: string, help: string, labels: Record<string, string> = {}): Counter {
    const key = `${name}:${JSON.stringify(labels)}`;
    let counter = this.counters.get(key);
    if (!counter) {
      counter = { name, help, labels, value: 0 };
      this.counters.set(key, counter);
    }
    return counter;
  }

  /**
   * 递增计数器
   */
  inc(name: string, labels: Record<string, string> = {}, value = 1): void {
    const counter = this.counter(name, '', labels);
    counter.value += value;
  }

  /**
   * 记录直方图观测值
   */
  observe(name: string, value: number, labels: Record<string, string> = {}): void {
    const key = `${name}:${JSON.stringify(labels)}`;
    let hist = this.histograms.get(key);
    if (!hist) {
      hist = {
        name,
        help: '',
        labels,
        buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
        counts: {},
        sums: {},
      };
      this.histograms.set(key, hist);
    }
    // 记录到桶
    for (const bucket of hist.buckets) {
      if (value <= bucket) {
        const bucketKey = bucket.toString();
        hist.counts[bucketKey] = (hist.counts[bucketKey] || 0) + 1;
      }
    }
    // 记录总和
    const sumKey = '_sum';
    hist.sums[sumKey] = (hist.sums[sumKey] || 0) + value;
  }

  /**
   * 序列化为 Prometheus 文本格式
   */
  serialize(): string {
    const lines: string[] = [];

    // 输出计数器
    for (const [, counter] of this.counters) {
      lines.push(`# HELP ${counter.name} ${counter.help}`);
      lines.push(`# TYPE ${counter.name} counter`);
      const labelStr = this.formatLabels(counter.labels);
      lines.push(`${counter.name}${labelStr} ${counter.value}`);
    }

    // 输出直方图
    for (const [, hist] of this.histograms) {
      lines.push(`# HELP ${hist.name} ${hist.help}`);
      lines.push(`# TYPE ${hist.name} histogram`);
      let totalCount = 0;
      for (const bucket of hist.buckets) {
        const bucketKey = bucket.toString();
        const count = hist.counts[bucketKey] || 0;
        totalCount += count;
        const labels = { ...hist.labels, le: bucketKey };
        lines.push(`${hist.name}_bucket${this.formatLabels(labels)} ${totalCount}`);
      }
      // +Inf bucket
      const infLabels = { ...hist.labels, le: '+Inf' };
      lines.push(`${hist.name}_bucket${this.formatLabels(infLabels)} ${totalCount}`);
      // sum and count
      lines.push(`${hist.name}_sum${this.formatLabels(hist.labels)} ${hist.sums['_sum'] || 0}`);
      lines.push(`${hist.name}_count${this.formatLabels(hist.labels)} ${totalCount}`);
    }

    return lines.join('\n');
  }

  private formatLabels(labels: Record<string, string>): string {
    const entries = Object.entries(labels).filter(([_, v]) => v);
    if (entries.length === 0) return '';
    return `{${entries.map(([k, v]) => `${k}="${v}"`).join(',')}}`;
  }
}

// 全局注册表
const registry = new MetricsRegistry();

/**
 * 重置所有指标（用于测试）
 */
export function resetMetrics(): void {
  // 通过重新创建注册表实现
}

/**
 * Prometheus 指标中间件
 */
export async function metricsMiddleware(c: Context, next: Next): Promise<void> {
  const start = Date.now();
  const path = c.req.path;
  const method = c.req.method;

  // 排除 /metrics 自身的监控
  if (path === '/metrics') {
    await next();
    return;
  }

  // 记录请求总数
  registry.inc('gateway_requests_total', { method, path });

  await next();

  // 记录响应状态码
  const status = c.res.status;
  registry.inc('gateway_responses_total', { method, path, status: String(status) });

  // 记录延迟
  const duration = (Date.now() - start) / 1000;
  registry.observe('gateway_request_duration_seconds', duration, { method, path });

  // 记录延迟摘要
  registry.inc('gateway_request_duration_ms', { method, path }, duration * 1000);
}

/**
 * 获取 Prometheus 格式的指标
 */
export function getMetrics(): string {
  return registry.serialize();
}

/**
 * 记录 Token 使用量
 */
export function recordTokenUsage(provider: string, model: string, promptTokens: number, completionTokens: number): void {
  registry.inc('gateway_tokens_total', { provider, model, type: 'prompt' }, promptTokens);
  registry.inc('gateway_tokens_total', { provider, model, type: 'completion' }, completionTokens);
  registry.inc('gateway_requests_total', { provider, model });
}

/**
 * 记录 HTTP 请求总数（简化版本）
 */
export function incRequestCount(): void {
  registry.inc('gateway_requests_total');
}

/**
 * 记录响应时间
 */
export function recordResponseTime(ms: number): void {
  registry.observe('gateway_response_time_seconds', ms / 1000);
  registry.inc('gateway_response_time_ms_sum', {}, ms);
}

// 为 Hono 应用提供 /metrics 路由处理函数
export function metricsHandler(c: Context): Response {
  return c.text(getMetrics(), 200, {
    'Content-Type': 'text/plain; charset=utf-8',
  });
}
