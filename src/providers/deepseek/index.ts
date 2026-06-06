/**
 * DeepSeek Provider
 * API 兼容 OpenAI 协议
 */
import { OpenAICompatibleProvider } from '../openai-compatible';

export const deepseekProvider = new OpenAICompatibleProvider({
  name: 'deepseek',
  capabilities: {
    chat: true,
    embed: true,
    streaming: true,
    vision: false,
    function_call: false,
  },
  fields: {
    // DeepSeek 支持基础参数，无需特殊字段
  },
});
