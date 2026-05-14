/**
 * 重试服务
 * 为 Provider 调用提供指数退避重试机制
 */
import { writeLog } from '../middleware/logger';

/**
 * 重试选项
 */
export interface RetryOptions {
  maxRetries?: number;
  baseDelay?: number; // 毫秒
  maxDelay?: number; // 毫秒
}

/**
 * 计算退避延迟（指数退避 + 随机抖动）
 */
export function calculateBackoff(
  attempt: number,
  baseDelay: number = 1000,
  maxDelay: number = 10000
): number {
  const delay = Math.min(baseDelay * Math.pow(2, attempt), maxDelay);
  // 添加 ±500ms 随机抖动
  return delay + (Math.random() - 0.5) * 1000;
}

/**
 * 判断错误是否可重试（仅 5xx 和网络错误）
 */
export function isRetryableError(error: unknown): boolean {
  if (error instanceof Response) {
    return error.status >= 500;
  }
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    return (
      msg.includes('econnrefused') ||
      msg.includes('econnreset') ||
      msg.includes('enotfound') ||
      msg.includes('timeout') ||
      msg.includes('timed out') ||
      msg.includes('5xx') ||
      msg.includes('network') ||
      msg.includes('socket')
    );
  }
  return false;
}

/**
 * 带重试的异步函数执行
 * 仅在 5xx 或网络错误时重试
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options?: RetryOptions
): Promise<T> {
  const maxRetries = options?.maxRetries ?? 3;
  const baseDelay = options?.baseDelay ?? 1000;
  const maxDelay = options?.maxDelay ?? 10000;

  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      if (!isRetryableError(error) || attempt >= maxRetries) {
        throw error;
      }

      const delay = calculateBackoff(attempt, baseDelay, maxDelay);
      writeLog('warn', 'Retry attempt failed, will retry', {
        attempt: attempt + 1,
        max_retries: maxRetries,
        delay_ms: Math.round(delay),
        error: error instanceof Error ? error.message : String(error),
      });
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastError;
}
