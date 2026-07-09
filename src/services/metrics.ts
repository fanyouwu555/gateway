/**
 * 用量统计服务
 * 记录和统计 token 使用情况
 * 支持内存/Redis 存储，多维度聚合分析
 */
import type { TenantId, RequestId } from '../types';
import type { IKVStore } from '../stores/interface';
import { createKVStore } from '../stores/factory';
import { writeLog } from '../utils/logger';
import { getPricingService } from './pricing';
import { shouldUseRedis, HOUR_MS, DAY_MS, round3 } from '../utils';

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
  key_hash?: string;
  key_metadata?: Record<string, string>;
}

/**
 * 时间聚合粒度
 */
export type AggregationGranularity = 'hour' | 'day' | 'week' | 'month' | 'all';

/**
 * 时间点统计数据
 */
export interface TimeSeriesPoint {
  timestamp: number;
  time_label: string;
  total_requests: number;
  total_tokens: number;
  total_cost: number;
  avg_duration_ms: number;
  success_rate: number;
  error_rate: number;
}

/**
 * Provider 维度统计
 */
export interface ProviderStats {
  provider: string;
  total_requests: number;
  total_tokens: number;
  total_cost: number;
  avg_duration_ms: number;
  success_rate: number;
  by_model: Record<string, {
    total_requests: number;
    total_tokens: number;
    total_cost: number;
    avg_duration_ms: number;
  }>;
}

/**
 * 租户维度统计
 */
export interface TenantStats {
  tenant_id: string;
  total_requests: number;
  total_tokens: number;
  total_cost: number;
  avg_duration_ms: number;
  success_rate: number;
  by_provider: Record<string, number>;
  by_model: Record<string, number>;
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
    this.useStorage = shouldUseRedis('METRICS_STORAGE');
    if (this.useStorage) {
      this.store = createKVStore('metrics');
    }
  }

  async initStorage(): Promise<void> {
    if (this.useStorage && this.store) {
      await this.store.connect();
      // 从 Redis 恢复历史数据到内存
      await this.loadFromStorage();
    }
  }

  private async loadFromStorage(): Promise<void> {
    if (!this.store) return;
    try {
      const items = await this.store.lRange(this.storageKey, 0, -1);
      if (items && items.length > 0) {
        const parsed: RequestMetrics[] = [];
        for (const item of items) {
          try {
            parsed.push(JSON.parse(item) as RequestMetrics);
          } catch {
            // 忽略损坏的数据
          }
        }
        this.metrics = parsed;
        writeLog('info', 'Metrics loaded from storage', { count: this.metrics.length });
      }
    } catch (err) {
      writeLog('warn', 'Failed to load metrics from storage', { error: err instanceof Error ? err.message : String(err) });
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
      this.store.lPush(this.storageKey, JSON.stringify(metric)).catch((err) => {
        writeLog('warn', 'Failed to push metrics to storage', { error: err instanceof Error ? err.message : String(err) });
      });
      // 修剪存储中的历史
      this.store.lTrim(this.storageKey, 0, this.maxSize - 1).catch((err) => {
        writeLog('warn', 'Failed to trim metrics storage', { error: err instanceof Error ? err.message : String(err) });
      });
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
let metricsStore = new MetricsStore();

/**
 * 初始化指标存储（从 Redis 加载历史数据）
 */
export async function initMetricsStore(): Promise<void> {
  await metricsStore.initStorage();
}

/**
 * 重置指标存储（用于测试隔离）
 */
export function resetMetricsStore(): void {
  metricsStore = new MetricsStore();
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
  tokens: TokenUsage,
  key_hash?: string,
  key_metadata?: Record<string, string>
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
    key_hash,
    key_metadata,
  };

  // 计算费用
  const cost = getPricingService().calculateCost(model, tokens.prompt_tokens, tokens.completion_tokens);
  if (cost !== undefined) {
    metric.cost = cost;
  }

  metricsStore.add(metric);

  // 在非测试环境下广播请求完成事件
  // Jest 测试环境下动态导入会在测试结束后执行导致报错
  if (typeof process !== 'undefined' && process.env?.NODE_ENV !== 'test') {
    process.nextTick(() => {
      try {
        // 动态导入避免循环依赖
        import('../middleware/websocket.js').then(({ broadcastRequestComplete }) => {
          broadcastRequestComplete({
            request_id: requestId,
            tenant_id: tenantId || 'unknown',
            model,
            provider,
            duration_ms,
            total_tokens: tokens.total_tokens,
            status: status_code >= 200 && status_code < 400 ? 'success' : 'error',
          });
        }).catch(() => {
          // 静默失败，不影响主流程
        });
      } catch {
        // 忽略所有广播错误
      }
    });
  }

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
 * 获取特定 API Key 的使用统计
 */
export function getKeyUsage(keyHash: string): {
  total_requests: number;
  total_tokens: number;
  total_cost: number;
  last_used: number | null;
} {
  const metrics = metricsStore.getAll().filter((m) => m.key_hash === keyHash);

  if (metrics.length === 0) {
    return { total_requests: 0, total_tokens: 0, total_cost: 0, last_used: null };
  }

  const totalRequests = metrics.length;
  const totalTokens = metrics.reduce((sum, m) => sum + m.tokens.total_tokens, 0);
  const totalCost = metrics.reduce((sum, m) => sum + (m.cost || 0), 0);
  const lastUsed = metrics.reduce((max, m) => Math.max(max, m.timestamp), 0);

  return {
    total_requests: totalRequests,
    total_tokens: totalTokens,
    total_cost: round3(totalCost),
    last_used: lastUsed,
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
    total_cost: round3(totalCost),
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

/**
 * 获取时间序列统计（按指定粒度聚合）
 */
export function getTimeSeriesMetrics(
  startTime: number,
  endTime: number,
  granularity: AggregationGranularity = 'hour'
): TimeSeriesPoint[] {
  const metrics = metricsStore.getByTimeRange(startTime, endTime);

  if (metrics.length === 0) {
    return [];
  }

  // 计算时间间隔（毫秒）
  const intervalMs = getIntervalMs(granularity);

  // 按时间间隔分组
  const timeGroups = new Map<number, RequestMetrics[]>();

  for (const m of metrics) {
    const bucket = Math.floor(m.timestamp / intervalMs) * intervalMs;
    if (!timeGroups.has(bucket)) {
      timeGroups.set(bucket, []);
    }
    timeGroups.get(bucket)!.push(m);
  }

  // 对每个时间桶计算统计
  const result: TimeSeriesPoint[] = [];

  for (const [timestamp, bucketMetrics] of Array.from(timeGroups.entries()).sort((a, b) => a[0] - b[0])) {
    const totalRequests = bucketMetrics.length;
    const totalTokens = bucketMetrics.reduce((sum, m) => sum + m.tokens.total_tokens, 0);
    const totalCost = bucketMetrics.reduce((sum, m) => sum + (m.cost || 0), 0);
    const avgDuration = bucketMetrics.reduce((sum, m) => sum + m.duration_ms, 0) / totalRequests;

    // 计算成功率
    const successCount = bucketMetrics.filter((m) => m.status_code >= 200 && m.status_code < 300).length;
    const successRate = totalRequests > 0 ? successCount / totalRequests : 0;

    result.push({
      timestamp,
      time_label: formatTimeLabel(timestamp, granularity),
      total_requests: totalRequests,
      total_tokens: totalTokens,
      total_cost: round3(totalCost),
      avg_duration_ms: Math.round(avgDuration),
      success_rate: Math.round(successRate * 10000) / 10000,
      error_rate: Math.round((1 - successRate) * 10000) / 10000,
    });
  }

  return result;
}

/**
 * 获取 Provider 维度统计
 */
export function getProviderStats(startTime: number, endTime: number): ProviderStats[] {
  const metrics = metricsStore.getByTimeRange(startTime, endTime);

  if (metrics.length === 0) {
    return [];
  }

  // 按 Provider 分组
  const providerGroups = new Map<string, RequestMetrics[]>();
  for (const m of metrics) {
    if (!providerGroups.has(m.provider)) {
      providerGroups.set(m.provider, []);
    }
    providerGroups.get(m.provider)!.push(m);
  }

  // 计算每个 Provider 的统计
  const result: ProviderStats[] = [];

  for (const [provider, providerMetrics] of providerGroups.entries()) {
    const totalRequests = providerMetrics.length;
    const totalTokens = providerMetrics.reduce((sum, m) => sum + m.tokens.total_tokens, 0);
    const totalCost = providerMetrics.reduce((sum, m) => sum + (m.cost || 0), 0);
    const avgDuration = providerMetrics.reduce((sum, m) => sum + m.duration_ms, 0) / totalRequests;

    // 计算成功率
    const successCount = providerMetrics.filter((m) => m.status_code >= 200 && m.status_code < 300).length;
    const successRate = totalRequests > 0 ? successCount / totalRequests : 0;

    // 按 Model 细分
    const byModel: Record<string, {
      total_requests: number;
      total_tokens: number;
      total_cost: number;
      avg_duration_ms: number;
    }> = {};

    const modelGroups = new Map<string, RequestMetrics[]>();
    for (const m of providerMetrics) {
      if (!modelGroups.has(m.model)) {
        modelGroups.set(m.model, []);
      }
      modelGroups.get(m.model)!.push(m);
    }

    for (const [model, modelMetrics] of modelGroups.entries()) {
      const modelRequests = modelMetrics.length;
      const modelTokens = modelMetrics.reduce((sum, m) => sum + m.tokens.total_tokens, 0);
      const modelCost = modelMetrics.reduce((sum, m) => sum + (m.cost || 0), 0);
      const modelAvgDuration = modelMetrics.reduce((sum, m) => sum + m.duration_ms, 0) / modelRequests;

      byModel[model] = {
        total_requests: modelRequests,
        total_tokens: modelTokens,
        total_cost: round3(modelCost),
        avg_duration_ms: Math.round(modelAvgDuration),
      };
    }

    result.push({
      provider,
      total_requests: totalRequests,
      total_tokens: totalTokens,
      total_cost: round3(totalCost),
      avg_duration_ms: Math.round(avgDuration),
      success_rate: Math.round(successRate * 10000) / 10000,
      by_model: byModel,
    });
  }

  return result.sort((a, b) => b.total_requests - a.total_requests);
}

/**
 * 获取所有租户统计
 */
export function getAllTenantsStats(startTime: number, endTime: number): TenantStats[] {
  const metrics = metricsStore.getByTimeRange(startTime, endTime);

  if (metrics.length === 0) {
    return [];
  }

  // 按 Tenant 分组
  const tenantGroups = new Map<string, RequestMetrics[]>();
  for (const m of metrics) {
    if (!tenantGroups.has(m.tenant_id)) {
      tenantGroups.set(m.tenant_id, []);
    }
    tenantGroups.get(m.tenant_id)!.push(m);
  }

  // 计算每个 Tenant 的统计
  const result: TenantStats[] = [];

  for (const [tenantId, tenantMetrics] of tenantGroups.entries()) {
    const totalRequests = tenantMetrics.length;
    const totalTokens = tenantMetrics.reduce((sum, m) => sum + m.tokens.total_tokens, 0);
    const totalCost = tenantMetrics.reduce((sum, m) => sum + (m.cost || 0), 0);
    const avgDuration = tenantMetrics.reduce((sum, m) => sum + m.duration_ms, 0) / totalRequests;

    // 计算成功率
    const successCount = tenantMetrics.filter((m) => m.status_code >= 200 && m.status_code < 300).length;
    const successRate = totalRequests > 0 ? successCount / totalRequests : 0;

    // 按 Provider 细分
    const byProvider: Record<string, number> = {};
    for (const m of tenantMetrics) {
      byProvider[m.provider] = (byProvider[m.provider] || 0) + 1;
    }

    // 按 Model 细分
    const byModel: Record<string, number> = {};
    for (const m of tenantMetrics) {
      byModel[m.model] = (byModel[m.model] || 0) + 1;
    }

    result.push({
      tenant_id: tenantId,
      total_requests: totalRequests,
      total_tokens: totalTokens,
      total_cost: round3(totalCost),
      avg_duration_ms: Math.round(avgDuration),
      success_rate: Math.round(successRate * 10000) / 10000,
      by_provider: byProvider,
      by_model: byModel,
    });
  }

  return result.sort((a, b) => b.total_requests - a.total_requests);
}

/**
 * 获取状态码统计
 */
export function getStatusCodeStats(
  startTime: number,
  endTime: number
): { [code: string]: number; } {
  const metrics = metricsStore.getByTimeRange(startTime, endTime);
  const stats: Record<string, number> = {};

  for (const m of metrics) {
    const code = m.status_code.toString();
    stats[code] = (stats[code] || 0) + 1;
  }

  return stats;
}

/**
 * 获取概览统计（用于 Dashboard）
 */
export function getDashboardOverview(startTime: number, endTime: number): {
  total_requests: number;
  total_tokens: number;
  total_cost: number;
  avg_duration_ms: number;
  success_rate: number;
  error_rate: number;
  total_providers: number;
  total_models: number;
  total_tenants: number;
} {
  const metrics = metricsStore.getByTimeRange(startTime, endTime);

  if (metrics.length === 0) {
    return {
      total_requests: 0,
      total_tokens: 0,
      total_cost: 0,
      avg_duration_ms: 0,
      success_rate: 0,
      error_rate: 0,
      total_providers: 0,
      total_models: 0,
      total_tenants: 0,
    };
  }

  const totalRequests = metrics.length;
  const totalTokens = metrics.reduce((sum, m) => sum + m.tokens.total_tokens, 0);
  const totalCost = metrics.reduce((sum, m) => sum + (m.cost || 0), 0);
  const avgDuration = metrics.reduce((sum, m) => sum + m.duration_ms, 0) / totalRequests;

  // 计算成功率
  const successCount = metrics.filter((m) => m.status_code >= 200 && m.status_code < 300).length;
  const successRate = totalRequests > 0 ? successCount / totalRequests : 0;

  // 计算唯一值数量
  const providers = new Set(metrics.map((m) => m.provider));
  const models = new Set(metrics.map((m) => m.model));
  const tenants = new Set(metrics.map((m) => m.tenant_id));

  return {
    total_requests: totalRequests,
    total_tokens: totalTokens,
    total_cost: round3(totalCost),
    avg_duration_ms: Math.round(avgDuration),
    success_rate: Math.round(successRate * 10000) / 10000,
    error_rate: Math.round((1 - successRate) * 10000) / 10000,
    total_providers: providers.size,
    total_models: models.size,
    total_tenants: tenants.size,
  };
}

/**
 * 获取时间间隔（毫秒）
 */
function getIntervalMs(granularity: AggregationGranularity): number {
  switch (granularity) {
    case 'hour':
      return HOUR_MS;
    case 'day':
      return DAY_MS;
    case 'week':
      return 7 * DAY_MS;
    case 'month':
      return 30 * DAY_MS;
    case 'all':
      return Number.MAX_SAFE_INTEGER;
    default:
      return HOUR_MS;
  }
}

/**
 * 格式化时间标签
 */
function formatTimeLabel(timestamp: number, granularity: AggregationGranularity): string {
  const date = new Date(timestamp);

  switch (granularity) {
    case 'hour':
      return `${date.getMonth() + 1}/${date.getDate()} ${date.getHours()}:00`;
    case 'day':
      return `${date.getMonth() + 1}/${date.getDate()}`;
    case 'week':
      return `${date.getMonth() + 1}/${date.getDate()} 周`;
    case 'month':
      return `${date.getFullYear()}/${date.getMonth() + 1}`;
    case 'all':
      return '全部';
    default:
      return timestamp.toString();
  }
}

export type { RequestMetrics, TokenUsage };