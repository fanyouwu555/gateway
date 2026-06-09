/**
 * 结构化会话日志服务
 * 两层存储：L1 Memory LRU Cache + L2 Redis/Memory Hash
 */
import { createKVStore } from '../stores/factory';
import type { IKVStore } from '../stores/interface';
import type { IConversationTurn, ISessionMeta, IConversationFilter } from '../types';
import { writeLog } from '../utils/logger';
import { getConfig } from '../config';

export interface ConversationLogConfig {
  enabled: boolean;
  maxMemorySessions: number;
  redisTtlDays: number;
  maxTurnsPerSession: number;
}

const DEFAULT_CONFIG: ConversationLogConfig = {
  enabled: true,
  maxMemorySessions: 100,
  redisTtlDays: 7,
  maxTurnsPerSession: 500,
};

const TURN_KEY_PREFIX = 'conv';
const META_KEY_PREFIX = 'conv_meta';
const INDEX_KEY = 'conv_index';

export class ConversationLogService {
  private store: IKVStore;
  private config: ConversationLogConfig;
  private memoryCache: Map<string, IConversationTurn[]>;
  private memoryMeta: Map<string, ISessionMeta>;
  private lruOrder: string[];
  private writeLocks: Map<string, Promise<void>>;

  constructor(config?: Partial<ConversationLogConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.store = createKVStore('conversation');
    this.memoryCache = new Map();
    this.memoryMeta = new Map();
    this.lruOrder = [];
    this.writeLocks = new Map();
  }

  async saveTurn(turn: IConversationTurn): Promise<void> {
    const { session_id } = turn;
    // Chain writes for the same session to prevent race conditions
    const currentLock = this.writeLocks.get(session_id);
    const newLock = (async () => {
      if (currentLock) await currentLock;
      try {
        if (!this.config.enabled) return;
        this.updateMemoryCache(session_id, turn);
        const turnKey = `${TURN_KEY_PREFIX}:${session_id}`;
        const turnIndex = await this.getNextTurnIndex(session_id);
        await this.store.hSet(turnKey, `turn_${turnIndex}`, JSON.stringify(turn));
        const ttlMs = this.config.redisTtlDays * 24 * 60 * 60 * 1000;
        await this.store.expire(turnKey, ttlMs);
        await this.updateSessionMeta(turn);
        await this.store.hSet(INDEX_KEY, session_id, String(turn.timestamp));
        await this.store.expire(INDEX_KEY, ttlMs);
      } catch (err) {
        writeLog('warn', 'Failed to save conversation turn', {
          session_id: turn.session_id,
          turn_id: turn.turn_id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    })();
    this.writeLocks.set(session_id, newLock);
    try {
      await newLock;
    } finally {
      // Clean up lock if no one else queued behind us
      if (this.writeLocks.get(session_id) === newLock) {
        this.writeLocks.delete(session_id);
      }
    }
  }

  async getSessionTurns(sessionId: string): Promise<IConversationTurn[]> {
    const cached = this.memoryCache.get(sessionId);
    if (cached) {
      this.touchLru(sessionId);
      return [...cached];
    }
    const turnKey = `${TURN_KEY_PREFIX}:${sessionId}`;
    const hash = await this.store.hGetAll(turnKey);
    const turns: IConversationTurn[] = [];
    for (const field of Object.keys(hash).sort()) {
      if (field.startsWith('turn_')) {
        try {
          turns.push(JSON.parse(hash[field]) as IConversationTurn);
        } catch {
          // ignore corrupted data
        }
      }
    }
    if (turns.length > 0) {
      this.memoryCache.set(sessionId, turns);
      this.touchLru(sessionId);
      this.enforceLruLimit();
    }
    return turns;
  }

  async getSessionMeta(sessionId: string): Promise<ISessionMeta | null> {
    const cached = this.memoryMeta.get(sessionId);
    if (cached) return { ...cached };
    const metaKey = `${META_KEY_PREFIX}:${sessionId}`;
    const hash = await this.store.hGetAll(metaKey);
    if (!hash || Object.keys(hash).length === 0) return null;
    return this.parseSessionMeta(hash);
  }

  async listSessions(filter: IConversationFilter): Promise<{ sessions: ISessionMeta[]; total: number }> {
    const index = await this.store.hGetAll(INDEX_KEY);
    let sessionIds = Object.keys(index);
    if (filter.start !== undefined) {
      sessionIds = sessionIds.filter((id) => parseInt(index[id], 10) >= filter.start!);
    }
    if (filter.end !== undefined) {
      sessionIds = sessionIds.filter((id) => parseInt(index[id], 10) <= filter.end!);
    }
    if (filter.session_id) {
      sessionIds = sessionIds.filter((id) => id === filter.session_id);
    }
    const sessions: ISessionMeta[] = [];
    for (const id of sessionIds) {
      const meta = await this.getSessionMeta(id);
      if (meta) {
        if (filter.tenant_id && meta.tenant_id !== filter.tenant_id) continue;
        if (filter.model && meta.last_model !== filter.model) continue;
        if (filter.client && meta.client_info?.name !== filter.client) continue;
        sessions.push(meta);
      }
    }
    sessions.sort((a, b) => b.updated_at - a.updated_at);
    const total = sessions.length;
    const offset = filter.offset ?? 0;
    const limit = filter.limit ?? 50;
    return { sessions: sessions.slice(offset, offset + limit), total };
  }

  async deleteSession(sessionId: string): Promise<boolean> {
    this.memoryCache.delete(sessionId);
    this.memoryMeta.delete(sessionId);
    this.lruOrder = this.lruOrder.filter((id) => id !== sessionId);
    const turnKey = `${TURN_KEY_PREFIX}:${sessionId}`;
    const metaKey = `${META_KEY_PREFIX}:${sessionId}`;
    // MemoryKVStore delete() only clears cache, not hashes — use hDel to clear hash fields
    const turnHash = await this.store.hGetAll(turnKey);
    if (Object.keys(turnHash).length > 0) {
      await this.store.hDel(turnKey, ...Object.keys(turnHash));
    }
    const metaHash = await this.store.hGetAll(metaKey);
    if (Object.keys(metaHash).length > 0) {
      await this.store.hDel(metaKey, ...Object.keys(metaHash));
    }
    await this.store.hDel(INDEX_KEY, sessionId);
    return true;
  }

  async clearAll(): Promise<void> {
    this.memoryCache.clear();
    this.memoryMeta.clear();
    this.lruOrder = [];
    await this.store.delByPattern(`${TURN_KEY_PREFIX}:*`);
    await this.store.delByPattern(`${META_KEY_PREFIX}:*`);
    await this.store.delete(INDEX_KEY);
  }

  private updateMemoryCache(sessionId: string, turn: IConversationTurn): void {
    let turns = this.memoryCache.get(sessionId);
    if (!turns) {
      turns = [];
      this.memoryCache.set(sessionId, turns);
    }
    turns.push(turn);
    if (turns.length > this.config.maxTurnsPerSession) {
      turns.shift();
    }
    this.touchLru(sessionId);
    this.enforceLruLimit();
  }

  private touchLru(sessionId: string): void {
    this.lruOrder = this.lruOrder.filter((id) => id !== sessionId);
    this.lruOrder.push(sessionId);
  }

  private enforceLruLimit(): void {
    while (this.lruOrder.length > this.config.maxMemorySessions) {
      const oldest = this.lruOrder.shift();
      if (oldest) {
        this.memoryCache.delete(oldest);
        this.memoryMeta.delete(oldest);
      }
    }
  }

  private async getNextTurnIndex(sessionId: string): Promise<number> {
    const turnKey = `${TURN_KEY_PREFIX}:${sessionId}`;
    const hash = await this.store.hGetAll(turnKey);
    const indices = Object.keys(hash)
      .filter((k) => k.startsWith('turn_'))
      .map((k) => parseInt(k.replace('turn_', ''), 10));
    return indices.length > 0 ? Math.max(...indices) + 1 : 0;
  }

  private async updateSessionMeta(turn: IConversationTurn): Promise<void> {
    const { session_id, metadata } = turn;
    const existing = await this.getSessionMeta(session_id);
    const now = Date.now();
    const usage = turn.response.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
    const meta: ISessionMeta = existing
      ? {
          ...existing,
          updated_at: now,
          turn_count: existing.turn_count + 1,
          total_prompt_tokens: existing.total_prompt_tokens + (usage.prompt_tokens || 0),
          total_completion_tokens: existing.total_completion_tokens + (usage.completion_tokens || 0),
          total_tokens: existing.total_tokens + (usage.total_tokens || 0),
          total_cost: existing.total_cost + (Number.isFinite(metadata.cost) ? metadata.cost! : 0),
          last_model: turn.request.model,
        }
      : {
          session_id,
          created_at: now,
          updated_at: now,
          turn_count: 1,
          total_prompt_tokens: usage.prompt_tokens || 0,
          total_completion_tokens: usage.completion_tokens || 0,
          total_tokens: usage.total_tokens || 0,
          total_cost: Number.isFinite(metadata.cost) ? metadata.cost! : 0,
          tenant_id: metadata.tenant_id,
          last_model: turn.request.model,
          client_info: metadata.client_info,
          user_agent: metadata.user_agent,
        };
    this.memoryMeta.set(session_id, meta);
    const metaKey = `${META_KEY_PREFIX}:${session_id}`;
    const ttlMs = this.config.redisTtlDays * 24 * 60 * 60 * 1000;
    await this.store.hSet(metaKey, 'session_id', meta.session_id);
    await this.store.hSet(metaKey, 'created_at', String(meta.created_at));
    await this.store.hSet(metaKey, 'updated_at', String(meta.updated_at));
    await this.store.hSet(metaKey, 'turn_count', String(meta.turn_count));
    await this.store.hSet(metaKey, 'total_prompt_tokens', String(meta.total_prompt_tokens));
    await this.store.hSet(metaKey, 'total_completion_tokens', String(meta.total_completion_tokens));
    await this.store.hSet(metaKey, 'total_tokens', String(meta.total_tokens));
    await this.store.hSet(metaKey, 'total_cost', String(meta.total_cost));
    if (meta.tenant_id) await this.store.hSet(metaKey, 'tenant_id', meta.tenant_id);
    if (meta.last_model) await this.store.hSet(metaKey, 'last_model', meta.last_model);
    if (meta.client_info) {
      await this.store.hSet(metaKey, 'client_info_name', meta.client_info.name);
      if (meta.client_info.version) await this.store.hSet(metaKey, 'client_info_version', meta.client_info.version);
      await this.store.hSet(metaKey, 'client_info_inferred_from', meta.client_info.inferred_from);
    }
    if (meta.user_agent) await this.store.hSet(metaKey, 'user_agent', meta.user_agent);
    await this.store.expire(metaKey, ttlMs);
  }

  private parseSessionMeta(hash: Record<string, string>): ISessionMeta | null {
    if (!hash.session_id) return null;
    const meta: ISessionMeta = {
      session_id: hash.session_id,
      created_at: parseInt(hash.created_at, 10) || 0,
      updated_at: parseInt(hash.updated_at, 10) || 0,
      turn_count: parseInt(hash.turn_count, 10) || 0,
      total_prompt_tokens: parseInt(hash.total_prompt_tokens, 10) || 0,
      total_completion_tokens: parseInt(hash.total_completion_tokens, 10) || 0,
      total_tokens: parseInt(hash.total_tokens, 10) || 0,
      total_cost: parseFloat(hash.total_cost) || 0,
      tenant_id: hash.tenant_id || undefined,
      last_model: hash.last_model || undefined,
    };
    if (hash.client_info_name) {
      meta.client_info = {
        name: hash.client_info_name,
        version: hash.client_info_version || undefined,
        inferred_from: (hash.client_info_inferred_from as 'header' | 'user-agent' | 'unknown') || 'unknown',
      };
    }
    if (hash.user_agent) {
      meta.user_agent = hash.user_agent;
    }
    return meta;
  }
}

let _instance: ConversationLogService | null = null;

export function getConversationLogService(): ConversationLogService {
  if (!_instance) {
    const cfg = getConfig().conversation_logging;
    _instance = new ConversationLogService({
      enabled: cfg?.enabled ?? DEFAULT_CONFIG.enabled,
      maxMemorySessions: cfg?.max_memory_sessions ?? DEFAULT_CONFIG.maxMemorySessions,
      redisTtlDays: cfg?.redis_ttl_days ?? DEFAULT_CONFIG.redisTtlDays,
      maxTurnsPerSession: cfg?.max_turns_per_session ?? DEFAULT_CONFIG.maxTurnsPerSession,
    });
  }
  return _instance;
}

export function resetConversationLogService(): void {
  _instance = null;
}
