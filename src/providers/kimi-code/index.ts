/**
 * Kimi Code Provider
 * API 兼容 OpenAI 协议
 * Base URL: https://api.kimi.com/coding/v1
 */
import { OpenAICompatibleProvider } from '../openai-compatible';

export const kimiCodeProvider = new OpenAICompatibleProvider({
  name: 'kimi-code',
  capabilities: {
    chat: true,
    embed: false,
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
  extraHeaders: {
    'User-Agent': 'claude-code/1.0.0',
  },
});
