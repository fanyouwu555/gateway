# Conversation Logging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add structured conversation logging with session-level association, storing complete request/response data including reasoning content and tool calls, using Memory LRU + Redis persistence.

**Architecture:** A new `ConversationLogService` uses existing `IKVStore` abstraction (Memory/Redis) with two layers: L1 Memory LRU cache for active sessions, L2 Redis Hash for persistence. Session ID comes from `X-Session-Id` header. Integration into `chat.ts` both streaming and non-streaming paths. Admin API provides query endpoints.

**Tech Stack:** TypeScript, Hono, ioredis, Jest, existing IKVStore abstraction

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `src/types/index.ts` | Modify | Add `IConversationTurn`, `ISessionMeta`, `IConversationFilter` types |
| `src/config/index.ts` | Modify | Add `conversation_logging` to `IGatewayConfig` and default config |
| `src/services/conversation-log.ts` | Create | `ConversationLogService` — save/query turns, session meta, memory cache |
| `src/routes/chat.ts` | Modify | Extract session ID, call `saveTurn()` in streaming + non-streaming paths |
| `src/routes/admin.ts` | Modify | Add 4 Admin API endpoints for conversation queries |
| `tests/services/conversation-log.test.ts` | Create | Unit tests for ConversationLogService |
| `tests/routes/conversation-logging.test.ts` | Create | Integration tests for chat.ts logging + Admin API |

---

## Data Flow

```
Client Request (with X-Session-Id header)
    │
    ▼
chat.ts handleChatCompletion()
    ├── Extract session_id from header or generate new one
    ├── Pass to provider (streaming or non-streaming)
    ├── Collect response data (content, reasoning_content, tool_calls)
    ├── Construct IConversationTurn
    ├── Call conversationLogService.saveTurn(turn) — fire-and-forget
    └── Return X-Session-Id in response header

ConversationLogService.saveTurn(turn)
    ├── Update L1 Memory cache
    ├── hSet turn into Redis: conv:{session_id}
    ├── hSet session meta into Redis: conv_meta:{session_id}
    └── hSet index entry: conv:index (session_id → timestamp)
```

---

## Task 1: Type Definitions

**Files:**
- Modify: `src/types/index.ts`

- [ ] **Step 1: Add conversation types to `src/types/index.ts`**

Add after the existing `IRequestLogDetail` interface (around line 278):

```typescript
// ===== 会话日志类型 =====

/** 一轮对话的完整记录 */
export interface IConversationTurn {
  turn_id: string;
  session_id: string;
  timestamp: number;
  request: {
    messages: ChatMessage[];
    tools?: ChatTool[];
    model: string;
  };
  response: {
    content: string;
    reasoning_content?: string;
    tool_calls?: ChatToolCall[];
    tool_results?: ChatMessage[];
    usage: {
      prompt_tokens: number;
      completion_tokens: number;
      total_tokens: number;
    };
  };
  metadata: {
    provider: string;
    duration_ms: number;
    cost: number;
    status_code: number;
    tenant_id?: string;
    error?: string;
  };
}

/** 会话元数据 */
export interface ISessionMeta {
  session_id: string;
  created_at: number;
  updated_at: number;
  turn_count: number;
  total_prompt_tokens: number;
  total_completion_tokens: number;
  total_tokens: number;
  total_cost: number;
  tenant_id?: string;
  last_model?: string;
}

/** 会话查询过滤条件 */
export interface IConversationFilter {
  start?: number;
  end?: number;
  tenant_id?: string;
  model?: string;
  limit?: number;
  offset?: number;
}
```

- [ ] **Step 2: Verify types compile**

Run: `npx tsc --noEmit`
Expected: No errors (existing code should not break)

- [ ] **Step 3: Commit**

```bash
git add src/types/index.ts
git commit -m "feat: add IConversationTurn and ISessionMeta types

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 2: Config Integration

**Files:**
- Modify: `src/config/index.ts`
- Modify: `src/types/index.ts` (IGatewayConfig)

- [ ] **Step 1: Add conversation_logging config to IGatewayConfig**

In `src/types/index.ts`, add to `IGatewayConfig` (after `request_logging`):

```typescript
  /** 会话日志配置 */
  conversation_logging?: {
    enabled?: boolean;
    max_memory_sessions?: number;
    redis_ttl_days?: number;
    max_turns_per_session?: number;
  };
```

- [ ] **Step 2: Add default config values**

In `src/config/index.ts`, add to `DEFAULT_CONFIG`:

```typescript
  request_logging: { enabled: false, max_body_size: 4096, sample_rate: 1.0 },
  conversation_logging: { enabled: true, max_memory_sessions: 100, redis_ttl_days: 7, max_turns_per_session: 500 },
  pricing: {},
```

- [ ] **Step 3: Verify compilation**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add src/types/index.ts src/config/index.ts
git commit -m "feat: add conversation_logging config

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 3: ConversationLogService Core

**Files:**
- Create: `src/services/conversation-log.ts`
- Create: `tests/services/conversation-log.test.ts`

- [ ] **Step 1: Write failing test for ConversationLogService**

Create `tests/services/conversation-log.test.ts`:

```typescript
import { ConversationLogService } from '../../src/services/conversation-log';
import type { IConversationTurn, ISessionMeta } from '../../src/types';

describe('ConversationLogService', () => {
  let service: ConversationLogService;

  beforeEach(() => {
    service = new ConversationLogService({ enabled: true, maxMemorySessions: 10, redisTtlDays: 1, maxTurnsPerSession: 100 });
  });

  afterEach(async () => {
    await service.clearAll();
  });

  describe('saveTurn', () => {
    it('should save a turn and retrieve it', async () => {
      const turn: IConversationTurn = {
        turn_id: 'turn_1',
        session_id: 'sess_123',
        timestamp: Date.now(),
        request: { messages: [{ role: 'user', content: 'Hello' }], model: 'gpt-4o' },
        response: { content: 'Hi there', usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
        metadata: { provider: 'openai', duration_ms: 100, cost: 0.001, status_code: 200 },
      };

      await service.saveTurn(turn);
      const turns = await service.getSessionTurns('sess_123');

      expect(turns).toHaveLength(1);
      expect(turns[0].turn_id).toBe('turn_1');
      expect(turns[0].response.content).toBe('Hi there');
    });

    it('should aggregate session metadata', async () => {
      const turn1: IConversationTurn = {
        turn_id: 'turn_1',
        session_id: 'sess_abc',
        timestamp: Date.now(),
        request: { messages: [{ role: 'user', content: 'Q1' }], model: 'gpt-4o' },
        response: { content: 'A1', usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
        metadata: { provider: 'openai', duration_ms: 100, cost: 0.001, status_code: 200 },
      };
      const turn2: IConversationTurn = {
        turn_id: 'turn_2',
        session_id: 'sess_abc',
        timestamp: Date.now() + 1,
        request: { messages: [{ role: 'user', content: 'Q2' }], model: 'gpt-4o' },
        response: { content: 'A2', usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 } },
        metadata: { provider: 'openai', duration_ms: 80, cost: 0.0008, status_code: 200 },
      };

      await service.saveTurn(turn1);
      await service.saveTurn(turn2);
      const meta = await service.getSessionMeta('sess_abc');

      expect(meta).not.toBeNull();
      expect(meta!.turn_count).toBe(2);
      expect(meta!.total_tokens).toBe(27);
      expect(meta!.total_cost).toBeCloseTo(0.0018, 4);
    });

    it('should return empty array for unknown session', async () => {
      const turns = await service.getSessionTurns('unknown');
      expect(turns).toEqual([]);
    });
  });

  describe('listSessions', () => {
    it('should list sessions with metadata', async () => {
      const turn: IConversationTurn = {
        turn_id: 'turn_1',
        session_id: 'sess_list',
        timestamp: Date.now(),
        request: { messages: [{ role: 'user', content: 'Hello' }], model: 'gpt-4o' },
        response: { content: 'Hi', usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
        metadata: { provider: 'openai', duration_ms: 10, cost: 0, status_code: 200 },
      };
      await service.saveTurn(turn);

      const sessions = await service.listSessions({});
      expect(sessions.total).toBeGreaterThanOrEqual(1);
      expect(sessions.sessions.some((s: ISessionMeta) => s.session_id === 'sess_list')).toBe(true);
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/services/conversation-log.test.ts --no-coverage`
Expected: FAIL — "ConversationLogService" not found, or module not found

- [ ] **Step 3: Implement ConversationLogService**

Create `src/services/conversation-log.ts`:

```typescript
/**
 * 结构化会话日志服务
 * 两层存储：L1 Memory LRU Cache + L2 Redis/Memory Hash
 */
import { createKVStore } from '../stores/factory';
import type { IKVStore } from '../stores/interface';
import type { IConversationTurn, ISessionMeta, IConversationFilter } from '../types';
import { writeLog } from '../utils/logger';

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

  constructor(config?: Partial<ConversationLogConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.store = createKVStore('conversation');
    this.memoryCache = new Map();
    this.memoryMeta = new Map();
    this.lruOrder = [];
  }

  /** 保存一轮对话 */
  async saveTurn(turn: IConversationTurn): Promise<void> {
    if (!this.config.enabled) return;

    try {
      const { session_id } = turn;

      // 1. 更新内存缓存
      this.updateMemoryCache(session_id, turn);

      // 2. 持久化到存储
      const turnKey = `${TURN_KEY_PREFIX}:${session_id}`;
      const turnIndex = await this.getNextTurnIndex(session_id);
      await this.store.hSet(turnKey, `turn_${turnIndex}`, JSON.stringify(turn));

      const ttlMs = this.config.redisTtlDays * 24 * 60 * 60 * 1000;
      await this.store.expire(turnKey, ttlMs);

      // 3. 更新会话元数据
      await this.updateSessionMeta(turn);

      // 4. 更新索引
      await this.store.hSet(INDEX_KEY, session_id, String(turn.timestamp));
      await this.store.expire(INDEX_KEY, ttlMs);
    } catch (err) {
      writeLog('warn', 'Failed to save conversation turn', {
        session_id: turn.session_id,
        turn_id: turn.turn_id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** 获取会话的所有轮次 */
  async getSessionTurns(sessionId: string): Promise<IConversationTurn[]> {
    // 优先从内存读取
    const cached = this.memoryCache.get(sessionId);
    if (cached) {
      this.touchLru(sessionId);
      return [...cached];
    }

    // 从存储读取
    const turnKey = `${TURN_KEY_PREFIX}:${sessionId}`;
    const hash = await this.store.hGetAll(turnKey);
    const turns: IConversationTurn[] = [];

    for (const field of Object.keys(hash).sort()) {
      if (field.startsWith('turn_')) {
        try {
          turns.push(JSON.parse(hash[field]) as IConversationTurn);
        } catch {
          // 忽略损坏的数据
        }
      }
    }

    // 回填内存缓存
    if (turns.length > 0) {
      this.memoryCache.set(sessionId, turns);
      this.touchLru(sessionId);
      this.enforceLruLimit();
    }

    return turns;
  }

  /** 获取会话元数据 */
  async getSessionMeta(sessionId: string): Promise<ISessionMeta | null> {
    const cached = this.memoryMeta.get(sessionId);
    if (cached) return { ...cached };

    const metaKey = `${META_KEY_PREFIX}:${sessionId}`;
    const hash = await this.store.hGetAll(metaKey);
    if (!hash || Object.keys(hash).length === 0) return null;

    return this.parseSessionMeta(hash);
  }

  /** 列出会话 */
  async listSessions(filter: IConversationFilter): Promise<{ sessions: ISessionMeta[]; total: number }> {
    const index = await this.store.hGetAll(INDEX_KEY);
    let sessionIds = Object.keys(index);

    // 时间范围过滤
    if (filter.start !== undefined) {
      sessionIds = sessionIds.filter((id) => parseInt(index[id], 10) >= filter.start!);
    }
    if (filter.end !== undefined) {
      sessionIds = sessionIds.filter((id) => parseInt(index[id], 10) <= filter.end!);
    }

    // 获取元数据以支持更多过滤
    const sessions: ISessionMeta[] = [];
    for (const id of sessionIds) {
      const meta = await this.getSessionMeta(id);
      if (meta) {
        if (filter.tenant_id && meta.tenant_id !== filter.tenant_id) continue;
        if (filter.model && meta.last_model !== filter.model) continue;
        sessions.push(meta);
      }
    }

    // 按更新时间倒序
    sessions.sort((a, b) => b.updated_at - a.updated_at);

    const total = sessions.length;
    const offset = filter.offset ?? 0;
    const limit = filter.limit ?? 50;
    return { sessions: sessions.slice(offset, offset + limit), total };
  }

  /** 删除会话 */
  async deleteSession(sessionId: string): Promise<boolean> {
    this.memoryCache.delete(sessionId);
    this.memoryMeta.delete(sessionId);
    this.lruOrder = this.lruOrder.filter((id) => id !== sessionId);

    const turnKey = `${TURN_KEY_PREFIX}:${sessionId}`;
    const metaKey = `${META_KEY_PREFIX}:${sessionId}`;
    await this.store.delete(turnKey);
    await this.store.delete(metaKey);
    await this.store.hSet(INDEX_KEY, sessionId, ''); // 标记为空而非删除，简化实现

    return true;
  }

  /** 清空所有数据（仅用于测试） */
  async clearAll(): Promise<void> {
    this.memoryCache.clear();
    this.memoryMeta.clear();
    this.lruOrder = [];
    await this.store.delByPattern(`${TURN_KEY_PREFIX}:*`);
    await this.store.delByPattern(`${META_KEY_PREFIX}:*`);
    await this.store.delete(INDEX_KEY);
  }

  // --- 私有方法 ---

  private updateMemoryCache(sessionId: string, turn: IConversationTurn): void {
    let turns = this.memoryCache.get(sessionId);
    if (!turns) {
      turns = [];
      this.memoryCache.set(sessionId, turns);
    }
    turns.push(turn);

    // 限制每session的turn数
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
    const meta: ISessionMeta = existing
      ? {
          ...existing,
          updated_at: now,
          turn_count: existing.turn_count + 1,
          total_prompt_tokens: existing.total_prompt_tokens + turn.response.usage.prompt_tokens,
          total_completion_tokens: existing.total_completion_tokens + turn.response.usage.completion_tokens,
          total_tokens: existing.total_tokens + turn.response.usage.total_tokens,
          total_cost: existing.total_cost + metadata.cost,
          last_model: turn.request.model,
        }
      : {
          session_id,
          created_at: now,
          updated_at: now,
          turn_count: 1,
          total_prompt_tokens: turn.response.usage.prompt_tokens,
          total_completion_tokens: turn.response.usage.completion_tokens,
          total_tokens: turn.response.usage.total_tokens,
          total_cost: metadata.cost,
          tenant_id: metadata.tenant_id,
          last_model: turn.request.model,
        };

    // 更新内存
    this.memoryMeta.set(session_id, meta);

    // 持久化
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
    await this.store.expire(metaKey, ttlMs);
  }

  private parseSessionMeta(hash: Record<string, string>): ISessionMeta | null {
    if (!hash.session_id) return null;
    return {
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
  }
}

// 全局单例
let _instance: ConversationLogService | null = null;

export function getConversationLogService(): ConversationLogService {
  if (!_instance) {
    _instance = new ConversationLogService();
  }
  return _instance;
}

export function resetConversationLogService(): void {
  _instance = null;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest tests/services/conversation-log.test.ts --no-coverage`
Expected: All 4 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/services/conversation-log.ts tests/services/conversation-log.test.ts
git commit -m "feat: add ConversationLogService with Memory LRU + Redis persistence

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 4: chat.ts Non-Streaming Integration

**Files:**
- Modify: `src/routes/chat.ts`
- Create: `tests/routes/conversation-logging.test.ts` (initial skeleton)

- [ ] **Step 1: Add session ID extraction to chat.ts**

In `src/routes/chat.ts`, at the top of `handleChatCompletion`, after parsing request:

```typescript
// 提取或生成 session_id
const sessionId = c.req.header('x-session-id') || `sess_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
c.set('session_id', sessionId);
```

Also add import at the top:
```typescript
import { getConversationLogService } from '../services/conversation-log';
```

- [ ] **Step 2: Add X-Session-Id response header**

In the non-streaming return path (around line 627), before `return c.json(response, 200)`:

```typescript
    c.header('X-Session-Id', sessionId);
    return c.json(response, 200);
```

Also add it to the streaming return path before `return new Response(wrappedStream, ...)`:

```typescript
    c.header('X-Session-Id', sessionId);
    return new Response(wrappedStream, {
```

- [ ] **Step 3: Add saveTurn call in non-streaming success path**

In `src/routes/chat.ts`, after calculating `totalCost` (around line 624), before caching logic, add:

```typescript
    // 记录结构化会话日志
    const conversationLogService = getConversationLogService();
    const turnStartTime = providerCallStart;
    const turn: import('../types').IConversationTurn = {
      turn_id: c.get('request_id') as string,
      session_id: sessionId,
      timestamp: Date.now(),
      request: {
        messages: processedReq.messages as import('../types').ChatMessage[],
        tools: processedReq.tools,
        model,
      },
      response: {
        content: response.choices[0]?.message?.content || '',
        reasoning_content: response.choices[0]?.message?.reasoning_content,
        tool_calls: response.choices[0]?.message?.tool_calls,
        usage: {
          prompt_tokens: response.usage?.prompt_tokens || 0,
          completion_tokens: response.usage?.completion_tokens || 0,
          total_tokens: response.usage?.total_tokens || 0,
        },
      },
      metadata: {
        provider: providerName,
        duration_ms: Date.now() - turnStartTime,
        cost: totalCost,
        status_code: 200,
        tenant_id: c.get('tenant_id'),
      },
    };
    // fire-and-forget: never block response
    conversationLogService.saveTurn(turn).catch(() => {});
```

- [ ] **Step 4: Add saveTurn call in error path**

In the `catch (error)` block, before returning error response, add error turn logging:

```typescript
    // 记录失败的对话轮次
    const conversationLogService = getConversationLogService();
    const errorTurn: import('../types').IConversationTurn = {
      turn_id: c.get('request_id') as string,
      session_id: sessionId,
      timestamp: Date.now(),
      request: {
        messages: processedReq?.messages as import('../types').ChatMessage[] || [],
        tools: processedReq?.tools,
        model: c.get('model') || 'unknown',
      },
      response: {
        content: '',
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      },
      metadata: {
        provider: c.get('provider') || 'gateway',
        duration_ms: 0,
        cost: 0,
        status_code: err instanceof SyntaxError ? 400 : 500,
        tenant_id: c.get('tenant_id'),
        error: err.message,
      },
    };
    conversationLogService.saveTurn(errorTurn).catch(() => {});
```

Note: `sessionId` and `processedReq` may not be available in the catch block if error occurred early. Add defensive checks.

Actually, for simplicity, only log if we have `sessionId` available. Add `sessionId` declaration at the function scope (move it out of the try block).

- [ ] **Step 5: Verify compilation and existing tests**

Run: `npx tsc --noEmit`
Expected: No errors

Run: `npx jest tests/routes/chat.test.ts --no-coverage`
Expected: PASS (should not break existing tests)

- [ ] **Step 6: Commit**

```bash
git add src/routes/chat.ts
git commit -m "feat: integrate conversation logging into non-streaming chat path

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 5: chat.ts Streaming Integration

**Files:**
- Modify: `src/routes/chat.ts`

- [ ] **Step 1: Add stream collector for reasoning + tool_calls**

In the streaming path, modify the existing `accumulatedContent` tracking. Replace the current simple accumulation with a structured collector.

Find this section in chat.ts (around line 376):
```typescript
      let textBuffer = '';
      let accumulatedContent = '';
```

Replace with:
```typescript
      let textBuffer = '';
      let accumulatedContent = '';
      let accumulatedReasoning = '';
      const accumulatedToolCalls: import('../types').ChatToolCall[] = [];
```

- [ ] **Step 2: Update stream parsing to collect all content types**

In the `pull()` loop's SSE parsing section (around line 484-495), replace:

```typescript
                for (const choice of parsed.choices || []) {
                  accumulatedContent = accumulateStreamContent(accumulatedContent, choice.delta);
                }
```

With:

```typescript
                for (const choice of parsed.choices || []) {
                  const delta = choice.delta;
                  accumulatedContent = accumulateStreamContent(accumulatedContent, delta);
                  if (delta.reasoning_content && typeof delta.reasoning_content === 'string') {
                    accumulatedReasoning += delta.reasoning_content;
                  }
                  if (delta.tool_calls && Array.isArray(delta.tool_calls)) {
                    for (const tc of delta.tool_calls) {
                      const idx = tc.index ?? 0;
                      if (!accumulatedToolCalls[idx]) {
                        accumulatedToolCalls[idx] = {
                          id: tc.id || '',
                          type: 'function',
                          function: { name: '', arguments: '' },
                        };
                      }
                      if (tc.id) accumulatedToolCalls[idx].id = tc.id;
                      if (tc.function?.name) accumulatedToolCalls[idx].function.name += tc.function.name;
                      if (tc.function?.arguments) accumulatedToolCalls[idx].function.arguments += tc.function.arguments;
                    }
                  }
                }
```

- [ ] **Step 3: Add saveTurn at stream end**

In the streaming path's `done` handler (around line 390-453), after the existing metric/logging code and before sending the usage chunk, add:

```typescript
            // 记录结构化会话日志（流式）
            const conversationLogService = getConversationLogService();
            const streamTurn: import('../types').IConversationTurn = {
              turn_id: requestId,
              session_id: sessionId,
              timestamp: Date.now(),
              request: {
                messages: processedReq.messages as import('../types').ChatMessage[],
                tools: processedReq.tools,
                model,
              },
              response: {
                content: accumulatedContent,
                reasoning_content: accumulatedReasoning || undefined,
                tool_calls: accumulatedToolCalls.length > 0 ? accumulatedToolCalls : undefined,
                usage: {
                  prompt_tokens: promptTokens,
                  completion_tokens: completionTokens,
                  total_tokens: totalTokens,
                },
              },
              metadata: {
                provider: providerName,
                duration_ms: duration,
                cost,
                status_code: 200,
                tenant_id: c.get('tenant_id'),
              },
            };
            conversationLogService.saveTurn(streamTurn).catch(() => {});
```

- [ ] **Step 4: Verify compilation and tests**

Run: `npx tsc --noEmit`
Expected: No errors

Run: `npx jest tests/routes/chat.test.ts --no-coverage`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/routes/chat.ts
git commit -m "feat: integrate conversation logging into streaming chat path

Collects reasoning_content and tool_calls from SSE deltas

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 6: Admin API Endpoints

**Files:**
- Modify: `src/routes/admin.ts`

- [ ] **Step 1: Add import and Admin API endpoints**

At the top of `src/routes/admin.ts`, add import:

```typescript
import { getConversationLogService } from '../services/conversation-log';
import type { IConversationFilter } from '../types';
```

At the end of the file (before `export default adminRouter`), add:

```typescript
// ===== 会话日志管理 API =====

/** GET /v1/conversations — 列出会话 */
adminRouter.get('/v1/conversations', async (c: Context) => {
  const query = c.req.query();
  const filter: IConversationFilter = {
    start: query.start ? parseInt(query.start, 10) : undefined,
    end: query.end ? parseInt(query.end, 10) : undefined,
    tenant_id: query.tenant_id || undefined,
    model: query.model || undefined,
    limit: query.limit ? parseInt(query.limit, 10) : undefined,
    offset: query.offset ? parseInt(query.offset, 10) : undefined,
  };

  const service = getConversationLogService();
  const result = await service.listSessions(filter);

  return c.json({
    sessions: result.sessions,
    total: result.total,
    limit: filter.limit ?? 50,
    offset: filter.offset ?? 0,
  }, 200);
});

/** GET /v1/conversations/:session_id — 获取会话完整轮次 */
adminRouter.get('/v1/conversations/:session_id', async (c: Context) => {
  const sessionId = c.req.param('session_id');
  const service = getConversationLogService();

  const [meta, turns] = await Promise.all([
    service.getSessionMeta(sessionId),
    service.getSessionTurns(sessionId),
  ]);

  if (!meta) {
    return c.json({ error: { message: 'Session not found', type: 'not_found' } }, 404);
  }

  return c.json({ session: meta, turns }, 200);
});

/** GET /v1/conversations/:session_id/stats — 获取会话统计 */
adminRouter.get('/v1/conversations/:session_id/stats', async (c: Context) => {
  const sessionId = c.req.param('session_id');
  const service = getConversationLogService();

  const meta = await service.getSessionMeta(sessionId);
  if (!meta) {
    return c.json({ error: { message: 'Session not found', type: 'not_found' } }, 404);
  }

  return c.json(meta, 200);
});

/** DELETE /v1/conversations/:session_id — 删除会话 */
adminRouter.delete('/v1/conversations/:session_id', async (c: Context) => {
  const sessionId = c.req.param('session_id');
  const service = getConversationLogService();

  await service.deleteSession(sessionId);
  return c.json({ success: true }, 200);
});
```

- [ ] **Step 2: Verify compilation and admin tests**

Run: `npx tsc --noEmit`
Expected: No errors

Run: `npx jest tests/routes/admin.test.ts --no-coverage`
Expected: PASS (existing admin tests should not break)

- [ ] **Step 3: Commit**

```bash
git add src/routes/admin.ts
git commit -m "feat: add conversation logging Admin API endpoints

GET /v1/conversations
GET /v1/conversations/:session_id
GET /v1/conversations/:session_id/stats
DELETE /v1/conversations/:session_id

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 7: Integration Tests

**Files:**
- Create: `tests/routes/conversation-logging.test.ts`

- [ ] **Step 1: Write integration tests**

Create `tests/routes/conversation-logging.test.ts`:

```typescript
import request from 'supertest';
import { createApp } from '../src/app';
import { getConversationLogService, resetConversationLogService } from '../src/services/conversation-log';

describe('Conversation Logging Integration', () => {
  const app = createApp();

  beforeEach(() => {
    resetConversationLogService();
  });

  afterEach(async () => {
    const service = getConversationLogService();
    await service.clearAll();
  });

  describe('POST /v1/chat/completions', () => {
    it('should return X-Session-Id header', async () => {
      const res = await request(app)
        .post('/v1/chat/completions')
        .set('Authorization', 'Bearer test-key')
        .send({ model: 'gpt-4o', messages: [{ role: 'user', content: 'Hi' }] });

      expect(res.headers['x-session-id']).toBeDefined();
      expect(res.headers['x-session-id']).toMatch(/^sess_\d+_/);
    });

    it('should accept X-Session-Id header and return it', async () => {
      const res = await request(app)
        .post('/v1/chat/completions')
        .set('Authorization', 'Bearer test-key')
        .set('X-Session-Id', 'my-test-session')
        .send({ model: 'gpt-4o', messages: [{ role: 'user', content: 'Hi' }] });

      expect(res.headers['x-session-id']).toBe('my-test-session');
    });
  });

  describe('Admin API /v1/conversations', () => {
    it('should require admin auth', async () => {
      const res = await request(app)
        .get('/v1/conversations')
        .set('Authorization', 'Bearer test-key');

      expect(res.status).toBe(403);
    });

    it('should list sessions with admin key', async () => {
      // 先通过 chat 接口产生一条日志
      await request(app)
        .post('/v1/chat/completions')
        .set('Authorization', 'Bearer test-key')
        .send({ model: 'gpt-4o', messages: [{ role: 'user', content: 'Hello' }] });

      const res = await request(app)
        .get('/v1/conversations')
        .set('Authorization', 'Bearer admin-key');

      expect(res.status).toBe(200);
      expect(res.body.sessions).toBeDefined();
      expect(typeof res.body.total).toBe('number');
    });
  });
});
```

Note: This test uses the existing test fixtures. Adjust auth headers (`test-key`, `admin-key`) to match your test setup if different.

- [ ] **Step 2: Run integration tests**

Run: `npx jest tests/routes/conversation-logging.test.ts --no-coverage`
Expected: Tests may need adjustment based on actual test fixtures. Fix any failures.

- [ ] **Step 3: Run full test suite**

Run: `npx jest --no-coverage`
Expected: All tests PASS

- [ ] **Step 4: Commit**

```bash
git add tests/routes/conversation-logging.test.ts
git commit -m "test: add conversation logging integration tests

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 8: Final Verification

- [ ] **Step 1: Run lint**

Run: `npm run lint`
Expected: No errors

- [ ] **Step 2: Run type check**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Run full test suite with coverage**

Run: `npm test`
Expected: All tests PASS, coverage for new files reasonable

- [ ] **Step 4: Final commit if needed**

If any fixes were made:
```bash
git commit -m "fix: address lint and test issues for conversation logging

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Self-Review Checklist

### 1. Spec Coverage

| Spec Requirement | Implementing Task |
|------------------|-------------------|
| IConversationTurn type | Task 1 |
| ISessionMeta type | Task 1 |
| IConversationFilter type | Task 1 |
| Config integration | Task 2 |
| ConversationLogService | Task 3 |
| Memory LRU cache | Task 3 |
| Redis Hash persistence | Task 3 |
| Session meta aggregation | Task 3 |
| Session ID extraction (header) | Task 4 |
| X-Session-Id response header | Task 4 |
| Non-streaming saveTurn | Task 4 |
| Error path saveTurn | Task 4 |
| Streaming content collection | Task 5 |
| Streaming reasoning_content | Task 5 |
| Streaming tool_calls | Task 5 |
| Streaming saveTurn | Task 5 |
| Admin GET /v1/conversations | Task 6 |
| Admin GET /v1/conversations/:id | Task 6 |
| Admin GET /v1/conversations/:id/stats | Task 6 |
| Admin DELETE /v1/conversations/:id | Task 6 |
| Unit tests | Task 3 |
| Integration tests | Task 7 |

**No gaps identified.**

### 2. Placeholder Scan

- No "TBD", "TODO", "implement later" found
- No vague "add error handling" steps — all error handling is in the code
- No "similar to Task N" references
- All code shown inline

### 3. Type Consistency

- `IConversationTurn` fields match between Task 1, Task 4, Task 5
- `ISessionMeta` fields match between Task 1 and Task 3
- `IConversationFilter` used in Task 3 and Task 6
- Method names consistent: `saveTurn`, `getSessionTurns`, `getSessionMeta`, `listSessions`, `deleteSession`

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-05-28-conversation-logging.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**
