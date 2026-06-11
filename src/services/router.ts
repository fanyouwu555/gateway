/**
 * 智能路由服务
 * 根据请求特征自动选择最优Provider
 */
import type { ChatCompletionRequest, IRoutingStrategy, IConditionalRoutingRule } from '../types';
import { getRoutingStrategy, getConfig, getModelPool, isModelPool } from '../config';
import { getProvider } from '../providers';
import { failoverManager } from './failover';
import { contentToString } from '../utils';
import { inferRequirements, getModelCapabilities, checkCapabilityMatch, type RequestCapabilityRequirements } from './model-capability';

/**
 * 路由决策
 */
export interface RoutingDecision {
  provider: string;
  model: string;
  reason: string;
  confidence: number; // 0-1
}

/**
 * 路由策略类型
 */
export type RouterStrategy = 'cost' | 'latency' | 'quality' | 'balance';

/**
 * 路由上下文
 */
export interface RoutingContext {
  tenant_id?: string;
  latency_history?: Record<string, number[]>;
  cost_history?: Record<string, number>;
  error_rate?: Record<string, number>;
}

/**
 * 智能路由器
 */
class SmartRouter {
  private context: RoutingContext = {};

  /**
   * 设置路由上下文
   */
  setContext(context: RoutingContext): void {
    this.context = { ...this.context, ...context };
  }

  /**
   * 根据请求特征选择Provider
   */
  route(request: ChatCompletionRequest, strategy: RouterStrategy = 'balance'): RoutingDecision {
    const requirements = inferRequirements(request);

    // 1. 优先检查模型能力池
    if (request.model && isModelPool(request.model)) {
      const poolDecision = this.routeByModelPool(request, requirements);
      if (poolDecision) {
        return poolDecision;
      }
    }

    const strategyConfig = getRoutingStrategy();

    if (!strategyConfig || strategyConfig.rules.length === 0) {
      // 返回默认
      return {
        provider: 'openai',
        model: getConfig().default_model || 'gpt-4o-mini',
        reason: 'default',
        confidence: 0.5,
      };
    }

    switch (strategy) {
      case 'cost':
        return this.routeByCost(request, strategyConfig.rules);
      case 'latency':
        return this.routeByLatency(request, strategyConfig.rules);
      case 'quality':
        return this.routeByQuality(request, strategyConfig.rules);
      case 'balance':
      default:
        return this.routeByBalance(request, strategyConfig.rules);
    }
  }

  /**
   * 按模型能力池路由
   * 在池内按 priority 排序，结合健康状态选择第一个可用的 candidate
   */
  private routeByModelPool(
    request: ChatCompletionRequest,
    requirements?: RequestCapabilityRequirements,
  ): RoutingDecision | null {
    if (!request.model) return null;

    const pool = getModelPool(request.model);
    if (!pool || !pool.candidates || pool.candidates.length === 0) {
      return null;
    }

    // 按 priority 排序（数字越小优先级越高），过滤掉 disabled 的 candidate
    let candidates = pool.candidates
      .filter((c) => c.enabled !== false)
      .sort((a, b) => a.priority - b.priority);

    if (candidates.length === 0) {
      return null;
    }

    // 能力过滤：如果提供了需求，排除不满足能力要求的候选
    if (requirements) {
      const filtered = candidates.filter((c) => {
        let caps = getModelCapabilities(c.model);
        if (!caps) {
          const provider = getProvider(c.provider);
          caps = provider?.capabilities || null;
        }
        if (!caps) return true; // 未知能力，不过滤（向后兼容）
        const missing = checkCapabilityMatch(requirements, caps);
        return missing.length === 0;
      });

      // 过滤后为空时回退到全部候选，避免破坏现有配置
      if (filtered.length > 0) {
        candidates = filtered;
      }
    }

    // 选择第一个健康的 candidate
    for (const candidate of candidates) {
      if (failoverManager.isProviderHealthy(candidate.provider)) {
        return {
          provider: candidate.provider,
          model: candidate.model,
          reason: `model_pool:${pool.name}`,
          confidence: 1.0,
        };
      }
    }

    // 如果所有 candidate 都不健康，返回第一个（让 Failover 后续处理）
    return {
      provider: candidates[0].provider,
      model: candidates[0].model,
      reason: `model_pool:${pool.name}:unhealthy_fallback`,
      confidence: 0.5,
    };
  }

  /**
   * 按成本路由
   */
  private routeByCost(
    request: ChatCompletionRequest,
    rules: { model: string; provider: string }[]
  ): RoutingDecision {
    const strategyConfig = getRoutingStrategy();
    // 从配置读取成本排序，无配置则使用默认排序
    const costOrder: string[] = (strategyConfig as IRoutingStrategy)?.cost_order ?? [
      'deepseek', 'moonshot', 'groq', 'volcano', 'openai', 'mistral', 'anthropic', 'google', 'kimi-code',
    ];
    const sorted = [...rules].sort((a, b) => {
      const aIndex = costOrder.indexOf(a.provider);
      const bIndex = costOrder.indexOf(b.provider);
      // Providers not in costOrder are treated as highest cost (placed at the end)
      const aRank = aIndex === -1 ? Number.MAX_SAFE_INTEGER : aIndex;
      const bRank = bIndex === -1 ? Number.MAX_SAFE_INTEGER : bIndex;
      return aRank - bRank;
    });

    const selected = sorted[0];
    return {
      provider: selected.provider,
      model: request.model || selected.model,
      reason: 'lowest_cost',
      confidence: 0.8,
    };
  }

  /**
   * 按延迟路由
   */
  private routeByLatency(
    request: ChatCompletionRequest,
    rules: { model: string; provider: string }[]
  ): RoutingDecision {
    const latencyHistory = this.context.latency_history;
    let fastestProvider = rules[0].provider;
    let fastestLatency = Infinity;

    for (const rule of rules) {
      const history = latencyHistory?.[rule.provider];
      if (history && history.length > 0) {
        const avgLatency = history.reduce((a, b) => a + b, 0) / history.length;
        if (avgLatency < fastestLatency) {
          fastestLatency = avgLatency;
          fastestProvider = rule.provider;
        }
      }
    }

    return {
      provider: fastestProvider,
      model: request.model || rules.find((r) => r.provider === fastestProvider)?.model || '',
      reason: 'lowest_latency',
      confidence: 0.7,
    };
  }

  /**
   * 按质量路由（使用更强大的模型）
   */
  private routeByQuality(
    request: ChatCompletionRequest,
    rules: { model: string; provider: string }[]
  ): RoutingDecision {
    // 检查请求长度，长请求使用更好的模型
    const totalLength = request.messages.reduce(
      (sum, m) => sum + contentToString(m.content).length,
      0
    );

    if (totalLength > 5000) {
      // 长文本，使用高质量模型
      const highQuality = rules.find(
        (r) => r.model.includes('gpt-4') || r.model.includes('claude-3-opus')
      );
      if (highQuality) {
        return {
          provider: highQuality.provider,
          model: highQuality.model,
          reason: 'high_quality_for_long_input',
          confidence: 0.9,
        };
      }
    }

    return this.routeByBalance(request, rules);
  }

  /**
   * 平衡策略（综合考虑）
   */
  private routeByBalance(
    request: ChatCompletionRequest,
    rules: { model: string; provider: string }[]
  ): RoutingDecision {
    // 检查是否明确指定了模型
    if (request.model) {
      const matchedRule = rules.find(
        (r) => r.model === request.model || request.model.startsWith(r.model)
      );
      if (matchedRule) {
        return {
          provider: matchedRule.provider,
          model: request.model,
          reason: 'explicit_model',
          confidence: 1.0,
        };
      }
    }

    // 检查是否有工具调用，选择支持 function_call 的模型
    if (request.tools && request.tools.length > 0) {
      const toolRule = rules.find((r) => {
        let caps = getModelCapabilities(r.model);
        if (!caps) {
          const provider = getProvider(r.provider);
          caps = provider?.capabilities || null;
        }
        return caps?.function_call;
      });
      if (toolRule) {
        return {
          provider: toolRule.provider,
          model: toolRule.model,
          reason: 'tools_require_function_call',
          confidence: 0.9,
        };
      }
    }

    // 默认使用平衡选择
    const balanceOrder = ['openai', 'deepseek', 'anthropic'];
    const selected = rules.find(
      (r) => r.provider === balanceOrder[0]
    ) || rules[0];

    return {
      provider: selected.provider,
      model: request.model || selected.model,
      reason: 'balanced_choice',
      confidence: 0.7,
    };
  }

  /**
   * 记录延迟
   */
  recordLatency(provider: string, latencyMs: number): void {
    if (!this.context.latency_history) {
      this.context.latency_history = {};
    }
    if (!this.context.latency_history[provider]) {
      this.context.latency_history[provider] = [];
    }

    const history = this.context.latency_history[provider];
    history.push(latencyMs);

    // 保留最近20条
    if (history.length > 20) {
      history.shift();
    }
  }

  /**
   * 记录错误
   */
  recordError(provider: string): void {
    if (!this.context.error_rate) {
      this.context.error_rate = {};
    }
    const current = this.context.error_rate[provider] || 0;
    this.context.error_rate[provider] = Math.min(1, current + 0.1);
  }

  /**
   * 获取路由器状态
   * 整合 FailoverManager 的 Provider 健康数据与 SmartRouter 的延迟/错误率数据
   */
  getStatus(): { providers: Record<string, { avg_latency?: number; error_rate?: number; isHealthy?: boolean; totalRequests?: number; avgLatencyMs?: number }> } {
    const providers: Record<string, { avg_latency?: number; error_rate?: number; isHealthy?: boolean; totalRequests?: number; avgLatencyMs?: number }> = {};

    // 1. 从 FailoverManager 获取 Provider 健康状态（isHealthy / totalRequests / errorRate / avgLatencyMs）
    const healthStatus = failoverManager.getProviderHealthStatus();
    for (const [provider, health] of Object.entries(healthStatus)) {
      providers[provider] = {
        isHealthy: health.isHealthy,
        totalRequests: health.totalRequests,
        avgLatencyMs: health.avgLatencyMs,
        avg_latency: health.avgLatencyMs,
        error_rate: health.errorRate,
      };
    }

    // 2. 叠加 SmartRouter 的 latency_history（优先使用 FailoverManager 数据，无数据时兜底）
    if (this.context.latency_history) {
      for (const [provider, history] of Object.entries(this.context.latency_history)) {
        if (history.length > 0) {
          const avg = history.reduce((a, b) => a + b, 0) / history.length;
          if (!providers[provider]) providers[provider] = {};
          providers[provider].avg_latency = Math.round(avg);
          if (providers[provider].avgLatencyMs === undefined || providers[provider].avgLatencyMs === 0) {
            providers[provider].avgLatencyMs = Math.round(avg);
          }
        }
      }
    }

    // 3. 叠加 SmartRouter 的 error_rate
    if (this.context.error_rate) {
      for (const [provider, rate] of Object.entries(this.context.error_rate)) {
        if (!providers[provider]) providers[provider] = {};
        providers[provider].error_rate = rate;
      }
    }

    return { providers };
  }
}

/**
 * 条件路由评估上下文
 */
export interface ConditionalRoutingRequest {
  model: string;
  tenant_id?: string;
  content_length?: number;
  has_tools?: boolean;
  has_vision?: boolean;
  has_reasoning?: boolean;
  has_streaming?: boolean;
  headers?: Record<string, string>;
}

/**
 * 评估条件路由规则
 * 遍历所有条件规则（按优先级降序），返回第一个匹配的决策
 */
export function evaluateConditionalRules(
  request: ConditionalRoutingRequest
): RoutingDecision | null {
  const strategyConfig = getRoutingStrategy();
  if (!strategyConfig?.conditional_rules || strategyConfig.conditional_rules.length === 0) {
    return null;
  }

  // 按优先级降序排序
  const sorted = [...strategyConfig.conditional_rules].sort(
    (a, b) => (b.priority ?? 0) - (a.priority ?? 0)
  );

  for (const rule of sorted) {
    if (evaluateCondition(rule, request)) {
      return {
        provider: rule.target.provider,
        model: rule.target.model || request.model,
        reason: `conditional_rule:${rule.name}`,
        confidence: 1.0,
      };
    }
  }

  return null;
}

/**
 * 评估单条条件
 */
function evaluateCondition(
  rule: IConditionalRoutingRule,
  request: ConditionalRoutingRequest
): boolean {
  const { field, operator, value } = rule.condition;

  // 解析 field，支持 header.* 语法
  let actualValue: unknown;
  if (field.startsWith('header.')) {
    const headerName = field.slice(7).toLowerCase();
    actualValue = request.headers?.[headerName];
  } else {
    switch (field) {
      case 'model':
        actualValue = request.model;
        break;
      case 'tenant_id':
        actualValue = request.tenant_id;
        break;
      case 'has_tools':
        actualValue = request.has_tools;
        break;
      case 'has_vision':
        actualValue = request.has_vision;
        break;
      case 'has_reasoning':
        actualValue = request.has_reasoning;
        break;
      case 'has_streaming':
        actualValue = request.has_streaming;
        break;
      case 'content_length':
        actualValue = request.content_length;
        break;
      default:
        return false;
    }
  }

  if (actualValue === undefined || actualValue === null) return false;

  switch (operator) {
    case 'eq':
      return String(actualValue) === String(value);
    case 'neq':
      return String(actualValue) !== String(value);
    case 'contains':
      return String(actualValue).includes(String(value));
    case 'gt':
      return Number(actualValue) > Number(value);
    case 'lt':
      return Number(actualValue) < Number(value);
    case 'regex':
      try {
        return new RegExp(String(value)).test(String(actualValue));
      } catch {
        return false;
      }
    default:
      return false;
  }
}

// 单例
let smartRouter = new SmartRouter();

/**
 * 重置路由器（用于测试隔离）
 */
export function resetRouter(): void {
  smartRouter = new SmartRouter();
}

/**
 * 执行智能路由
 */
export function smartRoute(
  request: ChatCompletionRequest,
  strategy?: RouterStrategy
): RoutingDecision {
  return smartRouter.route(request, strategy);
}

/**
 * 记录延迟
 */
export function recordLatency(provider: string, latencyMs: number): void {
  smartRouter.recordLatency(provider, latencyMs);
}

/**
 * 记录错误
 */
export function recordError(provider: string): void {
  smartRouter.recordError(provider);
}

/**
 * 获取路由器状态
 */
export function getRouterStatus() {
  return smartRouter.getStatus();
}

/**
 * 设置路由上下文
 */
export function setRouterContext(context: RoutingContext): void {
  smartRouter.setContext(context);
}