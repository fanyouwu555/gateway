/**
 * 模型能力服务
 * 提供请求能力需求推断、模型能力查询、能力匹配校验
 */
import type { ChatCompletionRequest, IProviderCapabilities } from '../types';
import { getConfig, getModelPool } from '../config';

/**
 * 请求能力需求
 */
export interface RequestCapabilityRequirements {
  vision: boolean;
  function_call: boolean;
  reasoning: boolean;
  streaming: boolean;
}

/**
 * 从请求中推断所需的能力
 * O(n) 扫描消息列表，不做 token 估算
 */
export function inferRequirements(request: ChatCompletionRequest): RequestCapabilityRequirements {
  const reqs: RequestCapabilityRequirements = {
    vision: false,
    function_call: false,
    reasoning: false,
    streaming: request.stream === true,
  };

  // 扫描消息内容检测 vision
  for (const msg of request.messages) {
    if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part.type === 'image_url') {
          reqs.vision = true;
        }
      }
    }
  }

  // 检测工具调用需求
  if (request.tools && request.tools.length > 0) {
    reqs.function_call = true;
  }

  // 从模型名推断 reasoning 需求（仅作为 hint）
  const modelHint = (request.model || '').toLowerCase();
  if (
    modelHint.includes('reason') ||
    modelHint.includes('think') ||
    modelHint.includes('o1') ||
    modelHint.includes('o3')
  ) {
    reqs.reasoning = true;
  }

  return reqs;
}

/**
 * 将模型池的能力字符串数组转换为 IProviderCapabilities 部分对象
 */
export function parsePoolCapabilities(capStrings: string[]): Partial<IProviderCapabilities> {
  const caps: Partial<IProviderCapabilities> = {};
  for (const cap of capStrings) {
    switch (cap) {
      case 'chat':
        caps.chat = true;
        break;
      case 'embed':
        caps.embed = true;
        break;
      case 'streaming':
        caps.streaming = true;
        break;
      case 'vision':
        caps.vision = true;
        break;
      case 'function_call':
        caps.function_call = true;
        break;
      case 'reasoning':
        caps.reasoning = true;
        break;
    }
  }
  return caps;
}

/**
 * 查询指定模型的能力
 * 优先级：配置中的 model_capabilities → 模型池定义 capabilities
 * 注意：此方法不查询 Provider 实例，避免循环依赖。调用方如需 Provider fallback，请自行处理。
 */
export function getModelCapabilities(modelId: string): Partial<IProviderCapabilities> | null {
  if (!modelId) return null;

  const config = getConfig();

  // 1. 检查配置中的模型能力覆盖
  if (config.model_capabilities && config.model_capabilities[modelId]) {
    return config.model_capabilities[modelId];
  }

  // 2. 检查模型池定义中的能力
  const pool = getModelPool(modelId);
  if (pool?.capabilities && pool.capabilities.length > 0) {
    return parsePoolCapabilities(pool.capabilities);
  }

  return null;
}

/**
 * 检查能力是否匹配，返回缺失的能力列表
 * 如果能力信息未知（null），返回空数组（不过滤）
 */
export function checkCapabilityMatch(
  requirements: RequestCapabilityRequirements,
  capabilities: Partial<IProviderCapabilities> | null
): string[] {
  if (!capabilities) {
    return []; // 未知能力，放行（向后兼容）
  }

  const missing: string[] = [];
  if (requirements.vision && !capabilities.vision) missing.push('vision');
  if (requirements.function_call && !capabilities.function_call) missing.push('function_call');
  if (requirements.reasoning && !capabilities.reasoning) missing.push('reasoning');
  if (requirements.streaming && !capabilities.streaming) missing.push('streaming');

  return missing;
}

/**
 * 格式化能力不匹配错误信息
 */
export function formatCapabilityError(modelId: string, missing: string[]): string {
  return (
    `Model '${modelId}' does not support required capabilities: ${missing.join(', ')}. ` +
    `Please use a model that supports these features, or remove them from your request.`
  );
}
