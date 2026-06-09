/**
 * Mistral AI Provider
 * API 兼容 OpenAI 协议
 */
import { OpenAICompatibleProvider } from '../openai-compatible';

export const mistralProvider = new OpenAICompatibleProvider({
  name: 'mistral',
  capabilities: {
    chat: true,
    embed: true,
    streaming: true,
    vision: true,
    function_call: true,
    reasoning: false,
  },
  fields: {
    presencePenalty: true,
    frequencyPenalty: true,
  },
});
