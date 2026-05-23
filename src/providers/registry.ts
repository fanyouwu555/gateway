/**
 * Provider 初始化
 * 注册所有可用的Provider (内置 + 动态配置)
 */
import { registerProvider, getProviderNames } from './index';
import type { IProvider } from '../types';
import { openaiProvider } from './openai';
import { deepseekProvider } from './deepseek';
import { anthropicProvider } from './anthropic';
import { mistralProvider } from './mistral';
import { groqProvider } from './groq';
import { googleProvider } from './google';
import { moonshotProvider } from './moonshot';
import { volcanoProvider } from './volcano';
import { kimiCodeProvider } from './kimi-code';
import { cohereProvider } from './cohere';
import { togetherProvider } from './together';
import { azureOpenAIProvider } from './azure-openai';
import { DynamicProvider } from './dynamic';
import { getConfig } from '../config';
import { writeLog } from '../utils/logger';

/**
 * 验证 Provider base_url 是否安全（防止 SSRF）
 * 拒绝内网地址、localhost、file 协议等
 */
function isValidProviderUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return false;
    }
    const hostname = parsed.hostname;
    if (hostname === 'localhost' || hostname.endsWith('.localhost')) {
      return false;
    }
    if (hostname === '0.0.0.0' || hostname.startsWith('127.')) {
      return false;
    }
    if (hostname.startsWith('10.')) {
      return false;
    }
    if (hostname.startsWith('172.')) {
      const second = parseInt(hostname.split('.')[1], 10);
      if (second >= 16 && second <= 31) return false;
    }
    if (hostname.startsWith('192.168.')) {
      return false;
    }
    if (hostname.startsWith('169.254.')) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * 估算文本的 token 数（简化版：中文 ~1.5 token/字，英文/符号 ~0.3 token/字）
 */
function estimateTokens(text: string): number {
  let tokens = 0;
  for (const char of text) {
    const code = char.charCodeAt(0);
    // CJK 统一表意文字范围（中文、日文、韩文汉字）
    if (code >= 0x4e00 && code <= 0x9fff) {
      tokens += 15; // 1.5 * 10，避免浮点
    } else if (code > 127) {
      tokens += 10; // 其他非 ASCII ~1.0 token
    } else {
      tokens += 3; // ASCII ~0.3 token
    }
  }
  return Math.ceil(tokens / 10);
}

/**
 * Mock Provider（用于本地模拟测试，不消耗真实 API Key）
 * 遍历全部 messages 计算 prompt_tokens，回复内容按实际长度算 completion_tokens
 */
const mockProvider: IProvider = {
  name: 'mock',
  capabilities: { chat: true, embed: false, streaming: false, vision: false, function_call: false },
  async chat(request) {
    // 1. 计算 prompt_tokens：所有历史消息累计
    const allText = request.messages.map((m) => `${m.role}: ${m.content}`).join('\n');
    const promptTokens = estimateTokens(allText);

    // 2. 根据最后一条用户消息生成回复
    const lastUserMsg = request.messages.filter((m) => m.role === 'user').pop();
    const userContent = lastUserMsg?.content || 'Hello';

    // 生成有意义的模拟回复（带一些长度，让 completion_tokens 可见）
    const replies: Record<string, string> = {
      '你好': '你好！很高兴见到你。我是你的 AI 助手，可以帮你解答问题、写文章、翻译、写代码等等。有什么我可以帮你的吗？',
      '天气': '今天的天气看起来不错呢！不过我没有实时联网能力，无法获取你所在地区的具体天气信息。建议你查看天气预报 App 获取准确的天气数据。',
      '代码': '当然可以！下面是一段 Python 示例代码，演示了如何读取文件内容：\n\n```python\ndef read_file(path):\n    with open(path, "r", encoding="utf-8") as f:\n        return f.read()\n\ncontent = read_file("example.txt")\nprint(content)\n```\n\n你可以根据实际需求修改这段代码。',
      '再见': '再见！如果你还有任何问题，随时都可以来找我。祝你今天愉快！👋',
    };
    let replyContent = replies['再见'];
    if (userContent.includes('你好')) {
      replyContent = replies['你好'];
    } else if (userContent.includes('天气')) {
      replyContent = replies['天气'];
    } else if (userContent.includes('代码')) {
      replyContent = replies['代码'];
    } else if (userContent.includes('再见')) {
      replyContent = replies['再见'];
    }

    // 3. 计算 completion_tokens：按回复内容实际长度
    const completionTokens = estimateTokens(replyContent);
    const totalTokens = promptTokens + completionTokens;

    return {
      id: `mock-${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: request.model,
      choices: [
        { index: 0, message: { role: 'assistant', content: replyContent }, finish_reason: 'stop' },
      ],
      usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: totalTokens },
    };
  },
  chatStream: async () => new ReadableStream(),
  embed: async () => ({
    object: 'list' as const,
    data: [],
    model: 'mock-embed',
    usage: { prompt_tokens: 0, total_tokens: 0 },
  }),
};

/**
 * 初始化所有Provider
 */
export function initProviders(): void {
  // 注册内置Provider
  registerProvider('openai', openaiProvider);
  registerProvider('deepseek', deepseekProvider);
  registerProvider('anthropic', anthropicProvider);
  registerProvider('mistral', mistralProvider);
  registerProvider('groq', groqProvider);
  registerProvider('google', googleProvider);
  registerProvider('moonshot', moonshotProvider);
  registerProvider('volcano', volcanoProvider);
  registerProvider('kimi-code', kimiCodeProvider);
  registerProvider('cohere', cohereProvider);
  registerProvider('together', togetherProvider);
  registerProvider('azure-openai', azureOpenAIProvider);

  // 注册 mock provider（仅在 MOCK_PROVIDER=1 时启用）
  if (process.env.MOCK_PROVIDER === '1') {
    registerProvider('mock', mockProvider);
    writeLog('info', 'Mock provider registered for testing');
  }

  // 注册动态Provider (从配置)
  const config = getConfig();
  if (config.dynamicProviders && config.dynamicProviders.length > 0) {
    for (const dp of config.dynamicProviders) {
      if (!isValidProviderUrl(dp.base_url)) {
        writeLog('error', 'Dynamic provider base_url rejected for SSRF safety', { name: dp.name, base_url: dp.base_url });
        continue;
      }
      const provider = new DynamicProvider(dp);
      registerProvider(dp.name, provider);
      writeLog('info', 'Registered dynamic provider', { name: dp.name });
    }
  }

  const registered = getProviderNames();
  writeLog('info', 'Provider initialization complete', {
    providers: registered,
    dynamicCount: config.dynamicProviders?.length || 0,
  });
}

export { openaiProvider, deepseekProvider, anthropicProvider, mistralProvider, groqProvider, googleProvider, moonshotProvider, volcanoProvider, kimiCodeProvider, cohereProvider, togetherProvider, azureOpenAIProvider };