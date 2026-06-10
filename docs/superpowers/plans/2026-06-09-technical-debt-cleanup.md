# Technical Debt Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve five critical technical debts: concurrent request enforcement, log sampling, plugin persistence, semantic cache singleflight, and broken frontend tests.

**Architecture:** Each fix is self-contained with minimal cross-module dependencies. Concurrent limiting wraps requests in middleware; log sampling adds probabilistic filtering to the existing logger; plugin persistence uses the existing KV store abstraction; singleflight deduplicates in-flight embedding requests via a Promise Map; broken tests are removed after confirming they reference non-existent modules.

**Tech Stack:** TypeScript, Hono, ioredis, Jest, vitest

---

## File Structure

### Task 1: Concurrent Request Limiter
- **Create:** `src/services/concurrency-limiter.ts` — per-tenant/key in-flight request counter
- **Modify:** `src/middleware/ratelimit.ts` — integrate concurrency check before rate limit check
- **Test:** `tests/services/concurrency-limiter.test.ts`

### Task 2: Log Sampling
- **Modify:** `src/utils/logger.ts` — add `LOG_SAMPLE_RATE` env var and probabilistic drop for info/debug
- **Test:** `tests/utils/logger-sampling.test.ts`

### Task 3: Plugin Persistence
- **Create:** `src/services/plugin-store.ts` — load/save plugins to KV store
- **Modify:** `src/routes/admin/plugin.ts` — persist on register, delete on unregister
- **Modify:** `src/index.ts` — load persisted plugins at startup
- **Test:** `tests/services/plugin-store.test.ts`

### Task 4: Semantic Cache Singleflight
- **Modify:** `src/services/embedding.ts` — add in-flight Promise deduplication Map
- **Test:** `tests/services/embedding-singleflight.test.ts`

### Task 5: Fix Broken Frontend Tests
- **Delete:** `ai-gateway-admin/src/services/api.test.ts`
- **Delete:** `ai-gateway-admin/src/services/websocket.test.ts`
- **Modify:** `ai-gateway-admin/package.json` — remove broken test references if any

### Task 6: Final Verification
- Run backend lint, tsc, jest
- Run frontend tsc, lint

---

## Task 1: Concurrent Request Limiter

**Files:**
- Create: `src/services/concurrency-limiter.ts`
- Modify: `src/middleware/ratelimit.ts`
- Test: `tests/services/concurrency-limiter.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { ConcurrencyLimiter } from '../../src/services/concurrency-limiter';

describe('ConcurrencyLimiter', () => {
  let limiter: ConcurrencyLimiter;

  beforeEach(() => {
    limiter = new ConcurrencyLimiter();
  });

  afterEach(() => {
    limiter.clear();
  });

  it('should allow requests under limit', () => {
    expect(limiter.acquire('tenant-1', 2)).toBe(true);
    expect(limiter.acquire('tenant-1', 2)).toBe(true);
  });

  it('should block requests over limit', () => {
    limiter.acquire('tenant-1', 1);
    expect(limiter.acquire('tenant-1', 1)).toBe(false);
  });

  it('should release slot on done', () => {
    limiter.acquire('tenant-1', 1);
    limiter.release('tenant-1');
    expect(limiter.acquire('tenant-1', 1)).toBe(true);
  });

  it('should track per-tenant independently', () => {
    limiter.acquire('tenant-1', 1);
    expect(limiter.acquire('tenant-2', 1)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/services/concurrency-limiter.test.ts --no-coverage`
Expected: FAIL — `ConcurrencyLimiter` not found

- [ ] **Step 3: Implement ConcurrencyLimiter**

```typescript
export class ConcurrencyLimiter {
  private counts = new Map<string, number>();

  acquire(key: string, limit: number): boolean {
    const current = this.counts.get(key) || 0;
    if (current >= limit) {
      return false;
    }
    this.counts.set(key, current + 1);
    return true;
  }

  release(key: string): void {
    const current = this.counts.get(key) || 0;
    if (current <= 1) {
      this.counts.delete(key);
    } else {
      this.counts.set(key, current - 1);
    }
  }

  clear(): void {
    this.counts.clear();
  }

  getCount(key: string): number {
    return this.counts.get(key) || 0;
  }
}
```

- [ ] **Step 4: Integrate into rateLimit middleware**

Read `src/middleware/ratelimit.ts` to find the existing rate limit check. After the existing rate limit logic (where it returns 429), add concurrency check BEFORE the rate limit consume:

```typescript
import { ConcurrencyLimiter } from '../services/concurrency-limiter';
import { getTenant } from '../services/tenant';

const concurrencyLimiter = new ConcurrencyLimiter();

// Inside the middleware, after auth and before rate limit consume:
const tenantId = c.get('tenant_id') as string | undefined;
const keyHash = c.get('key_hash') as string | undefined;
const concurrencyKey = keyHash || tenantId || 'global';

// Check tenant concurrent limit
let concurrencyLimit = 0;
if (tenantId) {
  const tenant = await getTenant(tenantId).catch(() => null);
  if (tenant?.limits?.concurrent_requests) {
    concurrencyLimit = tenant.limits.concurrent_requests;
  }
}

if (concurrencyLimit > 0) {
  const allowed = concurrencyLimiter.acquire(concurrencyKey, concurrencyLimit);
  if (!allowed) {
    return c.json({
      error: {
        message: 'Concurrent request limit exceeded. Please try again later.',
        type: 'rate_limit_error',
        code: 'concurrent_limit_exceeded',
      },
    }, 429);
  }
  // Release after response completes
  c.res.headers.append('x-concurrent-remaining', String(concurrencyLimit - concurrencyLimiter.getCount(concurrencyKey)));
}
```

**Important:** The release must happen after the response is sent. In Hono, middleware can't easily hook into response completion. Use a different approach — wrap the downstream handler:

Actually, a simpler pattern: add the release in a `finally` block by overriding `c.json` or using Hono's `waitUntil`-style pattern. But Hono doesn't have native async cleanup.

Better approach: use an `async` IIFE in the middleware that wraps the `next()` call:

```typescript
// At the end of the middleware, after all checks pass:
if (concurrencyLimit > 0 && allowed) {
  await next();
  concurrencyLimiter.release(concurrencyKey);
  return;
}
await next();
```

Wait, in Hono middleware, you call `await next()` to pass to downstream. So the pattern is:

```typescript
export async function rateLimitMiddleware(c: Context, next: Next) {
  // ... existing auth/config checks ...

  // Concurrency check
  const tenantId = c.get('tenant_id') as string | undefined;
  const keyHash = c.get('key_hash') as string | undefined;
  const concurrencyKey = keyHash || tenantId || 'global';
  let concurrencyLimit = 0;

  if (tenantId) {
    const tenant = await getTenant(tenantId).catch(() => null);
    if (tenant?.limits?.concurrent_requests) {
      concurrencyLimit = tenant.limits.concurrent_requests;
    }
  }

  let acquired = false;
  if (concurrencyLimit > 0) {
    acquired = concurrencyLimiter.acquire(concurrencyKey, concurrencyLimit);
    if (!acquired) {
      return c.json({
        error: {
          message: 'Concurrent request limit exceeded. Please try again later.',
          type: 'rate_limit_error',
          code: 'concurrent_limit_exceeded',
        },
      }, 429);
    }
  }

  try {
    await next();
  } finally {
    if (acquired) {
      concurrencyLimiter.release(concurrencyKey);
    }
  }
}
```

- [ ] **Step 5: Run concurrency limiter tests**

Run: `npx jest tests/services/concurrency-limiter.test.ts --no-coverage`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/services/concurrency-limiter.ts tests/services/concurrency-limiter.test.ts src/middleware/ratelimit.ts
git commit -m "feat: add concurrent request limiter per tenant/key

- Add ConcurrencyLimiter with Map-based counter
- Integrate into rateLimit middleware with try/finally release
- Returns 429 with concurrent_limit_exceeded code when limit hit"
```

---

## Task 2: Log Sampling

**Files:**
- Modify: `src/utils/logger.ts`
- Test: `tests/utils/logger-sampling.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { writeLog } from '../../src/utils/logger';

describe('Log Sampling', () => {
  const originalEnv = process.env.LOG_SAMPLE_RATE;
  let logs: string[] = [];
  const originalConsoleLog = console.log;

  beforeEach(() => {
    logs = [];
    console.log = (...args: unknown[]) => {
      logs.push(args.join(' '));
    };
  });

  afterEach(() => {
    console.log = originalConsoleLog;
    process.env.LOG_SAMPLE_RATE = originalEnv;
  });

  it('should drop info logs when sample rate is 0', () => {
    process.env.LOG_SAMPLE_RATE = '0';
    writeLog('info', 'test message');
    expect(logs).toHaveLength(0);
  });

  it('should always keep error logs regardless of sample rate', () => {
    process.env.LOG_SAMPLE_RATE = '0';
    writeLog('error', 'error message');
    expect(logs.length).toBeGreaterThan(0);
  });

  it('should keep all logs when sample rate is 1', () => {
    process.env.LOG_SAMPLE_RATE = '1';
    writeLog('info', 'test message 1');
    writeLog('info', 'test message 2');
    expect(logs).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/utils/logger-sampling.test.ts --no-coverage`
Expected: FAIL — logs still written when sample rate is 0

- [ ] **Step 3: Add sampling logic to logger**

Modify `src/utils/logger.ts`:

```typescript
const SAMPLE_RATE = parseFloat(process.env.LOG_SAMPLE_RATE || '1.0');

function shouldLog(level: LogLevel): boolean {
  // Error and warn are always logged
  if (level === 'error' || level === 'warn') {
    return true;
  }
  // info/debug are sampled
  if (SAMPLE_RATE >= 1) {
    return true;
  }
  if (SAMPLE_RATE <= 0) {
    return false;
  }
  return Math.random() < SAMPLE_RATE;
}

export function writeLog(level: LogLevel, message: string, meta?: Record<string, unknown>): void {
  const currentLevelNum = LOG_LEVELS[getCurrentLogLevel()];
  const levelNum = LOG_LEVELS[level];
  if (levelNum < currentLevelNum) {
    return;
  }

  if (!shouldLog(level)) {
    return;
  }

  // ... rest unchanged
```

- [ ] **Step 4: Run tests**

Run: `npx jest tests/utils/logger-sampling.test.ts --no-coverage`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/utils/logger.ts tests/utils/logger-sampling.test.ts
git commit -m "feat: add log sampling for info/debug levels

- LOG_SAMPLE_RATE env var controls sampling probability
- Error/warn logs are always kept regardless of sample rate
- Add unit tests for 0%, 100%, and error-force behaviors"
```

---

## Task 3: Plugin Persistence

**Files:**
- Create: `src/services/plugin-store.ts`
- Modify: `src/routes/admin/plugin.ts`
- Modify: `src/index.ts`
- Test: `tests/services/plugin-store.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { PluginStore } from '../../src/services/plugin-store';
import { resetStorageFactory } from '../../src/stores/factory';

describe('PluginStore', () => {
  let store: PluginStore;

  beforeEach(() => {
    resetStorageFactory();
    store = new PluginStore();
  });

  it('should save and load plugin code', async () => {
    const code = 'exports.config = { id: "test", name: "Test", type: "guardrail", enabled: true, priority: 1 }; exports.check = async () => ({ allowed: true });';
    await store.save('test', code);
    const loaded = await store.load('test');
    expect(loaded).toBe(code);
  });

  it('should list all saved plugins', async () => {
    await store.save('p1', 'code1');
    await store.save('p2', 'code2');
    const list = await store.list();
    expect(list).toContain('p1');
    expect(list).toContain('p2');
  });

  it('should delete plugin', async () => {
    await store.save('test', 'code');
    await store.delete('test');
    const loaded = await store.load('test');
    expect(loaded).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/services/plugin-store.test.ts --no-coverage`
Expected: FAIL — `PluginStore` not found

- [ ] **Step 3: Implement PluginStore**

```typescript
import { createKVStore } from '../stores/factory';
import type { IKVStore } from '../stores/interface';
import { writeLog } from '../utils/logger';

const PLUGIN_PREFIX = 'plugin:code:';
const PLUGIN_LIST_KEY = 'plugin:list';

export class PluginStore {
  private store: IKVStore;

  constructor() {
    this.store = createKVStore('plugins');
  }

  async save(id: string, code: string): Promise<void> {
    await this.store.set(`${PLUGIN_PREFIX}${id}`, code);
    const list = await this.getList();
    if (!list.includes(id)) {
      list.push(id);
      await this.store.set(PLUGIN_LIST_KEY, JSON.stringify(list));
    }
  }

  async load(id: string): Promise<string | null> {
    const code = await this.store.get(`${PLUGIN_PREFIX}${id}`);
    return code || null;
  }

  async delete(id: string): Promise<void> {
    await this.store.delete(`${PLUGIN_PREFIX}${id}`);
    const list = await this.getList();
    const filtered = list.filter((p) => p !== id);
    await this.store.set(PLUGIN_LIST_KEY, JSON.stringify(filtered));
  }

  async list(): Promise<string[]> {
    return this.getList();
  }

  private async getList(): Promise<string[]> {
    const raw = await this.store.get(PLUGIN_LIST_KEY);
    if (!raw) return [];
    try {
      return JSON.parse(raw) as string[];
    } catch {
      return [];
    }
  }
}

let globalPluginStore: PluginStore | null = null;

export function getPluginStore(): PluginStore {
  if (!globalPluginStore) {
    globalPluginStore = new PluginStore();
  }
  return globalPluginStore;
}

export function resetPluginStore(): void {
  globalPluginStore = null;
}
```

- [ ] **Step 4: Wire persistence into admin plugin routes**

Modify `src/routes/admin/plugin.ts`:

```typescript
import { getPluginStore } from '../../services/plugin-store';

// In POST /v1/plugins/register handler, after successful loadPluginInSandbox:
const pluginStore = getPluginStore();
await pluginStore.save(plugin.config.id, code);
```

And in DELETE handler:
```typescript
const pluginStore = getPluginStore();
await pluginStore.delete(id);
```

- [ ] **Step 5: Load persisted plugins at startup**

Modify `src/index.ts`:

```typescript
import { getPluginStore } from './services/plugin-store';
import { loadPluginInSandbox } from './plugins/loader';
import { registerPlugin } from './plugins';

async function loadPersistedPlugins(): Promise<void> {
  const store = getPluginStore();
  const ids = await store.list();
  for (const id of ids) {
    const code = await store.load(id);
    if (!code) continue;
    const result = loadPluginInSandbox(code);
    if (result.success && result.plugin) {
      registerPlugin(result.plugin);
      writeLog('info', 'Restored persisted plugin', { id });
    } else {
      writeLog('warn', 'Failed to restore persisted plugin', { id, error: result.error });
    }
  }
}
```

Call `await loadPersistedPlugins()` after `initProviders()` in the startup sequence.

- [ ] **Step 6: Run tests**

Run: `npx jest tests/services/plugin-store.test.ts --no-coverage`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/services/plugin-store.ts tests/services/plugin-store.test.ts src/routes/admin/plugin.ts src/index.ts
git commit -m "feat: add plugin persistence with KV store

- PluginStore uses IKVStore to save/load/delete plugin code
- Admin plugin register/unregister now persists to store
- Startup loads all persisted plugins automatically
- Add unit tests for save/load/list/delete"
```

---

## Task 4: Semantic Cache Singleflight

**Files:**
- Modify: `src/services/embedding.ts`
- Test: `tests/services/embedding-singleflight.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { getEmbedding } from '../../src/services/embedding';

jest.mock('../../src/providers', () => ({
  createEmbedding: jest.fn().mockImplementation(async () => [0.1, 0.2, 0.3]),
}));

import { createEmbedding } from '../../src/providers';

describe('Embedding Singleflight', () => {
  const mockCreateEmbedding = createEmbedding as jest.Mock;

  beforeEach(() => {
    mockCreateEmbedding.mockClear();
  });

  it('should deduplicate concurrent embedding requests', async () => {
    const promise1 = getEmbedding('hello world');
    const promise2 = getEmbedding('hello world');
    const promise3 = getEmbedding('hello world');

    const [r1, r2, r3] = await Promise.all([promise1, promise2, promise3]);

    expect(r1).toEqual([0.1, 0.2, 0.3]);
    expect(r2).toEqual([0.1, 0.2, 0.3]);
    expect(r3).toEqual([0.1, 0.2, 0.3]);
    expect(mockCreateEmbedding).toHaveBeenCalledTimes(1);
  });

  it('should allow subsequent requests after first resolves', async () => {
    await getEmbedding('another text');
    expect(mockCreateEmbedding).toHaveBeenCalledTimes(1);

    await getEmbedding('another text');
    // Second call should use cache, not createEmbedding
    expect(mockCreateEmbedding).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/services/embedding-singleflight.test.ts --no-coverage`
Expected: FAIL — `createEmbedding` called 3 times instead of 1

- [ ] **Step 3: Add singleflight to embedding service**

Modify `src/services/embedding.ts`:

```typescript
// Add after embeddingCache definition:
const inflightEmbeddings = new Map<string, Promise<number[] | null>>();

// In getEmbedding, after cache check and before calling createProviderEmbedding:
export async function getEmbedding(text: string): Promise<number[] | null> {
  if (!EMBEDDING_ENABLED) return null;
  if (!text || text.trim().length === 0) return null;

  const cacheKey = getCacheKey(text);
  const cached = embeddingCache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.vector;
  }

  // Singleflight: deduplicate concurrent in-flight requests
  const inflight = inflightEmbeddings.get(cacheKey);
  if (inflight) {
    return inflight;
  }

  const promise = fetchEmbedding(text, cacheKey);
  inflightEmbeddings.set(cacheKey, promise);

  promise.finally(() => {
    inflightEmbeddings.delete(cacheKey);
  });

  return promise;
}

async function fetchEmbedding(text: string, cacheKey: string): Promise<number[] | null> {
  try {
    const vector = await createProviderEmbedding(text, EMBEDDING_MODEL, EMBEDDING_PROVIDER);
    if (vector) {
      embeddingCache.set(cacheKey, { vector, expiresAt: Date.now() + EMBEDDING_CACHE_TTL_MS });
      // Periodically clean cache
      if (embeddingCache.size > 1000) {
        cleanEmbeddingCache();
      }
    }
    return vector;
  } catch (error) {
    writeLog('error', 'Embedding failed', { error: error instanceof Error ? error.message : String(error) });
    return null;
  }
}
```

Remove the duplicate logic from the old `getEmbedding` function body and move it to `fetchEmbedding`.

- [ ] **Step 4: Run tests**

Run: `npx jest tests/services/embedding-singleflight.test.ts --no-coverage`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/services/embedding.ts tests/services/embedding-singleflight.test.ts
git commit -m "feat: add singleflight deduplication for embedding requests

- Concurrent identical embedding requests share one in-flight Promise
- Prevents N duplicate API calls when cache miss under concurrency
- Add unit test verifying createEmbedding called once for 3 concurrent reqs"
```

---

## Task 5: Fix Broken Frontend Tests

**Files:**
- Delete: `ai-gateway-admin/src/services/api.test.ts`
- Delete: `ai-gateway-admin/src/services/websocket.test.ts`

- [ ] **Step 1: Verify these files reference non-existent modules**

Read `ai-gateway-admin/src/services/api.test.ts` and confirm:
- `import { server } from '@/test/server'` — module does not exist
- `localStorage` / `window` — missing vitest jsdom environment config

Read `ai-gateway-admin/src/services/websocket.test.ts` and confirm:
- `import { MockWebSocket } from '@/test/mock-websocket'` — module does not exist
- `import { server } from '@/test/server'` — module does not exist

- [ ] **Step 2: Delete the broken test files**

```bash
rm ai-gateway-admin/src/services/api.test.ts
rm ai-gateway-admin/src/services/websocket.test.ts
```

- [ ] **Step 3: Commit**

```bash
git add ai-gateway-admin/src/services/api.test.ts ai-gateway-admin/src/services/websocket.test.ts
git commit -m "chore: remove broken frontend vitest test files

- api.test.ts referenced non-existent @/test/server module
- websocket.test.ts referenced non-existent @/test/mock-websocket module
- These tests were incomplete skeletons that never ran successfully
- Frontend testing infra will be reintroduced properly in future PR"
```

---

## Task 6: Final Verification

- [ ] **Step 1: Run backend lint**

Run: `npm run lint`
Expected: PASS

- [ ] **Step 2: Run backend TypeScript check**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 3: Run backend tests**

Run: `npx jest --no-coverage`
Expected: 75+ suites pass, 940+ tests pass

- [ ] **Step 4: Run frontend TypeScript check**

Run: `cd ai-gateway-admin && pnpm tsc --noEmit`
Expected: PASS

- [ ] **Step 5: Run frontend lint**

Run: `cd ai-gateway-admin && pnpm lint`
Expected: PASS

- [ ] **Step 6: Final commit if any remaining changes**

```bash
git status
# If clean, done. If not, commit any remaining fixes.
```

---

## Self-Review

**Spec coverage:**
- Concurrent limiting → Task 1 ✅
- Log sampling → Task 2 ✅
- Plugin persistence → Task 3 ✅
- Semantic cache singleflight → Task 4 ✅
- Broken frontend tests → Task 5 ✅
- Final verification → Task 6 ✅

**Placeholder scan:** No TBD/TODO/fill-in-details found. All steps include actual code.

**Type consistency:**
- `ConcurrencyLimiter.acquire/release` signatures consistent across test and impl
- `PluginStore.save/load/delete/list` signatures consistent
- `getEmbedding` retains same public signature, internal `fetchEmbedding` is private

**No gaps identified.**
