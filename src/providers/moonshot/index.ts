/**
 * Moonshot (Kimi) Provider
 * API 兼容 OpenAI 协议，支持 Chat Completions、Streaming、Function Calling
 * API 文档: https://platform.moonshot.cn/docs
 */
import { OpenAICompatibleProvider } from '../openai-compatible';

export const moonshotProvider = new OpenAICompatibleProvider({
  name: 'moonshot',
  capabilities: {
    chat: true,
    embed: false,
    streaming: true,
    vision: false,
    function_call: true,
  },
  fields: {
    presencePenalty: true,
    frequencyPenalty: true,
    user: true,
    tools: true,
  },
});
