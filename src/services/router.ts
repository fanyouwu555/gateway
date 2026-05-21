/**
 * 智能路由服务
 * 根据请求特征自动选择最优Provider
 */
import type { ChatCompletionRequest, IRoutingStrategy } from '../types';
import { getRoutingStrategy, getConfig } from '../config';

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
      (sum, m) => sum + m.content.length,
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

    // 检查是否有工具调用
    if (request.tools && request.tools.length > 0) {
      const toolRule = rules.find(
        (r) => r.model.includes('gpt-4') || r.model.includes('claude')
      );
      if (toolRule) {
        return {
          provider: toolRule.provider,
          model: toolRule.model,
          reason: 'tools_require_high_quality',
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
   */
  getStatus(): { providers: Record<string, { avg_latency?: number; error_rate?: number }> } {
    const providers: Record<string, { avg_latency?: number; error_rate?: number }> = {};

    if (this.context.latency_history) {
      for (const [provider, history] of Object.entries(this.context.latency_history)) {
        if (history.length > 0) {
          const avg = history.reduce((a, b) => a + b, 0) / history.length;
          providers[provider] = { avg_latency: Math.round(avg) };
        }
      }
    }

    if (this.context.error_rate) {
      for (const [provider, rate] of Object.entries(this.context.error_rate)) {
        if (!providers[provider]) providers[provider] = {};
        providers[provider].error_rate = rate;
      }
    }

    return { providers };
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