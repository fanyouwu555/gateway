import { OpenAICompatibleProvider } from '../openai-compatible';

export const togetherProvider = new OpenAICompatibleProvider({
  name: 'together',
  capabilities: {
    chat: true,
    embed: true,
    streaming: true,
    vision: false,
    function_call: true,
    reasoning: false,
  },
});
