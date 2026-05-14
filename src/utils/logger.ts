/**
 * 日志工具模块
 * 核心日志功能，不依赖任何 middleware 或其他业务模块
 * 可在任何模块中安全使用（包括 config）
 */
import { maskApiKey } from './index';

/**
 * 日志级别
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

/**
 * 获取当前日志级别
 */
export function getCurrentLogLevel(): LogLevel {
  const level = (process.env.LOG_LEVEL?.toLowerCase() || 'info') as LogLevel;
  return LOG_LEVELS[level] !== undefined ? level : 'info';
}

/**
 * 写入结构化日志 (JSON格式)
 */
export function writeLog(level: LogLevel, message: string, meta?: Record<string, unknown>): void {
  const currentLevelNum = LOG_LEVELS[getCurrentLogLevel()];
  const levelNum = LOG_LEVELS[level];
  if (levelNum < currentLevelNum) {
    return;
  }

  const logEntry = {
    timestamp: new Date().toISOString(),
    level: level.toUpperCase(),
    message,
    ...meta,
  };

  if (process.env.NODE_ENV === 'production') {
    console.log(JSON.stringify(logEntry));
  } else {
    console.log(
      `[${logEntry.timestamp}] [${logEntry.level}] ${logEntry.message}`,
      meta ? meta : ''
    );
  }
}

/**
 * 请求错误日志
 */
export function logError(requestId: string, error: Error, context?: Record<string, unknown>): void {
  writeLog('error', 'Request error', {
    request_id: requestId,
    error: error.message,
    stack: error.stack,
    ...context,
  });
}

/**
 * 敏感信息脱敏辅助函数
 */
export function sanitizeLogData(data: Record<string, unknown>): Record<string, unknown> {
  const sanitized = { ...data };
  const sensitiveKeys = ['api_key', 'authorization', 'password', 'token', 'secret'];

  for (const key of sensitiveKeys) {
    if (sanitized[key] && typeof sanitized[key] === 'string') {
      sanitized[key] = maskApiKey(sanitized[key] as string);
    }
  }

  return sanitized;
}
