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
    vision: false,
    function_call: false,
  },
  fields: {
    // Groq 支持基础参数
  },
});
