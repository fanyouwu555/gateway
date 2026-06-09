import { OpenAICompatibleProvider } from '../openai-compatible';

export const xaiProvider = new OpenAICompatibleProvider({
  name: 'xai',
  capabilities: {
    chat: true,
    embed: true,
    streaming: true,
    vision: true,
    function_call: true,
    reasoning: false,
  },
});
