/**
 * 用量统计服务
 * 记录和统计 token 使用情况
 * 支持内存/Redis 存储
 */
import type { TenantId, RequestId } from '../types';
import type { IKVStore } from '../stores/interface';
import { createKVStore } from '../stores/factory';

interface TokenUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

interface RequestMetrics {
  request_id: RequestId;
  tenant_id: TenantId;
  provider: string;
  model: string;
  timestamp: number;
  duration_ms: number;
  status_code: number;
  tokens: TokenUsage;
  cost?: number;
}

/**
 * 指标存储 - 支持内存和 Redis
 */
class MetricsStore {
  private metrics: RequestMetrics[] = [];
  private readonly maxSize = 10000;
  private store: IKVStore | null = null;
  private useStorage = false;
  private readonly storageKey = 'metrics';

  constructor() {
    this.useStorage = process.env.METRICS_STORAGE === 'redis';
    if (this.useStorage) {
      this.store = createKVStore('metrics');
    }
  }

  async initStorage(): Promise<void> {
    if (this.useStorage && this.store) {
      await this.store.connect();
    }
  }

  add(metric: RequestMetrics): void {
    this.metrics.push(metric);
    // 保持固定大小，防止内存无限增长
    if (this.metrics.length > this.maxSize) {
      this.metrics = this.metrics.slice(-this.maxSize);
    }

    // 异步写入存储
    if (this.useStorage && this.store) {
      this.store.lPush(this.storageKey, JSON.stringify(metric)).catch(() => {});
      // 修剪存储中的历史
      this.store.lTrim(this.storageKey, 0, this.maxSize - 1).catch(() => {});
    }
  }

  getByTenant(tenantId: TenantId): RequestMetrics[] {
    return this.metrics.filter((m) => m.tenant_id === tenantId);
  }

  getByTimeRange(startTime: number, endTime: number): RequestMetrics[] {
    return this.metrics.filter(
      (m) => m.timestamp >= startTime && m.timestamp <= endTime
    );
  }

  getAll(): RequestMetrics[] {
    return [...this.metrics];
  }

  clear(): void {
    this.metrics = [];
  }
}

// 单例
const metricsStore = new MetricsStore();

/**
 * Token 价格（每 1M tokens 的价格，美元）
 */
const TOKEN_PRICING: Record<string, { input: number; output: number }> = {
  // OpenAI
  'gpt-4o': { input: 5.0, output: 15.0 },
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
  'gpt-4-turbo': { input: 10.0, output: 30.0 },
  'gpt-3.5-turbo': { input: 0.5, output: 1.5 },
  // DeepSeek
  'deepseek-chat': { input: 0.27, output: 1.1 },
  'deepseek-coder': { input: 0.27, output: 1.1 },
  // Anthropic
  'claude-3-5-sonnet': { input: 3.0, output: 15.0 },
  'claude-3-opus': { input: 15.0, output: 75.0 },
};

/**
 * 计算请求费用
 */
export function calculateCost(
  model: string,
  tokens: TokenUsage
): number | undefined {
  const pricing = TOKEN_PRICING[model];
  if (!pricing) {
    return undefined;
  }

  const inputCost = (tokens.prompt_tokens / 1000000) * pricing.input;
  const outputCost = (tokens.completion_tokens / 1000000) * pricing.output;

  return inputCost + outputCost;
}

/**
 * 记录请求指标
 */
export function recordMetric(
  requestId: RequestId,
  tenantId: TenantId | undefined,
  provider: string,
  model: string,
  duration_ms: number,
  status_code: number,
  tokens: TokenUsage
): RequestMetrics {
  const metric: RequestMetrics = {
    request_id: requestId,
    tenant_id: tenantId || 'unknown',
    provider,
    model,
    timestamp: Date.now(),
    duration_ms,
    status_code,
    tokens,
  };

  // 计算费用
  const cost = calculateCost(model, tokens);
  if (cost !== undefined) {
    metric.cost = cost;
  }

  metricsStore.add(metric);
  return metric;
}

/**
 * 获取租户使用统计
 */
export function getTenantUsage(tenantId: TenantId): {
  total_requests: number;
  total_tokens: number;
  total_cost: number;
  avg_duration_ms: number;
} {
  const metrics = metricsStore.getByTenant(tenantId);

  if (metrics.length === 0) {
    return {
      total_requests: 0,
      total_tokens: 0,
      total_cost: 0,
      avg_duration_ms: 0,
    };
  }

  const totalRequests = metrics.length;
  const totalTokens = metrics.reduce(
    (sum, m) => sum + m.tokens.total_tokens,
    0
  );
  const totalCost = metrics.reduce((sum, m) => sum + (m.cost || 0), 0);
  const avgDuration =
    metrics.reduce((sum, m) => sum + m.duration_ms, 0) / totalRequests;

  return {
    total_requests: totalRequests,
    total_tokens: totalTokens,
    total_cost: totalCost,
    avg_duration_ms: Math.round(avgDuration),
  };
}

/**
 * 获取时间范围内统计
 */
export function getUsageByTimeRange(
  startTime: number,
  endTime: number
): {
  total_requests: number;
  total_tokens: number;
  total_cost: number;
  avg_duration_ms: number;
  by_provider: Record<string, number>;
  by_model: Record<string, number>;
} {
  const metrics = metricsStore.getByTimeRange(startTime, endTime);

  if (metrics.length === 0) {
    return {
      total_requests: 0,
      total_tokens: 0,
      total_cost: 0,
      avg_duration_ms: 0,
      by_provider: {},
      by_model: {},
    };
  }

  const totalRequests = metrics.length;
  const totalTokens = metrics.reduce(
    (sum, m) => sum + m.tokens.total_tokens,
    0
  );
  const totalCost = metrics.reduce((sum, m) => sum + (m.cost || 0), 0);
  const avgDuration =
    metrics.reduce((sum, m) => sum + m.duration_ms, 0) / totalRequests;

  // 按 Provider 统计
  const byProvider: Record<string, number> = {};
  for (const m of metrics) {
    byProvider[m.provider] = (byProvider[m.provider] || 0) + 1;
  }

  // 按 Model 统计
  const byModel: Record<string, number> = {};
  for (const m of metrics) {
    byModel[m.model] = (byModel[m.model] || 0) + 1;
  }

  return {
    total_requests: totalRequests,
    total_tokens: totalTokens,
    total_cost: Math.round(totalCost * 1000) / 1000,
    avg_duration_ms: Math.round(avgDuration),
    by_provider: byProvider,
    by_model: byModel,
  };
}

/**
 * 获取所有指标（用于调试）
 */
export function getAllMetrics(): RequestMetrics[] {
  return metricsStore.getAll();
}

/**
 * 清理历史数据
 */
export function clearMetrics(): void {
  metricsStore.clear();
}

export type { RequestMetrics, TokenUsage };