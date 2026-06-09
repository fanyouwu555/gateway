import { OpenAICompatibleProvider } from '../openai-compatible';

export const cohereProvider = new OpenAICompatibleProvider({
  name: 'cohere',
  capabilities: {
    chat: true,
    embed: true,
    streaming: true,
    vision: false,
    function_call: true,
    reasoning: false,
  },
});
