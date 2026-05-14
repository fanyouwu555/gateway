/**
 * 对话历史管理服务
 * 管理多轮对话的上下文
 * 支持内存/Redis 存储
 */
import type { ChatMessage, TenantId } from '../types';
import { generateRequestId } from '../utils';
import type { IKVStore } from '../stores/interface';
import { createKVStore } from '../stores/factory';

/**
 * 会话
 */
interface Session {
  id: string;
  tenant_id: TenantId;
  created_at: number;
  updated_at: number;
  messages: ChatMessage[];
  metadata?: Record<string, unknown>;
}

/**
 * 会话存储 - 支持内存和 Redis
 */
class SessionStore {
  private sessions = new Map<string, Session>();
  private readonly maxSessions: number;
  private readonly maxMessagesPerSession: number;
  private readonly sessionTtl: number; // 毫秒
  private store: IKVStore | null = null;
  private useStorage = false;

  constructor(
    maxSessions = 1000,
    maxMessagesPerSession = 100,
    sessionTtl = 3600000
  ) {
    this.maxSessions = maxSessions;
    this.maxMessagesPerSession = maxMessagesPerSession;
    this.sessionTtl = sessionTtl;

    // 初始化存储
    this.useStorage = process.env.HISTORY_STORAGE === 'redis';
    if (this.useStorage) {
      this.store = createKVStore('history');
    }
  }

  async initStorage(): Promise<void> {
    if (this.useStorage && this.store) {
      await this.store.connect();
    }
  }

  /**
   * 创建会话
   */
  create(tenantId: TenantId, metadata?: Record<string, unknown>): string {
    const sessionId = `session_${generateRequestId()}`;

    // 如果超过最大会话数，删除最早的
    if (this.sessions.size >= this.maxSessions) {
      this.evictOldest();
    }

    const now = Date.now();
    const session: Session = {
      id: sessionId,
      tenant_id: tenantId,
      created_at: now,
      updated_at: now,
      messages: [],
      metadata,
    };

    this.sessions.set(sessionId, session);
    return sessionId;
  }

  /**
   * 获取会话
   */
  get(sessionId: string): Session | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;

    // 检查过期
    if (Date.now() - session.updated_at > this.sessionTtl) {
      this.sessions.delete(sessionId);
      return null;
    }

    return session;
  }

  /**
   * 添加消息
   */
  addMessage(
    sessionId: string,
    message: ChatMessage
  ): ChatMessage[] | null {
    const session = this.get(sessionId);
    if (!session) return null;

    session.messages.push(message);
    session.updated_at = Date.now();

    // 如果超过最大消息数，删除最早的
    if (session.messages.length > this.maxMessagesPerSession) {
      session.messages = session.messages.slice(-this.maxMessagesPerSession);
    }

    return session.messages;
  }

  /**
   * 获取消息历史
   */
  getMessages(sessionId: string, limit?: number): ChatMessage[] | null {
    const session = this.get(sessionId);
    if (!session) return null;

    if (limit && limit > 0) {
      return session.messages.slice(-limit);
    }

    return [...session.messages];
  }

  /**
   * 清除会话
   */
  clear(sessionId: string): boolean {
    return this.sessions.delete(sessionId);
  }

  /**
   * 清除租户所有会话
   */
  clearTenant(tenantId: TenantId): number {
    let count = 0;
    for (const [id, session] of this.sessions.entries()) {
      if (session.tenant_id === tenantId) {
        this.sessions.delete(id);
        count++;
      }
    }
    return count;
  }

  /**
   * 删除最早的会话
   */
  private evictOldest(): void {
    let oldestId: string | null = null;
    let oldestTime = Infinity;

    for (const [id, session] of this.sessions.entries()) {
      if (session.updated_at < oldestTime) {
        oldestTime = session.updated_at;
        oldestId = id;
      }
    }

    if (oldestId) {
      this.sessions.delete(oldestId);
    }
  }

  /**
   * 清理过期会话
   */
  clean(): number {
    const now = Date.now();
    let count = 0;

    for (const [id, session] of this.sessions.entries()) {
      if (now - session.updated_at > this.sessionTtl) {
        this.sessions.delete(id);
        count++;
      }
    }

    return count;
  }

  /**
   * 获取统计
   */
  getStats(): {
    total_sessions: number;
    total_messages: number;
    by_tenant: Record<string, number>;
  } {
    let totalMessages = 0;
    const byTenant: Record<string, number> = {};

    for (const session of this.sessions.values()) {
      totalMessages += session.messages.length;
      byTenant[session.tenant_id] = (byTenant[session.tenant_id] || 0) + 1;
    }

    return {
      total_sessions: this.sessions.size,
      total_messages: totalMessages,
      by_tenant: byTenant,
    };
  }
}

// 单例
let sessionStore = new SessionStore();

/**
 * 初始化会话存储（从配置加载）
 */
export function initSessionStore(config?: {
  max_sessions?: number;
  max_messages_per_session?: number;
  ttl?: number;
}): void {
  const maxSessions = config?.max_sessions ?? 1000;
  const maxMessagesPerSession = config?.max_messages_per_session ?? 100;
  const ttl = config?.ttl ?? 3600000;
  sessionStore = new SessionStore(maxSessions, maxMessagesPerSession, ttl);
}

/**
 * 创建新会话
 */
export function createSession(
  tenantId: TenantId,
  metadata?: Record<string, unknown>
): string {
  return sessionStore.create(tenantId, metadata);
}

/**
 * 获取会话
 */
export function getSession(sessionId: string): Session | null {
  return sessionStore.get(sessionId);
}

/**
 * 添加用户消息
 */
export function addUserMessage(
  sessionId: string,
  content: string
): ChatMessage[] | null {
  return sessionStore.addMessage(sessionId, {
    role: 'user',
    content,
  });
}

/**
 * 添加助手消息
 */
export function addAssistantMessage(
  sessionId: string,
  content: string
): ChatMessage[] | null {
  return sessionStore.addMessage(sessionId, {
    role: 'assistant',
    content,
  });
}

/**
 * 获取对话历史
 */
export function getHistory(
  sessionId: string,
  limit?: number
): ChatMessage[] | null {
  return sessionStore.getMessages(sessionId, limit);
}

/**
 * 清除会话
 */
export function clearSession(sessionId: string): boolean {
  return sessionStore.clear(sessionId);
}

/**
 * 清除租户所有会话
 */
export function clearTenantSessions(tenantId: TenantId): number {
  return sessionStore.clearTenant(tenantId);
}

/**
 * 清理过期会话
 */
export function cleanSessions(): number {
  return sessionStore.clean();
}

/**
 * 获取会话统计
 */
export function getSessionStats() {
  return sessionStore.getStats();
}

/**
 * 会话管理中间件
 * 从请求中提取会话ID并注入上下文
 */
export interface SessionOptions {
  session_header?: string;
  max_history?: number;
}

export function extractSession(
  sessionId: string | null,
  maxHistory = 10
): ChatMessage[] | null {
  if (!sessionId) return null;
  return getHistory(sessionId, maxHistory);
}