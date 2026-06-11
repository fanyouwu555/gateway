/**
 * Chat Completions Pipeline — 纯业务逻辑（无 Hono Context 依赖）
 *
 * 提取自 src/routes/chat.ts，将路由无关的决策逻辑集中管理，
 * 使 chat.ts 只保留 HTTP 请求/响应处理。
 */
import { resolveModelAlias, isModelPool, getModelPool, getProviderForModel } from '../config';
import { getProvider } from '../providers';
import { smartRoute, evaluateConditionalRules, type RouterStrategy } from './router';
import { writeLog } from '../utils/logger';
import { inferRequirements, getModelCapabilities, checkCapabilityMatch } from './model-capability';
import type { ChatCompletionRequest } from '../types';

/**
 * 解析并规范化请求中的模型名
 * 优先级：请求体 → API Key 默认模型 → fallbackModel
 */
const DEFAULT_MODEL_ALIAS = 'DefaultModel';

export function resolveRequestModel(
  request: Omit<ChatCompletionRequest, 'model'> & { model?: string },
  apiKeyMeta?: { default_model?: string } | undefined,
  fallbackModel?: string,
): ChatCompletionRequest {
  let resolved = request;

  // 如果请求传了 "DefaultModel"，替换为 key 的默认模型；key 无 default_model 时清空，走 fallback
  if (resolved.model === DEFAULT_MODEL_ALIAS) {
    if (apiKeyMeta?.default_model) {
      resolved = { ...resolved, model: resolveModelAlias(apiKeyMeta.default_model) };
    } else {
      resolved = { ...resolved, model: undefined };
    }
  }

  if (!resolved.model) {
    if (apiKeyMeta?.default_model) {
      resolved = { ...resolved, model: resolveModelAlias(apiKeyMeta.default_model) };
    } else if (fallbackModel) {
      resolved = { ...resolved, model: fallbackModel };
    }
  }
  if (resolved.model) {
    resolved = { ...resolved, model: resolveModelAlias(resolved.model) };
  }
  return resolved as unknown as ChatCompletionRequest;
}

interface ProviderResolution {
  provider: string;
  actualModel: string;
}

interface ProviderResolutionError {
  error: {
    message: string;
    type: 'invalid_request_error';
    code: string;
  };
  status: 400;
}

/**
 * 解析 Provider 和实际模型名
 * 优先级：模型能力池 → 条件路由规则 → 智能路由 → 静态映射
 */
export function resolveProviderForRequest(
  processedReq: ChatCompletionRequest,
  strategyHeader: RouterStrategy | undefined,
  tenantId: string | undefined,
  requestHeaders: Record<string, string>,
): ProviderResolution | ProviderResolutionError {
  const model = processedReq.model;
  const requirements = inferRequirements(processedReq);

  // 1. 优先检查模型能力池
  if (model && isModelPool(model)) {
    const pool = getModelPool(model);
    if (pool && pool.candidates && pool.candidates.length > 0) {
      let candidates = pool.candidates
        .filter((c) => c.enabled !== false)
        .sort((a, b) => a.priority - b.priority);

      if (candidates.length > 0) {
        // 能力过滤：排除不满足请求能力要求的候选
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
        // 过滤后为空时回退到全部候选（向后兼容）
        if (filtered.length > 0) {
          candidates = filtered;
        }

        const selected = candidates[0];
        writeLog('info', 'Model pool resolved', {
          pool: model,
          provider: selected.provider,
          actualModel: selected.model,
          capability_filtered: filtered.length !== candidates.length,
        });
        return { provider: selected.provider, actualModel: selected.model };
      }
    }
  }

  const contentLength = processedReq.messages.reduce(
    (sum: number, m: { content: string | unknown[] }) => sum + (m.content?.length || 0),
    0,
  );

  const conditionalDecision = evaluateConditionalRules({
    model,
    tenant_id: tenantId,
    content_length: contentLength,
    has_tools: !!(processedReq.tools && processedReq.tools.length > 0),
    has_vision: requirements.vision,
    has_reasoning: requirements.reasoning,
    has_streaming: requirements.streaming,
    headers: requestHeaders,
  });

  let providerName: string | undefined;
  let resolvedModel = model;

  if (conditionalDecision) {
    providerName = conditionalDecision.provider;
    if (conditionalDecision.model) {
      resolvedModel = conditionalDecision.model;
    }
    writeLog('info', 'Conditional rule matched', {
      model,
      provider: providerName,
      reason: conditionalDecision.reason,
    });
  } else if (strategyHeader && ['cost', 'latency', 'quality', 'balance'].includes(strategyHeader)) {
    const decision = smartRoute(processedReq, strategyHeader);
    providerName = decision.provider;
    if (decision.model) {
      resolvedModel = decision.model;
    }
    writeLog('info', 'SmartRouter selected provider', {
      model,
      provider: providerName,
      strategy: strategyHeader,
      reason: decision.reason,
    });
  } else {
    providerName = getProviderForModel(model);
  }

  if (!providerName) {
    return {
      error: {
        message: `No provider configured for model: ${model}`,
        type: 'invalid_request_error',
        code: 'unknown_model',
      },
      status: 400,
    };
  }

  return { provider: providerName, actualModel: resolvedModel };
}
