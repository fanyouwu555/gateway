/**
 * 日志工具模块
 * 核心日志功能，不依赖任何 middleware 或其他业务模块
 * 可在任何模块中安全使用（包括 config）
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'fs';
import { join } from 'path';
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

const LOG_RETENTION_DAYS = 7;

function getLogDir(): string {
  return process.env.LOG_DIR || './logs';
}

function getSampleRate(): number {
  const rate = parseFloat(process.env.LOG_SAMPLE_RATE || '1.0');
  if (Number.isNaN(rate)) return 1.0;
  return rate;
}

function shouldLog(level: LogLevel): boolean {
  // Error and warn are always logged
  if (level === 'error' || level === 'warn') {
    return true;
  }
  // info/debug are sampled
  const sampleRate = getSampleRate();
  if (sampleRate >= 1) {
    return true;
  }
  if (sampleRate <= 0) {
    return false;
  }
  return Math.random() < sampleRate;
}

let currentLogFile = '';
let currentLogDate = '';
let currentLogDir = '';

/**
 * 确保日志目录存在
 */
function ensureLogDir(): void {
  const dir = getLogDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

/**
 * 获取今天的日志文件名
 */
function getLogFileName(): string {
  const date = new Date().toISOString().slice(0, 10);
  const dir = getLogDir();
  if (date !== currentLogDate || dir !== currentLogDir) {
    currentLogDate = date;
    currentLogDir = dir;
    currentLogFile = join(dir, `ai-gateway-${date}.log`);
    ensureLogDir();
  }
  return currentLogFile;
}

/**
 * 清理过期日志文件
 */
function cleanOldLogs(): void {
  try {
    const dir = getLogDir();
    if (!existsSync(dir)) return;
    const now = Date.now();
    const retentionMs = LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000;

    for (const file of readdirSync(dir)) {
      if (!file.startsWith('ai-gateway-') || !file.endsWith('.log')) continue;
      const filePath = join(dir, file);
      const stats = statSync(filePath);
      if (now - stats.mtime.getTime() > retentionMs) {
        unlinkSync(filePath);
      }
    }
  } catch {
    // 清理失败不影响主流程
  }
}

// 启动时清理一次过期日志
cleanOldLogs();

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

  if (!shouldLog(level)) {
    return;
  }

  const logEntry = {
    timestamp: new Date().toISOString(),
    level: level.toUpperCase(),
    message,
    ...meta,
  };

  const line = JSON.stringify(logEntry);

  if (process.env.NODE_ENV === 'production') {
    console.log(line);
  } else {
    console.log(
      `[${logEntry.timestamp}] [${logEntry.level}] ${logEntry.message}`,
      meta ? meta : ''
    );
  }

  // 写入文件（同步写入保证不丢失，生产环境可改用异步）
  try {
    const logFile = getLogFileName();
    appendFileSync(logFile, line + '\n', { encoding: 'utf-8' });
  } catch {
    // 文件写入失败不影响 console 输出
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
