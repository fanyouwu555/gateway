/**
 * Prometheus 监控指标中间件
 * 使用 prom-client 收集 HTTP 请求指标并暴露 /metrics 端点
 */
import type { Context, Next } from 'hono';
import { Registry, Counter, Histogram } from 'prom-client';

// ===== 私有注册表（隔离于 prom-client 全局默认注册表） =====
const register = new Registry();

// ----- 计数器 -----
const gatewayRequestsTotal = new Counter({
  name: 'gateway_requests_total',
  help: 'Total HTTP requests',
  labelNames: ['method', 'path'],
  registers: [register],
});

const gatewayResponsesTotal = new Counter({
  name: 'gateway_responses_total',
  help: 'Total HTTP responses by status code',
  labelNames: ['method', 'path', 'status'],
  registers: [register],
});

const gatewayCacheHitsTotal = new Counter({
  name: 'gateway_cache_hits_total',
  help: 'Cache hit count',
  labelNames: ['type'],
  registers: [register],
});

const gatewayCacheMissesTotal = new Counter({
  name: 'gateway_cache_misses_total',
  help: 'Cache miss count',
  labelNames: [],
  registers: [register],
});

const gatewayAiCostUsd = new Counter({
  name: 'gateway_ai_cost_usd',
  help: 'AI call cost in USD',
  labelNames: ['provider', 'model'],
  registers: [register],
});

const gatewayAiTokensTotal = new Counter({
  name: 'gateway_ai_tokens_total',
  help: 'AI token usage',
  labelNames: ['provider', 'model', 'type'],
  registers: [register],
});

// ----- 直方图 -----
const gatewayRequestDurationSeconds = new Histogram({
  name: 'gateway_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'path'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [register],
});

const gatewayAiTtfbMs = new Histogram({
  name: 'gateway_ai_ttfb_ms',
  help: 'AI time to first byte in milliseconds',
  labelNames: ['provider', 'model'],
  buckets: [50, 100, 250, 500, 1000, 2500, 5000, 10000],
  registers: [register],
});

const gatewayAiTpotMs = new Histogram({
  name: 'gateway_ai_tpot_ms',
  help: 'AI time per output token in milliseconds',
  labelNames: ['provider', 'model'],
  buckets: [10, 25, 50, 100, 250, 500, 1000],
  registers: [register],
});

/**
 * 重置所有指标（用于测试隔离）
 */
export function resetMetrics(): void {
  register.resetMetrics();
}

/**
 * 将动态路径中的 ID 段归一化为占位符
 * 防止 Prometheus label 基数爆炸
 * 例: /v1/tenants/abc-123/stats → /v1/tenants/:id/stats
 */
function normalizePath(path: string): string {
  const knownWords = new Set([
    'tenants', 'keys', 'usage', 'stats', 'config', 'plugins',
    'prompts', 'cache', 'sessions', 'alerts', 'router', 'status',
    'health', 'metrics', 'messages', 'register', 'aliases', 'clean',
  ]);
  const segments = path.split('/');
  return segments.map((seg) => {
    if (!seg || knownWords.has(seg)) return seg;
    if (/^[0-9a-f]{8,}(-[0-9a-f]{4,}){2,}$/i.test(seg)) return ':id';
    if (seg.startsWith('tenant_') || seg.startsWith('sk-') || seg.startsWith('key-')) return ':id';
    if (/^\d+$/.test(seg) && seg.length >= 3) return ':id';
    if (seg.length >= 8 && !knownWords.has(seg)) return ':id';
    return seg;
  }).join('/');
}

/**
 * Prometheus 指标中间件
 */
export async function metricsMiddleware(c: Context, next: Next): Promise<void> {
  const start = Date.now();
  const path = normalizePath(c.req.path);
  const method = c.req.method;

  if (path === '/metrics') {
    await next();
    return;
  }

  gatewayRequestsTotal.inc({ method, path });

  await next();

  const status = String(c.res.status);
  gatewayResponsesTotal.inc({ method, path, status });

  const duration = (Date.now() - start) / 1000;
  gatewayRequestDurationSeconds.observe({ method, path }, duration);
}

/**
 * 获取 Prometheus 格式的指标
 */
export function getMetrics(): Promise<string> {
  return register.metrics();
}

/**
 * Record cache hit
 */
export function recordCacheHit(type: 'exact' | 'semantic'): void {
  gatewayCacheHitsTotal.inc({ type });
}

/**
 * Record cache miss
 */
export function recordCacheMiss(): void {
  gatewayCacheMissesTotal.inc();
}

/**
 * 记录 AI 首字节/首 token 延迟 (TTFT)
 */
export function recordAiTtfb(ms: number, provider: string, model: string): void {
  gatewayAiTtfbMs.observe({ provider, model }, ms);
}

/**
 * 记录 AI 每输出 token 耗时 (TPOT)
 */
export function recordAiTpot(ms: number, provider: string, model: string): void {
  gatewayAiTpotMs.observe({ provider, model }, ms);
}

/**
 * 记录 AI 调用成本 (USD)
 */
export function recordAiCost(cost: number, provider: string, model: string): void {
  gatewayAiCostUsd.inc({ provider, model }, cost);
}

/**
 * 记录 AI Token 使用量
 */
export function recordAiTokens(
  promptTokens: number,
  completionTokens: number,
  provider: string,
  model: string
): void {
  gatewayAiTokensTotal.inc({ provider, model, type: 'prompt' }, promptTokens);
  gatewayAiTokensTotal.inc({ provider, model, type: 'completion' }, completionTokens);
}

/**
 * /metrics 路由处理函数
 */
export async function metricsHandler(c: Context): Promise<Response> {
  const metrics = await getMetrics();
  return c.text(metrics, 200, {
    'Content-Type': register.contentType,
  });
}
