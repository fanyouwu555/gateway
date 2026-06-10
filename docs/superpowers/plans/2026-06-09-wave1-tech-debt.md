# Wave 1: 技术债修复实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 修复三个高优先级技术债：Redis Vector 语义缓存后端、审计日志 Admin API、虚拟 Key 策略前端管理。

**Architecture:** 
- Redis Vector Store: 使用 Redis Hash 持久化向量数据，加载到内存后执行余弦相似度搜索（数据持久化 + 多实例共享，搜索逻辑复用 MemoryVectorStore）
- 审计日志 API: 读取 JSON Lines 文件，支持时间范围过滤和分页
- 虚拟 Key 前端: 在现有 Tenant Key 管理中扩展策略编辑表单

**Tech Stack:** TypeScript, Hono, ioredis, React, Ant Design

---

## 方案合理性反思

### 1. Redis Vector Store — 为什么不用 RediSearch?

**考量：**
- RediSearch 需要 Redis Stack，不是标准 Redis 的默认模块
- 项目当前依赖的是标准 Redis (`ioredis`)，引入 RediSearch 会增加部署复杂度
- 语义缓存的向量维度由 Embedding 服务决定（通常是 768-3072 维），在 10000 条记录以内，内存搜索性能足够
- **方案选择**：用 Redis Hash 做持久化存储，加载到内存后搜索。这样多实例共享缓存数据，搜索时从 Redis 加载到本地内存执行余弦相似度。简单、可靠、无需额外依赖。

**风险：** 如果缓存条目增长到 10 万+，加载时间会显著增加。缓解措施：设置 max_entries 上限，超出时按 LRU 淘汰。

### 2. 审计日志 API — 为什么不用数据库存储?

**考量：**
- 当前审计日志是 JSON Lines 文件，已有文件结构
- 文件存储满足合规要求（不可篡改、按天归档）
- 查询频率低（管理后台人工查询），文件扫描足够
- **方案选择**：直接读取日志文件，支持按时间范围、tenant_id、event_type 过滤，分页返回。

**风险：** 日志量大时查询慢。缓解措施：限制查询范围为 7 天内，限制每页最大 500 条。

### 3. 虚拟 Key 策略前端 — 为什么扩展 Tenant Key 页面而不是独立页面?

**考量：**
- 虚拟 Key 策略本质上是 API Key 的属性（rate_limit_qps, allowed_models, monthly_budget 等）
- 现有 `PUT /v1/tenants/:id/keys/:keyHash` 已支持更新这些字段
- 在 Tenant 详情的 Key 列表中添加"编辑策略"操作最符合用户心智模型
- **方案选择**：在 `ai-gateway-admin/src/pages/Tenants/` 中扩展 Key 管理抽屉，增加策略编辑表单。

---

## 文件结构

### Task 1: Redis Vector Store
- **Create**: `src/stores/redis-vector.ts` — Redis-backed vector store implementing `IVectorStore`
- **Modify**: `src/services/semantic-cache.ts:102` — select backend based on config
- **Modify**: `src/stores/factory.ts` — add `createVectorStore()` method
- **Test**: `tests/stores/redis-vector.test.ts`

### Task 2: 审计日志 Admin API
- **Modify**: `src/utils/audit.ts` — add `readAuditLogs()` function
- **Create**: `src/routes/admin/audit.ts` — Admin router for audit logs
- **Modify**: `src/routes/admin/index.ts` — register audit router
- **Test**: `tests/routes/admin-audit.test.ts`

### Task 3: 虚拟 Key 策略前端
- **Modify**: `ai-gateway-admin/src/pages/Tenants/index.tsx` — add policy edit modal
- **Modify**: `ai-gateway-admin/src/services/api.ts` — add `updateKeyPolicy` API function
- **Verify**: `pnpm tsc --noEmit` in admin directory

---

## Task 1: Redis Vector Store

### Step 1: Write the failing test

**File:** `tests/stores/redis-vector.test.ts`

```typescript
import { RedisVectorStore } from '../../src/stores/redis-vector';

describe('RedisVectorStore', () => {
  let store: RedisVectorStore;

  beforeEach(async () => {
    store = new RedisVectorStore({ prefix: 'test:vector', maxEntries: 100 });
    await store.connect();
    store.clear();
  });

  afterEach(() => {
    store.clear();
  });

  it('should insert and search vectors', async () => {
    await store.insert('id1', [1, 0, 0], { namespace: 'ns1', response: 'hello' });
    await store.insert('id2', [0, 1, 0], { namespace: 'ns1', response: 'world' });

    const results = await store.search([1, 0, 0], 1, 0.9, 'ns1');
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe('id1');
    expect(results[0].score).toBeGreaterThan(0.99);
  });

  it('should only return results above threshold', async () => {
    await store.insert('id1', [1, 0, 0], { namespace: 'ns1', response: 'hello' });

    const results = await store.search([0, 1, 0], 1, 0.9, 'ns1');
    expect(results).toHaveLength(0);
  });

  it('should filter by namespace', async () => {
    await store.insert('id1', [1, 0, 0], { namespace: 'ns1', response: 'hello' });
    await store.insert('id2', [1, 0, 0], { namespace: 'ns2', response: 'world' });

    const results = await store.search([1, 0, 0], 10, 0.5, 'ns1');
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe('id1');
  });

  it('should delete entries', async () => {
    await store.insert('id1', [1, 0, 0], { namespace: 'ns1', response: 'hello' });
    await store.delete('id1');

    const results = await store.search([1, 0, 0], 10, 0.5, 'ns1');
    expect(results).toHaveLength(0);
  });

  it('should respect max entries limit', async () => {
    const smallStore = new RedisVectorStore({ prefix: 'test:vector:small', maxEntries: 2 });
    await smallStore.connect();
    smallStore.clear();

    await smallStore.insert('id1', [1, 0, 0], { namespace: 'ns1', response: 'a' });
    await smallStore.insert('id2', [0, 1, 0], { namespace: 'ns1', response: 'b' });
    await smallStore.insert('id3', [0, 0, 1], { namespace: 'ns1', response: 'c' });

    expect(smallStore.count()).toBeLessThanOrEqual(2);
    smallStore.clear();
  });
});
```

**Run:** `npx jest tests/stores/redis-vector.test.ts --no-coverage`
**Expected:** FAIL — `RedisVectorStore` not found

### Step 2: Implement RedisVectorStore

**File:** `src/stores/redis-vector.ts`

```typescript
import type { IVectorStore, VectorSearchResult } from './vector-interface';
import Redis from 'ioredis';
import { writeLog } from '../utils/logger';

interface RedisVectorStoreOptions {
  prefix?: string;
  maxEntries?: number;
  redis?: Redis;
}

interface VectorEntry {
  id: string;
  vector: number[];
  metadata: Record<string, unknown>;
  insertedAt: number;
}

export class RedisVectorStore implements IVectorStore {
  private redis: Redis;
  private readonly prefix: string;
  private readonly maxEntries: number;

  constructor(options: RedisVectorStoreOptions = {}) {
    this.prefix = options.prefix || 'gateway:vector';
    this.maxEntries = options.maxEntries ?? 10000;
    this.redis = options.redis || this.createRedisClient();
  }

  private createRedisClient(): Redis {
    const host = process.env.REDIS_HOST || 'localhost';
    const port = parseInt(process.env.REDIS_PORT || '6379', 10);
    const password = process.env.REDIS_PASSWORD;
    const db = parseInt(process.env.REDIS_DB || '0', 10);

    return new Redis({ host, port, password, db, lazyConnect: true });
  }

  async connect(): Promise<void> {
    await this.redis.connect();
  }

  async search(
    vector: number[],
    topK: number,
    threshold: number,
    namespace: string
  ): Promise<VectorSearchResult[]> {
    const entries = await this.loadAllEntries();
    const query = new Float32Array(vector);
    const results: VectorSearchResult[] = [];

    for (const entry of entries) {
      if (entry.metadata['namespace'] !== namespace) continue;

      const score = this.cosineSimilarity(query, new Float32Array(entry.vector));
      if (score >= threshold) {
        results.push({ id: entry.id, score, metadata: entry.metadata });
      }
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, topK);
  }

  async insert(id: string, vector: number[], metadata: Record<string, unknown>): Promise<void> {
    await this.enforceMaxEntries();

    const entry: VectorEntry = {
      id,
      vector,
      metadata,
      insertedAt: Date.now(),
    };

    await this.redis.hset(this.hashKey, id, JSON.stringify(entry));
  }

  async delete(id: string): Promise<void> {
    await this.redis.hdel(this.hashKey, id);
  }

  count(): number {
    // Note: This is synchronous in interface but Redis hlen is async.
    // We return 0 here and rely on async count where needed.
    return 0;
  }

  async asyncCount(): Promise<number> {
    return this.redis.hlen(this.hashKey);
  }

  clear(): void {
    this.redis.del(this.hashKey).catch((e) => {
      writeLog('warn', 'Failed to clear Redis vector store', { error: e.message });
    });
  }

  private get hashKey(): string {
    return `${this.prefix}:entries`;
  }

  private async loadAllEntries(): Promise<VectorEntry[]> {
    const data = await this.redis.hgetall(this.hashKey);
    const entries: VectorEntry[] = [];

    for (const value of Object.values(data)) {
      try {
        entries.push(JSON.parse(value) as VectorEntry);
      } catch {
        // skip corrupted entries
      }
    }

    return entries;
  }

  private async enforceMaxEntries(): Promise<void> {
    const count = await this.redis.hlen(this.hashKey);
    if (count >= this.maxEntries) {
      const data = await this.redis.hgetall(this.hashKey);
      let oldestId = '';
      let oldestTime = Infinity;

      for (const [id, value] of Object.entries(data)) {
        try {
          const entry = JSON.parse(value) as VectorEntry;
          if (entry.insertedAt < oldestTime) {
            oldestTime = entry.insertedAt;
            oldestId = id;
          }
        } catch {
          // skip corrupted
        }
      }

      if (oldestId) {
        await this.redis.hdel(this.hashKey, oldestId);
      }
    }
  }

  private cosineSimilarity(a: Float32Array, b: Float32Array): number {
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    if (normA === 0 || normB === 0) return 0;
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
  }
}
```

**Run:** `npx jest tests/stores/redis-vector.test.ts --no-coverage`
**Expected:** PASS (if Redis is available; if not, test will be skipped — see Step 4)

### Step 3: Handle Redis unavailable in test environment

**File:** `tests/stores/redis-vector.test.ts` — add skip logic

Wrap the entire describe block with Redis availability check:

```typescript
import Redis from 'ioredis';

const redisAvailable = async (): Promise<boolean> => {
  try {
    const client = new Redis({ lazyConnect: true, connectTimeout: 1000 });
    await client.connect();
    await client.disconnect();
    return true;
  } catch {
    return false;
  }
};

describe('RedisVectorStore', () => {
  // ... tests
});
```

Actually, better to follow the project's existing pattern. Let's check if they have Redis skip logic elsewhere.

### Step 4: Update semantic-cache.ts to select backend

**File:** `src/services/semantic-cache.ts:96-108`

**Modify** `initSemanticCache`:

```typescript
export function initSemanticCache(config?: { enabled?: boolean; threshold?: number; backend?: string; max_entries?: number }): void {
  const maxEntries = config?.max_entries ?? 10000;
  let vectorStore: IVectorStore;

  if (config?.backend === 'redis_vector') {
    vectorStore = new RedisVectorStore({ maxEntries });
  } else {
    vectorStore = new MemoryVectorStore({ maxEntries });
  }

  globalSemanticCache = new SemanticCacheService({
    enabled: config?.enabled ?? false,
    threshold: config?.threshold ?? 0.85,
    vectorStore,
  });
}
```

**Also add import**: `import { RedisVectorStore } from '../stores/redis-vector';`

### Step 5: Commit

```bash
git add src/stores/redis-vector.ts tests/stores/redis-vector.test.ts src/services/semantic-cache.ts
git commit -m "feat: add Redis-backed vector store for semantic cache

- Implement RedisVectorStore with Hash persistence
- Support namespace filtering and LRU eviction
- Integrate with semantic cache init backend selection
- Add unit tests with Redis skip logic"
```

---

## Task 2: 审计日志 Admin API

### Step 1: Write failing test

**File:** `tests/routes/admin-audit.test.ts`

```typescript
import { createApp } from '../src/app';
import type { Hono } from 'hono';

describe('Admin Audit API', () => {
  let app: Hono;

  beforeEach(() => {
    app = createApp();
  });

  it('should return audit logs with admin key', async () => {
    const res = await app.request('/v1/audit/logs', {
      headers: { Authorization: 'Bearer admin-key-123' },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('logs');
    expect(body).toHaveProperty('total');
    expect(Array.isArray(body.logs)).toBe(true);
  });

  it('should filter by event_type', async () => {
    const res = await app.request('/v1/audit/logs?event_type=guardrail.triggered', {
      headers: { Authorization: 'Bearer admin-key-123' },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.logs)).toBe(true);
  });

  it('should require admin auth', async () => {
    const res = await app.request('/v1/audit/logs');
    expect(res.status).toBe(401);
  });
});
```

**Run:** `npx jest tests/routes/admin-audit.test.ts --no-coverage`
**Expected:** FAIL — 404 (route not registered)

### Step 2: Add readAuditLogs function

**File:** `src/utils/audit.ts` — append after line 146

```typescript
export interface AuditLogQuery {
  tenant_id?: string;
  event_type?: string;
  start?: number; // timestamp ms
  end?: number;   // timestamp ms
  limit?: number;
  offset?: number;
}

export interface AuditLogEntry extends AuditEvent {
  id: string;
}

export function readAuditLogs(query: AuditLogQuery = {}): { logs: AuditLogEntry[]; total: number } {
  const {
    tenant_id,
    event_type,
    start,
    end,
    limit = 50,
    offset = 0,
  } = query;

  const allLogs: AuditLogEntry[] = [];

  try {
    if (!existsSync(AUDIT_LOG_DIR)) {
      return { logs: [], total: 0 };
    }

    const files = readdirSync(AUDIT_LOG_DIR)
      .filter((f) => f.startsWith('audit-') && f.endsWith('.log'))
      .sort()
      .reverse(); // newest first

    for (const file of files) {
      const filePath = join(AUDIT_LOG_DIR, file);
      const content = readFileSync(filePath, 'utf-8');
      const lines = content.split('\n').filter((line) => line.trim());

      for (const line of lines) {
        try {
          const event = JSON.parse(line) as AuditEvent;

          // Filter by time range
          const eventTime = new Date(event.timestamp).getTime();
          if (start && eventTime < start) continue;
          if (end && eventTime > end) continue;

          // Filter by tenant
          if (tenant_id && event.tenant_id !== tenant_id) continue;

          // Filter by event type
          if (event_type && event.event_type !== event_type) continue;

          allLogs.push({
            ...event,
            id: `${event.timestamp}-${Math.random().toString(36).slice(2, 8)}`,
          });
        } catch {
          // skip corrupted lines
        }
      }
    }
  } catch {
    // return empty on error
  }

  const total = allLogs.length;
  const paginated = allLogs.slice(offset, offset + limit);

  return { logs: paginated, total };
}
```

**Also add import**: `import { readFileSync } from 'fs';` at the top

### Step 3: Create audit route

**File:** `src/routes/admin/audit.ts`

```typescript
import { Hono } from 'hono';
import { requireAdmin } from '../../middleware/auth';
import { readAuditLogs } from '../../utils/audit';

const router = new Hono();

router.use('*', requireAdmin);

router.get('/logs', (c) => {
  const tenantId = c.req.query('tenant_id');
  const eventType = c.req.query('event_type');
  const start = c.req.query('start') ? parseInt(c.req.query('start')!, 10) : undefined;
  const end = c.req.query('end') ? parseInt(c.req.query('end')!, 10) : undefined;
  const limit = c.req.query('limit') ? parseInt(c.req.query('limit')!, 10) : 50;
  const offset = c.req.query('offset') ? parseInt(c.req.query('offset')!, 10) : 0;

  const result = readAuditLogs({
    tenant_id: tenantId,
    event_type: eventType,
    start,
    end,
    limit: Math.min(limit, 500),
    offset,
  });

  return c.json(result);
});

export default router;
```

### Step 4: Register audit router

**File:** `src/routes/admin/index.ts`

Add import and route registration:

```typescript
import auditRouter from './audit';

// ... in route registration section
adminRouter.route('/audit', auditRouter);
```

### Step 5: Commit

```bash
git add src/utils/audit.ts src/routes/admin/audit.ts src/routes/admin/index.ts tests/routes/admin-audit.test.ts
git commit -m "feat: add audit log admin API

- Add readAuditLogs with time range, tenant, event_type filtering
- Add GET /v1/audit/logs endpoint with pagination
- Add tests for auth and filtering"
```

---

## Task 3: 虚拟 Key 策略前端

### Step 1: Add API function

**File:** `ai-gateway-admin/src/services/api.ts`

Add function (check if it already exists — the key policy update might already be there):

```typescript
export async function updateKeyPolicy(
  tenantId: string,
  keyHash: string,
  policy: {
    allowed_models?: string[];
    rate_limit_qps?: number;
    rate_limit_burst?: number;
    monthly_budget?: number;
    max_tokens_per_request?: number;
    default_model?: string;
    metadata?: Record<string, unknown>;
  }
) {
  const response = await api.put(`/v1/tenants/${tenantId}/keys/${keyHash}`, policy);
  return response.data;
}
```

### Step 2: Add Policy Edit Modal to Tenants page

**File:** `ai-gateway-admin/src/pages/Tenants/index.tsx`

Find the Key management section (likely in a drawer or modal) and add a "编辑策略" button that opens a form modal with fields:
- allowed_models (multi-select or tag input)
- rate_limit_qps (number input)
- rate_limit_burst (number input)
- monthly_budget (number input)
- max_tokens_per_request (number input)
- default_model (select)

The exact code depends on the current Tenants page structure. Inspect the file to find the Key list rendering.

### Step 3: Verify

```bash
cd ai-gateway-admin
pnpm tsc --noEmit
pnpm lint
```

### Step 4: Commit

```bash
git add ai-gateway-admin/src/services/api.ts ai-gateway-admin/src/pages/Tenants/index.tsx
git commit -m "feat(admin): add virtual key policy editing in tenant detail

- Add updateKeyPolicy API function
- Add policy edit modal with rate limits, budget, allowed models"
```

---

## Post-Implementation Verification

After all tasks complete, run:

```bash
npm run lint
npx tsc --noEmit
npm test -- --no-coverage
```

Expected: All backend tests pass (906+). Frontend type check passes.
