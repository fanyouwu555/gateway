/**
 * OpenAI Provider
 * API 完全兼容 OpenAI 协议
 */
import { OpenAICompatibleProvider } from '../openai-compatible';

export const openaiProvider = new OpenAICompatibleProvider({
  name: 'openai',
  capabilities: {
    chat: true,
    embed: true,
    streaming: true,
    vision: true,
    function_call: true,
  },
  fields: {
    presencePenalty: true,
    frequencyPenalty: true,
    user: true,
    tools: true,
  },
});
