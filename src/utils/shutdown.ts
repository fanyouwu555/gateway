/**
 * 关闭注册表
 * 统一管理所有服务的 flush / 清理逻辑，确保优雅关闭时数据不丢失。
 */
import { writeLog } from './logger';

export interface ShutdownHandler {
  name: string;
  handler: () => Promise<void>;
}

class ShutdownRegistry {
  private handlers = new Map<string, () => Promise<void>>();

  register(name: string, handler: () => Promise<void>): void {
    this.handlers.set(name, handler);
  }

  async flushAll(): Promise<void> {
    for (const [name, handler] of this.handlers) {
      try {
        await handler();
        writeLog('info', `Flushed ${name}`);
      } catch (err) {
        writeLog('warn', `Failed to flush ${name}`, {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
}

export const shutdownRegistry = new ShutdownRegistry();
