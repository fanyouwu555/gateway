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
    vision: false,
    function_call: true,
  },
  fields: {
    presencePenalty: true,
    frequencyPenalty: true,
  },
});
