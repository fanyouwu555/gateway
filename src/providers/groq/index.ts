/**
 * Groq Provider
 * API 兼容 OpenAI 协议
 */
import { OpenAICompatibleProvider } from '../openai-compatible';

export const groqProvider = new OpenAICompatibleProvider({
  name: 'groq',
  capabilities: {
    chat: true,
    embed: false,
    streaming: true,
    vision: true,
    function_call: true,
  },
  fields: {
    // Groq 支持基础参数
  },
});
