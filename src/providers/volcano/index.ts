/**
 * 火山引擎 (Volcano Engine / 方舟 Coding Plan) Provider
 * API 兼容 OpenAI 协议，支持 Chat Completions、Streaming、Function Calling
 * 文档: https://www.volcengine.com/docs/82379
 */
import { OpenAICompatibleProvider } from '../openai-compatible';

export const volcanoProvider = new OpenAICompatibleProvider({
  name: 'volcano',
  capabilities: {
    chat: true,
    embed: false,
    streaming: true,
    vision: true,
    function_call: true,
    reasoning: false,
  },
  fields: {
    presencePenalty: true,
    frequencyPenalty: true,
    user: true,
    tools: true,
  },
});
