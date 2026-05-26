/**
 * Token 计数服务
 * 使用 tiktoken 进行本地 token 计数，作为 Provider API 返回的补充和校验
 * 当 Provider 未返回 usage 时，使用本地计数作为降级方案
 */
import type { ChatContentPart, ChatMessage } from '../types';

/**
 * 从流式响应的 delta 内容中提取出完整文本
 * delta 的 content 在流式场景中始终为 string
 */
export function accumulateStreamContent(
  previous: string,
  delta: { content?: string | ChatContentPart[]; role?: string } | undefined,
): string {
  if (!delta || !delta.content) return previous;
  if (typeof delta.content !== 'string') return previous;
  return previous + delta.content;
}

/** 提取消息内容的纯文本（处理 string 和 ChatContentPart[] 两种格式） */
function extractTextFromContent(content: string | ChatContentPart[] | null | undefined): string {
  if (!content) return '';
  if (typeof content === 'string') return content;
  return content
    .filter((part): part is ChatContentPart & { type: 'text' } => part.type === 'text')
    .map((part) => part.text)
    .join(' ');
}

// tiktoken 类型定义
interface Tiktoken {
  encode_ordinary(text: string): Uint32Array;
  free(): void;
  readonly name: string | undefined;
}

type TiktokenEncoding = 'gpt2' | 'r50k_base' | 'p50k_base' | 'p50k_edit' | 'cl100k_base' | 'o200k_base';

let tiktokenModule: {
  get_encoding: (encoding: TiktokenEncoding) => Tiktoken;
  encoding_for_model: (model: string) => Tiktoken;
} | null = null;

let loadAttempted = false;

/**
 * 尝试加载 tiktoken（懒加载）
 * 如果 wasm 加载失败，返回 null，后续使用字符估算降级
 */
async function loadTiktoken(): Promise<typeof tiktokenModule> {
  if (tiktokenModule) return tiktokenModule;
  if (loadAttempted) return null;
  loadAttempted = true;
  try {
    // 动态导入 tiktoken（wasm 在 node 环境中自动初始化）
    const mod = await import('@dqbd/tiktoken');
    tiktokenModule = mod as unknown as typeof tiktokenModule;
    return tiktokenModule;
  } catch (e) {
    console.warn('[TokenCounter] Failed to load tiktoken, falling back to estimation:', e);
    return null;
  }
}

/**
 * 根据模型名称获取对应的 encoding
 * 未知模型回退到 cl100k_base
 */
function getEncodingName(model: string): TiktokenEncoding {
  const modelLower = model.toLowerCase();
  // o200k_base: gpt-4o, o1, o3 系列
  if (
    modelLower.startsWith('gpt-4o') ||
    modelLower.startsWith('gpt-4.') ||
    modelLower.startsWith('gpt-5') ||
    modelLower.startsWith('o1') ||
    modelLower.startsWith('o3') ||
    modelLower.startsWith('o4') ||
    modelLower === 'chatgpt-4o-latest'
  ) {
    return 'o200k_base';
  }
  // cl100k_base: gpt-4, gpt-3.5-turbo, text-embedding-ada-002
  if (
    modelLower.startsWith('gpt-4') ||
    modelLower.startsWith('gpt-3.5') ||
    modelLower.startsWith('gpt-35') ||
    modelLower.startsWith('text-embedding') ||
    modelLower.startsWith('text-davinci')
  ) {
    return 'cl100k_base';
  }
  // 默认使用 cl100k_base（最通用的编码）
  return 'cl100k_base';
}

/**
 * 获取 Tiktoken 编码器（同步，可能返回 null）
 */
function getTiktoken(model: string): Tiktoken | null {
  if (!tiktokenModule) return null;
  try {
    return tiktokenModule.encoding_for_model(model);
  } catch {
    // model 不在已知列表中，使用 encoding name 回退
    try {
      return tiktokenModule.get_encoding(getEncodingName(model));
    } catch {
      return null;
    }
  }
}

// 每个消息的固定开销（token 数）
const MESSAGE_OVERHEAD = 3; // <|im_start|>role\ncontent\n<|im_end|>
const ROLE_OVERHEAD = 1; // role name 的近似 token 数

/**
 * 估算文本的 token 数（不使用 tiktoken 的字符级估算）
 */
function estimateTokens(text: string): number {
  let tokens = 0;
  for (const char of text) {
    const code = char.charCodeAt(0);
    if (code >= 0x4e00 && code <= 0x9fff) {
      tokens += 15; // CJK ~1.5 token
    } else if (code > 127) {
      tokens += 10; // 其他非 ASCII ~1.0 token
    } else {
      tokens += 3; // ASCII ~0.3 token
    }
  }
  return Math.ceil(tokens / 10);
}

/**
 * 计算 prompt 消息列表的 token 数
 * 优先使用 tiktoken，降级到字符级估算
 */
export async function countPromptTokens(
  messages: ChatMessage[],
  model: string,
): Promise<number> {
  await loadTiktoken();
  const enc = getTiktoken(model);

  let total = 0;
  for (const msg of messages) {
    total += MESSAGE_OVERHEAD;
    if (enc) {
      total += enc.encode_ordinary(msg.role).length;
    } else {
      total += ROLE_OVERHEAD;
    }
    const contentText = extractTextFromContent(msg.content);
    if (contentText) {
      total += enc ? enc.encode_ordinary(contentText).length : estimateTokens(contentText);
    }
    if (msg.tool_calls && enc) {
      for (const tc of msg.tool_calls) {
        total += enc.encode_ordinary(tc.function?.name || '').length;
        total += enc.encode_ordinary(tc.function?.arguments || '').length;
      }
    }
  }

  // assistant 回复前缀
  total += MESSAGE_OVERHEAD;

  if (enc) enc.free();
  return total;
}

/**
 * 计算 completion 文本的 token 数
 * 优先使用 tiktoken，降级到字符级估算
 */
export async function countCompletionTokens(
  text: string,
  model: string,
): Promise<number> {
  await loadTiktoken();
  const enc = getTiktoken(model);

  if (!text) return 0;

  if (enc) {
    try {
      const count = enc.encode_ordinary(text).length;
      enc.free();
      return count;
    } catch {
      enc.free();
      return estimateTokens(text);
    }
  }
  return estimateTokens(text);
}

/**
 * 计算总 token 数（prompt + completion）
 */
export async function countTotalTokens(
  messages: ChatMessage[],
  completionText: string,
  model: string,
): Promise<number> {
  const prompt = await countPromptTokens(messages, model);
  const completion = await countCompletionTokens(completionText, model);
  return prompt + completion;
}