# Conversation Logging Design

## Overview

Add a structured conversation logging system to AI Gateway that records the complete request/response lifecycle per turn, including user messages, model reasoning/thinking content, tool calls, tool results, and final replies. Support session-level association and statistics with a hot/cold storage architecture.

## Goals

1. Record complete structured data for each chat completion request/response cycle
2. Associate multiple turns into sessions for full conversation history view
3. Maintain session-level aggregated statistics (total tokens, cost, turn count)
4. Use hybrid storage: memory hot cache + Redis warm storage + file cold archive
5. Provide Admin API for querying conversations and session statistics
6. Minimize impact on main request processing latency

## Non-Goals

- Real-time streaming playback of historical conversations
- Automatic session summarization or topic extraction
- Full-text search across conversation content
- Export to external systems (CSV, webhook) — can be added later

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         chat.ts                                  │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐      │
│  │ Non-streaming│    │ Streaming    │    │ Tool follow  │      │
│  │ (direct log) │    │ (collector)  │    │ (link turn)  │      │
│  └──────┬───────┘    └──────┬───────┘    └──────┬───────┘      │
│         └─────────────────────┼─────────────────────┘            │
│                               ▼                                  │
│                   ConversationLogService                         │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │  L1: Memory LRU Cache (Map<session_id, IConversationTurn[]>)││
│  │     max 100 sessions, O(1) lookup                          ││
│  ├─────────────────────────────────────────────────────────────┤│
│  │  L2: Redis (primary persistence, 7-day TTL)                ││
│  │     conv:{session_id} -> Hash {turn_0: json, turn_1: json} ││
│  │     conv_meta:{session_id} -> Hash<ISessionMeta>           ││
│  │     conv:index -> SortedSet {score: ts, member: session_id}││
│  └─────────────────────────────────────────────────────────────┘│
│  L3: File Archive (reserved for future, not in Phase 1)        ││
└─────────────────────────────────────────────────────────────────┘
                               │
                               ▼
                      Admin API (/v1/conversations/*)
```

## Data Model

### IConversationTurn

```typescript
export interface IConversationTurn {
  /** Unique turn identifier = request_id */
  turn_id: string;
  /** Session identifier */
  session_id: string;
  /** Unix timestamp (ms) */
  timestamp: number;
  /** Request data */
  request: {
    /** Full messages array (including context) — stored for completeness */
    messages: ChatMessage[];
    /** Available tools */
    tools?: ChatTool[];
    /** Resolved model name */
    model: string;
  };
  /** Response data */
  response: {
    /** Final assistant content */
    content: string;
    /** Reasoning/thinking content (DeepSeek R1, Kimi thinking mode, etc.) */
    reasoning_content?: string;
    /** Tool calls initiated by model */
    tool_calls?: ChatToolCall[];
    /** Tool results sent by client in follow-up requests */
    tool_results?: ChatMessage[];
    /** Token usage */
    usage: {
      prompt_tokens: number;
      completion_tokens: number;
      total_tokens: number;
    };
  };
  /** Metadata */
  metadata: {
    provider: string;
    duration_ms: number;
    cost: number;
    status_code: number;
    tenant_id?: string;
    /** Error message if request failed */
    error?: string;
  };
}
```

### ISessionMeta

```typescript
export interface ISessionMeta {
  session_id: string;
  created_at: number;
  updated_at: number;
  /** Number of turns in session */
  turn_count: number;
  total_prompt_tokens: number;
  total_completion_tokens: number;
  total_tokens: number;
  /** Total cost in USD */
  total_cost: number;
  tenant_id?: string;
  /** Last model used */
  last_model?: string;
}
```

### Session ID Resolution

1. Read `X-Session-Id` header from request
2. If present and valid (non-empty string), use it
3. Otherwise generate: `sess_${Date.now()}_${randomHex(4)}`
4. Return `X-Session-Id` in response headers so client can maintain continuity

## Storage Implementation

### L1: Memory Cache

```typescript
class MemoryConversationCache {
  private cache: Map<string, IConversationTurn[]>;
  private maxSessions: number;
  // LRU eviction when maxSessions exceeded
}
```

- Max 100 sessions
- Stores full turn arrays for active sessions
- O(1) lookup by `session_id`

### L2: Redis

```
# Conversation turns stored as Hash (avoids large List objects)
HSET conv:{session_id} turn_0 {turn_0_json} turn_1 {turn_1_json} ...
EXPIRE conv:{session_id} 604800  # 7 days

# Session metadata (Hash)
HSET conv_meta:{session_id} \
  session_id {id} \
  created_at {ts} \
  updated_at {ts} \
  turn_count {n} \
  total_prompt_tokens {n} \
  total_completion_tokens {n} \
  total_tokens {n} \
  total_cost {cost} \
  tenant_id {tid} \
  last_model {model}
EXPIRE conv_meta:{session_id} 604800

# Session index (Sorted Set for time-range queries)
ZADD conv:index {timestamp} {session_id}
EXPIRE conv:index 604800
```

### L3: File Archive (Reserved for Future)

**Not implemented in Phase 1.**

The current design relies on Redis persistence (AOF/RDB) for durability. If long-term cold storage is needed later, the `ConversationLogService` will expose an archive interface without changing consumers.

Planned approach (future):

- `logs/conversations/conv-YYYY-MM-DD.jsonl`
- `logs/conversations/conv-index.json`
- Triggered on Redis TTL expiry or graceful shutdown

## Integration in chat.ts

### Non-Streaming Path

After `runResponsePlugins` and before `recordMetric`, construct and save:

```typescript
const turn: IConversationTurn = {
  turn_id: requestId,
  session_id: sessionId,  // from header or generated
  timestamp: Date.now(),
  request: {
    messages: processedReq.messages,
    tools: processedReq.tools,
    model,
  },
  response: {
    content: response.choices[0]?.message?.content || '',
    reasoning_content: response.choices[0]?.message?.reasoning_content,
    tool_calls: response.choices[0]?.message?.tool_calls,
    usage: response.usage!,
  },
  metadata: {
    provider: providerName,
    duration_ms: Date.now() - providerCallStart,
    cost: totalCost,
    status_code: 200,
    tenant_id: c.get('tenant_id'),
  },
};
conversationLogService.saveTurn(turn);
```

### Streaming Path

Enhance `StreamCollector` to capture all content types:

```typescript
interface StreamCollector {
  content: string;
  reasoning_content: string;
  tool_calls: ChatToolCall[];
}

// In pull() loop:
for (const choice of parsed.choices || []) {
  const delta = choice.delta;
  if (delta.content) collector.content += delta.content;
  if (delta.reasoning_content) collector.reasoning_content += delta.reasoning_content;
  if (delta.tool_calls) {
    // Tool calls arrive incrementally in streaming (index, id, function.name, function.arguments)
    // Merge into collector array by index
    for (const tc of delta.tool_calls) {
      const idx = tc.index || 0;
      if (!collector.tool_calls[idx]) collector.tool_calls[idx] = { id: '', type: 'function', function: { name: '', arguments: '' } };
      if (tc.id) collector.tool_calls[idx].id = tc.id;
      if (tc.function?.name) collector.tool_calls[idx].function.name += tc.function.name;
      if (tc.function?.arguments) collector.tool_calls[idx].function.arguments += tc.function.arguments;
    }
  }
}
```

At stream end (before `controller.close()`), save turn with collected data.

### Tool Call Follow-up

When the model responds with `tool_calls` and the client later sends tool results (messages with `role: 'tool'`):

#### Option A: Inline tool_results (recommended)

- When saving the tool-results turn, look up the previous turn in the same session that contains matching `tool_call_id`
- Append the `tool` role messages to that previous turn's `response.tool_results`
- This keeps the complete tool-call round-trip in a single turn record

#### Option B: Separate turn with parent reference

- Save tool-results request as a new turn with `parent_turn_id` pointing to the turn that initiated the tool_calls
- More faithful to the actual HTTP request flow, but harder to read as a conversation

## Admin API Endpoints

| Method | Path | Description | Auth |
|--------|------|-------------|------|
| GET | `/v1/conversations` | List sessions with metadata | Admin |
| GET | `/v1/conversations/:session_id` | Get full conversation turns | Admin |
| GET | `/v1/conversations/:session_id/stats` | Get session statistics | Admin |
| DELETE | `/v1/conversations/:session_id` | Delete session and all turns | Admin |

### Query Parameters for List

- `start`, `end`: timestamp range
- `tenant_id`: filter by tenant
- `limit`, `offset`: pagination
- `model`: filter by model name

### Response Format

```typescript
// GET /v1/conversations
{
  sessions: ISessionMeta[];
  total: number;
}

// GET /v1/conversations/:session_id
{
  session: ISessionMeta;
  turns: IConversationTurn[];
}
```

## Error Handling

- `saveTurn()` failures are logged but never throw (must not affect request response)
- Redis connection failures: fall back to L1 memory only, log warning
- File I/O failures: log error, data retained in Redis until eviction

## Testing Plan

1. **Unit tests** (`tests/services/conversation-log.test.ts`):
   - Turn construction from non-streaming response
   - StreamCollector accumulation (content, reasoning, tool_calls)
   - Session metadata aggregation (incremental stats)
   - Memory cache LRU eviction

2. **Integration tests** (`tests/routes/conversation-logging.test.ts`):
   - Full request/response round trip with logging
   - Session ID header propagation
   - Tool call follow-up linking
   - Admin API CRUD

3. **Edge cases**:
   - Empty response content
   - Missing usage data
   - Failed requests (error metadata)
   - Concurrent turns on same session

## Files Changed

### New Files
- `src/services/conversation-log.ts` — ConversationLogService (Memory + Redis)
- `tests/services/conversation-log.test.ts`
- `tests/routes/conversation-logging.test.ts`

### Modified Files
- `src/types/index.ts` — Add `IConversationTurn`, `ISessionMeta`
- `src/routes/chat.ts` — Integrate logging into streaming and non-streaming paths
- `src/routes/admin.ts` — Add conversation Admin API endpoints
- `src/middleware/logger.ts` — Extract/generate session ID
- `src/config/index.ts` — Add conversation logging config section

## Config Addition

```json
{
  "conversation_logging": {
    "enabled": true,
    "max_memory_sessions": 100,
    "redis_ttl_days": 7,
    "archive_path": "logs/conversations",
    "max_turns_per_session": 500
  }
}
```

## Migration Notes

- Existing `RequestLogStore` remains unchanged (can coexist or be deprecated later)
- Conversation logging is additive — does not replace existing request logs
- Admin dashboard can display both side by side during transition
