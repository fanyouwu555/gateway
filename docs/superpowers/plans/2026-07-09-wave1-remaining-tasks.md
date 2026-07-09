# Wave 1 Remaining Security Tasks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete Wave 1 of the AI Gateway audit remediation by implementing auth prefix index, WebSocket rate limiting, and failover 4xx / billing-error fixes.

**Architecture:** Surgical changes to existing middleware/services/routes. No new npm dependencies. Extract `checkRateLimit` from `rateLimitMiddleware` so both HTTP and WS can share the same limiter. Add `GatewayError.billingError` and migrate all billing-check rejections to use it.

**Tech Stack:** TypeScript / Hono / Jest / ioredis

## Global Constraints

- No new npm dependencies.
- All changes must pass `npm run lint → npx tsc --noEmit → npm test` (backend) and `pnpm lint → pnpm exec tsc --noEmit → pnpm test` (frontend if touched).
- Backend test coverage must stay ≥ 60% for branches/functions/lines/statements.
- Commit messages in English, end with `Co-Authored-By: Claude <noreply@anthropic.com>`.
- Keep changes focused: do NOT refactor Wave 2-4 items.

---

## Task 1: Auth Prefix Index

**Files:**
- Modify: `src/services/tenant.ts` (add `findByPrefix` method + exported wrapper)
- Modify: `src/middleware/auth.ts` (rewrite `validateApiKey` to use prefix index)
- Test: `tests/middleware/auth.test.ts`

**Interfaces:**
- Consumes: `verifyApiKey` from `src/utils`, `getConfig` from `src/config`, `findApiKeyByPrefix` / `findTenantApiKeyByHash` from `src/services/tenant`.
- Produces: `TenantStore.findByPrefix(prefix: string): string[]`, `findApiKeyByPrefix(prefix: string): string[]`.

- [ ] **Step 1: Add failing tests for prefix-index auth**

  Append to `tests/middleware/auth.test.ts`:

  ```ts
  import {
    createTenant,
    createTenantApiKey,
    resetTenantStore,
    findApiKeyByPrefix,
  } from '../../src/../src/services/tenant';

  describe('authMiddleware with tenant keys', () => {
    beforeEach(() => {
      resetTenantStore();
    });

    it('should authenticate a tenant key using the prefix index', async () => {
      const tenant = await createTenant({
        name: 'Prefix Tenant',
        status: 'active',
        plan: 'free',
        settings: {},
        limits: {
          daily_requests: 1000,
          daily_tokens: 100000,
          max_api_keys: 10,
          concurrent_requests: 10,
        },
      });
      const key = await createTenantApiKey(tenant.tenant_id, 'prefix-key');
      expect(key).toBeDefined();

      const res = await app.request('/test', {
        headers: { 'x-api-key': key!.key },
      });
      expect(res.status).toBe(200);
    });

    it('should reject an invalid tenant key', async () => {
      const res = await app.request('/test', {
        headers: { 'x-api-key': 'sk-tenant-invalid' },
      });
      expect(res.status).toBe(401);
      const body = await res.json() as { error: { code: string } };
      expect(body.error.code).toBe('invalid_api_key');
    });

    it('should find candidate keys by prefix', async () => {
      const tenant = await createTenant({
        name: 'Prefix Tenant 2',
        status: 'active',
        plan: 'free',
        settings: {},
        limits: {
          daily_requests: 1000,
          daily_tokens: 100000,
          max_api_keys: 200,
          concurrent_requests: 100,
        },
      });
      const key = await createTenantApiKey(tenant.tenant_id, 'prefix-key');
      const prefix = key!.key.slice(0, 10);
      const candidates = findApiKeyByPrefix(prefix);
      expect(candidates.length).toBeGreaterThanOrEqual(1);
    });

    it('should authenticate quickly with 100 tenant keys', async () => {
      const tenant = await createTenant({
        name: 'Perf Tenant',
        status: 'active',
        plan: 'free',
        settings: {},
        limits: {
          daily_requests: 100000,
          daily_tokens: 10000000,
          max_api_keys: 200,
          concurrent_requests: 100,
        },
      });
      const keys: string[] = [];
      for (let i = 0; i < 100; i++) {
        const k = await createTenantApiKey(tenant.tenant_id, `perf-key-${i}`);
        keys.push(k!.key);
      }

      const start = Date.now();
      const res = await app.request('/test', {
        headers: { 'x-api-key': keys[50] },
      });
      const elapsed = Date.now() - start;

      expect(res.status).toBe(200);
      expect(elapsed).toBeLessThan(100);
    });
  });
  ```

- [ ] **Step 2: Run the new tests and confirm they fail**

  Run: `npx jest tests/middleware/auth.test.ts --no-coverage`
  Expected: FAIL — `findApiKeyByPrefix` is not exported / auth still uses O(n) scan so the 100-key perf test times out.

- [ ] **Step 3: Add `findByPrefix` and export wrapper**

  In `src/services/tenant.ts`, add a public method inside `TenantStore` after `getKeyPrefix`:

  ```ts
  findByPrefix(prefix: string): string[] {
    return this.keyPrefixIndex.get(prefix) || [];
  }
  ```

  Then export a wrapper after `verifyTenantApiKey`:

  ```ts
  export function findApiKeyByPrefix(prefix: string): string[] {
    return tenantStore.findByPrefix(prefix);
  }
  ```

- [ ] **Step 4: Rewrite `src/middleware/auth.ts`**

  Replace the imports and `validateApiKey`:

  ```ts
  import { findApiKeyByPrefix, findTenantApiKeyByHash, getTenant } from '../services/tenant';

  function buildAuthResult(storedKey: IApiKeyMeta): IAuthResult {
    if (storedKey.expires_at && storedKey.expires_at < Date.now()) {
      return { valid: false, error: 'API key expired' };
    }
    if (storedKey.tenant_id) {
      const tenant = getTenant(storedKey.tenant_id);
      if (tenant && tenant.status !== 'active') {
        return { valid: false, error: 'Tenant is not active' };
      }
    }
    return {
      valid: true,
      tenant_id: storedKey.tenant_id,
      api_key_meta: storedKey,
    };
  }

  function validateApiKey(apiKey: string): IAuthResult {
    const config = getConfig();

    if (!config.auth.enabled) {
      return { valid: true };
    }

    const configKeys = config.auth.api_keys || [];
    for (const keyMeta of configKeys) {
      if (verifyApiKey(apiKey, keyMeta.key)) {
        return buildAuthResult(keyMeta);
      }
    }

    const prefix = apiKey.slice(0, 10);
    const candidateHashes = findApiKeyByPrefix(prefix);
    for (const hashedKey of candidateHashes) {
      const keyMeta = findTenantApiKeyByHash(hashedKey);
      if (keyMeta && verifyApiKey(apiKey, keyMeta.key)) {
        return buildAuthResult(keyMeta);
      }
    }

    return { valid: false, error: 'Invalid API key' };
  }
  ```

  Remove the old `getAllApiKeys()` function and the `getAllTenantApiKeys` import to satisfy `noUnusedLocals`.

- [ ] **Step 5: Run auth tests**

  Run: `npx jest tests/middleware/auth.test.ts --no-coverage`
  Expected: PASS

- [ ] **Step 6: Commit**

  ```bash
  git add src/services/tenant.ts src/middleware/auth.ts tests/middleware/auth.test.ts
  git commit -m "perf(auth): use key prefix index to avoid O(n) scrypt verification"
  ```

---

## Task 2: Extract Programmable `checkRateLimit`

**Files:**
- Modify: `src/middleware/ratelimit.ts`
- Test: `tests/middleware/ratelimit-check.test.ts`

**Interfaces:**
- Consumes: `getConfig`, `getTenant`, `concurrencyLimiter`, `getRateLimitStore`.
- Produces: `RateLimitCheckInfo`, `RateLimitResult`, `checkRateLimit(info) => { result, release? }`.

- [ ] **Step 1: Add failing test for `checkRateLimit`**

  Create `tests/middleware/ratelimit-check.test.ts`:

  ```ts
  /**
   * Programmable rate-limit check tests
   */
  import { checkRateLimit, resetRateLimitStore } from '../../src/../src/middleware/ratelimit';
  import { createTenant, resetTenantStore } from '../../src/../src/services/tenant';

  jest.mock('../../src/config', () => ({
    getConfig: () => ({
      rate_limit: { enabled: true, qps: 10, burst: 2 },
      auth: { enabled: false, api_keys: [] },
    }),
    resolveModelAlias: jest.fn((alias: string) => alias),
    isModelPool: jest.fn(() => false),
    getModelPool: jest.fn(() => undefined),
  }));

  describe('checkRateLimit', () => {
    beforeEach(() => {
      resetRateLimitStore();
      resetTenantStore();
    });

    it('should allow requests within burst and return a release callback', async () => {
      const { result, release } = await checkRateLimit({
        tenantId: 't1',
        keyHash: 'hash1',
        isAdminPath: false,
      });
      expect(result.allowed).toBe(true);
      expect(release).toBeDefined();
      release?.();
    });

    it('should block when burst is exceeded', async () => {
      await checkRateLimit({ tenantId: 't1', keyHash: 'hash1', isAdminPath: false });
      const { release } = await checkRateLimit({ tenantId: 't1', keyHash: 'hash1', isAdminPath: false });
      release?.();
      const { result } = await checkRateLimit({ tenantId: 't1', keyHash: 'hash1', isAdminPath: false });
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('rate_limit_exceeded');
    });

    it('should block concurrent requests over tenant limit', async () => {
      const tenant = await createTenant({
        name: 'Concurrent Tenant',
        status: 'active',
        plan: 'free',
        settings: {},
        limits: {
          daily_requests: 1000,
          daily_tokens: 100000,
          max_api_keys: 5,
          concurrent_requests: 1,
        },
      });

      const first = await checkRateLimit({
        tenantId: tenant.tenant_id,
        keyHash: 'hash1',
        isAdminPath: false,
      });
      expect(first.result.allowed).toBe(true);

      const second = await checkRateLimit({
        tenantId: tenant.tenant_id,
        keyHash: 'hash1',
        isAdminPath: false,
      });
      expect(second.result.allowed).toBe(false);
      expect(second.result.reason).toBe('concurrent_limit_exceeded');

      first.release?.();
    });
  });
  ```

- [ ] **Step 2: Run the new test and confirm it fails**

  Run: `npx jest tests/middleware/ratelimit-check.test.ts --no-coverage`
  Expected: FAIL — `checkRateLimit` is not exported.

- [ ] **Step 3: Extract `checkRateLimit` from `rateLimitMiddleware`**

  In `src/middleware/ratelimit.ts`, add after the imports and before `rateLimitMiddleware`:

  ```ts
  export interface RateLimitCheckInfo {
    tenantId?: string;
    keyHash?: string;
    isAdminPath: boolean;
    model?: string;
    rateLimitQps?: number;
    rateLimitBurst?: number;
  }

  export interface RateLimitResult {
    allowed: boolean;
    remaining?: number;
    limit?: number;
    retryAfter?: number;
    reason?: string;
  }

  export async function checkRateLimit(
    info: RateLimitCheckInfo
  ): Promise<{ result: RateLimitResult; release?: () => void }> {
    const config = getConfig();
    if (!config.rate_limit?.enabled) {
      return { result: { allowed: true } };
    }

    const tenantId = info.tenantId;
    const keyHash = info.keyHash;
    const concurrencyKey = keyHash || tenantId || 'global';
    let concurrencyLimit = 0;
    let acquired = false;

    if (tenantId) {
      const tenant = getTenant(tenantId);
      if (tenant?.limits?.concurrent_requests) {
        concurrencyLimit = tenant.limits.concurrent_requests;
      }
    }

    if (concurrencyLimit > 0) {
      acquired = concurrencyLimiter.acquire(concurrencyKey, concurrencyLimit);
      if (!acquired) {
        return { result: { allowed: false, reason: 'concurrent_limit_exceeded' } };
      }
    }

    const store = await getRateLimitStore(info.isAdminPath);
    const limit = info.isAdminPath
      ? (config.rate_limit.burst ?? 20) * 2
      : (config.rate_limit.burst ?? 20);

    const mockC = {
      req: { header: () => undefined },
      get: (key: string) => {
        if (key === 'tenant_id') return tenantId;
        if (key === 'key_hash') return keyHash;
        if (key === 'key_rate_limit_qps') return info.rateLimitQps;
        if (key === 'key_rate_limit_burst') return info.rateLimitBurst;
        return undefined;
      },
    } as unknown as Context;

    const allowed = await store.consume(mockC);
    const remaining = await store.getRemainingTokens(mockC);

    if (!allowed) {
      if (acquired) {
        concurrencyLimiter.release(concurrencyKey);
      }
      const qps = config.rate_limit.qps ?? 10;
      const retryAfter = Math.max(1, Math.ceil(1 / qps));
      return {
        result: { allowed: false, remaining: 0, limit, retryAfter, reason: 'rate_limit_exceeded' },
      };
    }

    return {
      result: { allowed: true, remaining, limit },
      release: acquired ? () => concurrencyLimiter.release(concurrencyKey) : undefined,
    };
  }
  ```

- [ ] **Step 4: Update `rateLimitMiddleware` to use `checkRateLimit`**

  Replace the body of `rateLimitMiddleware` with:

  ```ts
  export async function rateLimitMiddleware(
    c: Context,
    next: Next
  ): Promise<Response | void> {
    const config = getConfig();

    if (!config.rate_limit.enabled) {
      await next();
      return;
    }

    const isAdminPath =
      c.req.path.startsWith('/v1/tenants') ||
      c.req.path.startsWith('/v1/config') ||
      c.req.path.startsWith('/v1/plugins') ||
      c.req.path.startsWith('/v1/usage') ||
      c.req.path.startsWith('/v1/quota') ||
      c.req.path.startsWith('/v1/cache') ||
      c.req.path.startsWith('/v1/prompts') ||
      c.req.path.startsWith('/v1/alerts') ||
      c.req.path.startsWith('/v1/router') ||
      c.req.path.startsWith('/v1/sessions') ||
      c.req.path.startsWith('/v1/auth/verify');

    const { result, release } = await checkRateLimit({
      tenantId: c.get('tenant_id'),
      keyHash: c.get('key_hash'),
      isAdminPath,
      rateLimitQps: c.get('key_rate_limit_qps'),
      rateLimitBurst: c.get('key_rate_limit_burst'),
    });

    if (!result.allowed) {
      if (result.retryAfter) {
        c.res.headers.set('Retry-After', String(result.retryAfter));
      }
      return c.json(
        {
          error: {
            message: 'Rate limit exceeded. Please try again later.',
            type: 'rate_limit_error',
            code: result.reason || 'rate_limit_exceeded',
          },
        },
        429
      );
    }

    c.res.headers.set('X-RateLimit-Remaining', String(result.remaining));
    c.res.headers.set('X-RateLimit-Limit', String(result.limit));

    try {
      await next();
    } finally {
      release?.();
    }
  }
  ```

- [ ] **Step 5: Run rate-limit tests**

  Run: `npx jest tests/middleware/ratelimit.test.ts tests/middleware/ratelimit-enhanced.test.ts tests/middleware/ratelimit-check.test.ts --no-coverage`
  Expected: PASS

- [ ] **Step 6: Commit**

  ```bash
  git add src/middleware/ratelimit.ts tests/middleware/ratelimit-check.test.ts
  git commit -m "feat(ratelimit): extract checkRateLimit with release callback for WS reuse"
  ```

---

## Task 3: WebSocket Rate Limiting

**Files:**
- Modify: `src/middleware/websocket.ts`
- Modify: `src/types/context.d.ts` (if needed for `key_rate_limit_*` on WS connection)
- Test: `tests/websocket.test.ts`

**Interfaces:**
- Consumes: `checkRateLimit` from `src/middleware/ratelimit`, `getTokenRateLimit` from `src/services/token-ratelimit`, `countPromptTokens` from `src/services/token-counter`.
- Produces: WS `chat.completion` errors with `type: 'rate_limit_error'` when limits hit; `WSConnection` carries `key_rate_limit_qps` / `key_rate_limit_burst`.

- [ ] **Step 1: Add WSConnection rate-limit fields and pass them from context**

  In `src/middleware/websocket.ts`, extend `WSConnection`:

  ```ts
  key_rate_limit_qps?: number;
  key_rate_limit_burst?: number;
  ```

  In `handleWSConnection`, set them from `ctx`:

  ```ts
  const connectionId = wsManager.addConnection(ws, tenantId, model, {
    key_hash: ctx.get('key_hash'),
    key_allowed_models: ctx.get('key_allowed_models'),
    key_monthly_budget: ctx.get('key_monthly_budget'),
    key_max_tokens: ctx.get('key_max_tokens_per_request'),
    key_metadata: ctx.get('key_metadata'),
    key_billing_mode: ctx.get('key_billing_mode'),
    key_subscription_expires_at: ctx.get('key_subscription_expires_at'),
    key_rate_limit_qps: ctx.get('key_rate_limit_qps'),
    key_rate_limit_burst: ctx.get('key_rate_limit_burst'),
  });
  ```

- [ ] **Step 2: Add test for WSConnection carrying rate-limit fields**

  Append to `tests/websocket.test.ts`:

  ```ts
  import { handleWSConnection } from '../../src/../src/middleware/websocket';
  import type { Context } from 'hono';

  describe('handleWSConnection', () => {
    beforeEach(() => {
      resetWebSocketConnections();
    });

    it('should store rate limit fields on connection', () => {
      const fakeWS = new EventEmitter() as unknown as WebSocket;
      const ctx = {
        get: (key: string) => {
          if (key === 'tenant_id') return 'tenant-rl';
          if (key === 'key_hash') return 'hash-rl';
          if (key === 'key_rate_limit_qps') return 10;
          if (key === 'key_rate_limit_burst') return 20;
          if (key === 'key_billing_mode') return 'prepaid';
          return undefined;
        },
        req: { query: () => undefined, header: () => undefined },
      } as unknown as Context;

      handleWSConnection(fakeWS, ctx);
      const conns = getConnectionsByTenant('tenant-rl');
      expect(conns.length).toBe(1);
      expect(conns[0].key_rate_limit_qps).toBe(10);
      expect(conns[0].key_rate_limit_burst).toBe(20);
    });
  });
  ```

  Add `import { EventEmitter } from 'events';` and `import type { WebSocket } from 'ws';` at the top of `tests/websocket.test.ts`.

- [ ] **Step 3: Run the test and confirm it fails**

  Run: `npx jest tests/websocket.test.ts --no-coverage`
  Expected: FAIL — `key_rate_limit_qps` / `key_rate_limit_burst` are not on `WSConnection`.

- [ ] **Step 4: Integrate rate limit into `handleChatCompletion`**

  In `src/middleware/websocket.ts`:

  - Add import:
    ```ts
    import { checkRateLimit } from '../middleware/ratelimit';
    import { getTokenRateLimit } from '../services/token-ratelimit';
    ```

  - Restructure the start of `handleChatCompletion`:

    ```ts
    async function handleChatCompletion(connectionId: string, request: ChatCompletionRequest): Promise<void> {
      const conn = wsManager.getConnection(connectionId);
      if (!conn) return;

      let releaseRateLimit: (() => void) | undefined;

      try {
        request.model = resolveModelAlias(request.model || conn.model);

        if (conn.key_allowed_models && conn.key_allowed_models.length > 0 && !conn.key_allowed_models.includes(request.model)) {
          wsManager.send(connectionId, {
            type: 'error',
            error: {
              message: `Model '${request.model}' is not allowed by this API key. Allowed: ${conn.key_allowed_models.join(', ')}`,
              type: 'invalid_request_error',
              code: 'model_not_allowed',
            },
          });
          return;
        }

        const { result: rateLimitResult, release } = await checkRateLimit({
          tenantId: conn.tenant_id,
          keyHash: conn.key_hash,
          isAdminPath: false,
          model: request.model,
          rateLimitQps: conn.key_rate_limit_qps,
          rateLimitBurst: conn.key_rate_limit_burst,
        });
        releaseRateLimit = release;

        if (!rateLimitResult.allowed) {
          wsManager.send(connectionId, {
            type: 'error',
            error: {
              message: `Rate limit exceeded: ${rateLimitResult.reason}`,
              type: 'rate_limit_error',
              code: rateLimitResult.reason || 'rate_limit_exceeded',
            },
          });
          return;
        }

        // ... rest of existing billing/quota/plugins/stream logic stays here ...
      } catch (e) {
        // existing catch block
      } finally {
        releaseRateLimit?.();
      }
    }
    ```

  - After `processedReq` is produced and before calling `chatCompleteStream`, add token-rate-limit check:

    ```ts
    const trl = getTokenRateLimit();
    if (trl && request.model) {
      const estimatedPromptTokens = await countPromptTokens(processedReq.messages as ChatMessage[], request.model);
      if (!trl.check(request.model, estimatedPromptTokens)) {
        wsManager.send(connectionId, {
          type: 'error',
          error: {
            message: 'Token rate limit exceeded',
            type: 'rate_limit_error',
            code: 'token_rate_limit_exceeded',
          },
        });
        return;
      }
    }
    ```

  - In the existing stream `finally` block (where usage is recorded), after `await deductBalance(...)` add:

    ```ts
    if (trl && request.model && !wsClientDisconnected) {
      trl.consume(request.model, totalTokens);
    }
    ```

- [ ] **Step 5: Run websocket tests**

  Run: `npx jest tests/websocket.test.ts --no-coverage`
  Expected: PASS

- [ ] **Step 6: Commit**

  ```bash
  git add src/middleware/websocket.ts tests/websocket.test.ts
  git commit -m "feat(websocket): enforce rate limiting and token rate limits on WS messages"
  ```

---

## Task 4: Failover 4xx Filter

**Files:**
- Modify: `src/providers/index.ts`
- Test: `tests/providers/failover-chain.test.ts`

**Interfaces:**
- Consumes: `isRetryableError` from `src/services/retry.ts`.
- Produces: `chatComplete` / `chatCompleteStream` stop failover on non-retryable client errors.

- [ ] **Step 1: Add failing tests for 4xx failover behavior**

  Append to `tests/providers/failover-chain.test.ts`:

  ```ts
  it('should not failover on 4xx client errors', async () => {
    const error = new Error('Unauthorized');
    (error as { status?: number }).status = 401;
    mockOpenAI.chat.mockRejectedValue(error);
    mockDeepSeek.chat.mockResolvedValue({
      id: 'ds-401',
      object: 'chat.completion',
      created: 1,
      model: 'deepseek-chat',
      choices: [],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });

    setProviderDeps({ failoverManager: mockFailover, loadBalanceManager: mockLoadBalancer });

    await expect(
      chatComplete('openai', { model: 'gpt-4o', messages: [{ role: 'user', content: 'hello' }] })
    ).rejects.toThrow('Unauthorized');

    expect(mockDeepSeek.chat).not.toHaveBeenCalled();
  });

  it('should failover on 429 rate limit errors', async () => {
    const error = new Error('Too many requests');
    (error as { status?: number }).status = 429;
    mockOpenAI.chat.mockRejectedValue(error);
    mockDeepSeek.chat.mockResolvedValue({
      id: 'ds-429',
      object: 'chat.completion',
      created: 1,
      model: 'deepseek-chat',
      choices: [],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });

    setProviderDeps({ failoverManager: mockFailover, loadBalanceManager: mockLoadBalancer });

    const result = await chatComplete('openai', { model: 'gpt-4o', messages: [{ role: 'user', content: 'hello' }] });
    expect(result.model).toBe('deepseek-chat');
    expect(mockDeepSeek.chat).toHaveBeenCalled();
  });
  ```

- [ ] **Step 2: Run tests and confirm they fail**

  Run: `npx jest tests/providers/failover-chain.test.ts --no-coverage`
  Expected: FAIL — 401 still triggers failover to deepseek.

- [ ] **Step 3: Update `src/providers/index.ts` to filter non-retryable errors**

  - Add import at the top:
    ```ts
    import { isRetryableError } from '../services/retry';
    ```

  - Remove the local `isRetryableError` function (lines 121-125).

  - In `chatComplete` catch block, replace the model-fallback block with:

    ```ts
    } catch (error) {
      const latency = Date.now() - startTime;
      await activeFailover.recordProviderRequest(currentProvider, false, latency);
      const errMsg = error instanceof Error ? error.message : String(error);
      const statusCode = (error as { status?: number }).status;

      const retryable = statusCode === 429 || isRetryableError(error);
      if (!retryable) {
        throw error;
      }

      const fallbackModels = getConfig().model_fallbacks?.[request.model];
      if (fallbackModels && fallbackModels.length > 0) {
        for (const fallbackModel of fallbackModels) {
          try {
            const fallbackRequest = { ...providerRequest, model: fallbackModel };
            const fallbackResult = await callProviderWithRetry(provider, config, fallbackRequest, false);
            await activeFailover.recordProviderRequest(currentProvider, true, Date.now() - startTime);
            return fallbackResult as ChatCompletionResponse;
          } catch {
            // Continue to next fallback model
          }
        }
      }

      errors.push({ provider: currentProvider, error: errMsg });
    }
    ```

  - In `chatCompleteStream` catch block, replace with:

    ```ts
    } catch (error) {
      await activeFailover.recordProviderRequest(currentProvider, false, Date.now() - startTime);
      const statusCode = (error as { status?: number }).status;
      const retryable = statusCode === 429 || isRetryableError(error);
      if (!retryable) {
        throw error;
      }
      errors.push({ provider: currentProvider, error: error instanceof Error ? error.message : String(error) });
    }
    ```

- [ ] **Step 4: Run failover tests**

  Run: `npx jest tests/providers/failover-chain.test.ts tests/providers/stream-failover.test.ts --no-coverage`
  Expected: PASS

- [ ] **Step 5: Commit**

  ```bash
  git add src/providers/index.ts tests/providers/failover-chain.test.ts
  git commit -m "fix(providers): only failover on retryable errors (5xx/network/429), stop on 4xx"
  ```

---

## Task 5: `GatewayError.billingError`

**Files:**
- Modify: `src/middleware/error.ts`
- Test: `tests/middleware/error.test.ts`

**Interfaces:**
- Produces: `GatewayError.billingError(message, code?)` with `errorType: 'billing_error'` and status `402`.

- [ ] **Step 1: Add failing test for billing error factory**

  Append to `tests/middleware/error.test.ts` inside `static factory methods`:

  ```ts
  it('should create billing error', () => {
    const error = GatewayError.billingError('Insufficient balance', 'insufficient_balance');
    expect(error.statusCode).toBe(402);
    expect(error.errorType).toBe('billing_error');
    expect(error.code).toBe('insufficient_balance');
    expect(error.toResponse().error.type).toBe('billing_error');
  });
  ```

- [ ] **Step 2: Run test and confirm it fails**

  Run: `npx jest tests/middleware/error.test.ts --no-coverage`
  Expected: FAIL — `billingError` does not exist.

- [ ] **Step 3: Add `billing_error` type and factory method**

  In `src/middleware/error.ts`:

  - Update the type union:
    ```ts
    type ErrorType = 'invalid_request_error' | 'authentication_error' | 'rate_limit_error' | 'provider_error' | 'internal_error' | 'billing_error';
    ```

  - Add static factory:
    ```ts
    static billingError(message: string, code?: string): GatewayError {
      return new GatewayError(message, 'billing_error', 402, code);
    }
    ```

- [ ] **Step 4: Run error tests**

  Run: `npx jest tests/middleware/error.test.ts --no-coverage`
  Expected: PASS

- [ ] **Step 5: Commit**

  ```bash
  git add src/middleware/error.ts tests/middleware/error.test.ts
  git commit -m "feat(error): add GatewayError.billingError for 402 payment-required errors"
  ```

---

## Task 6: Migrate Billing Checks to `billing_error`

**Files:**
- Modify: `src/routes/chat.ts`
- Modify: `src/routes/embed.ts`
- Modify: `src/middleware/websocket.ts`
- Test: `tests/routes/billing-mode.test.ts`

**Interfaces:**
- Consumes: `GatewayError.billingError` from `src/middleware/error.ts`.
- Produces: All billing rejections return HTTP 402 with `type: 'billing_error'`.

- [ ] **Step 1: Update `src/routes/chat.ts`**

  - Add import:
    ```ts
    import { GatewayError } from '../middleware/error';
    ```

  - In `checkKeyPolicies`, replace the billing rejection block with:

    ```ts
    if (!billingCheck.allowed) {
      const code = billingCheck.code || 'insufficient_balance';
      recordMetric(
        c.get('request_id') as string,
        tenantId,
        'gateway',
        req.model,
        0,
        402,
        { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        keyHash,
        c.get('key_metadata'),
      );
      throw GatewayError.billingError(billingCheck.reason || 'Billing check failed', code);
    }
    ```

- [ ] **Step 2: Update `src/routes/embed.ts`**

  - Add import:
    ```ts
    import { GatewayError } from '../middleware/error';
    ```

  - Locate the billing check near line 53 and replace the manual `c.json(...)` with:

    ```ts
    if (!billingCheck.allowed) {
      const code = billingCheck.code || 'insufficient_balance';
      throw GatewayError.billingError(billingCheck.reason || 'Billing check failed', code);
    }
    ```

- [ ] **Step 3: Update `src/middleware/websocket.ts`**

  - In `handleChatCompletion`, replace the billing-check error block with:

    ```ts
    if (!billingCheck.allowed) {
      wsManager.send(connectionId, {
        type: 'error',
        error: {
          message: billingCheck.reason || 'Billing check failed',
          type: 'billing_error',
          code: billingCheck.code || 'insufficient_balance',
        },
      });
      return;
    }
    ```

- [ ] **Step 4: Update `tests/routes/billing-mode.test.ts`**

  - Change the subscription-expired assertions from 403 to 402:

    ```ts
    expect(res.status).toBe(402);
    ```

  - Add type assertions for all three billing rejection cases:

    ```ts
    expect(body.error.type).toBe('billing_error');
    ```

- [ ] **Step 5: Run billing-mode and route tests**

  Run:
  ```bash
  npx jest tests/routes/billing-mode.test.ts tests/routes/chat.test.ts tests/routes/embed.test.ts --no-coverage
  ```
  Expected: PASS

- [ ] **Step 6: Commit**

  ```bash
  git add src/routes/chat.ts src/routes/embed.ts src/middleware/websocket.ts tests/routes/billing-mode.test.ts
  git commit -m "fix(routes): return billing_error (402) for all billing rejections"
  ```

---

## Task 7: Final Verification

- [ ] **Step 1: Run backend quality gate**

  ```bash
  npm run lint
  npx tsc --noEmit
  npm test
  ```
  Expected: lint clean, tsc clean, 91+ suites / 1078+ tests pass, coverage ≥ 60%.

- [ ] **Step 2: Run frontend quality gate**

  ```bash
  pnpm --dir ai-gateway-admin lint
  pnpm --dir ai-gateway-admin exec tsc --noEmit
  pnpm --dir ai-gateway-admin test
  ```
  Expected: clean.

- [ ] **Step 3: Commit any fixes**

  ```bash
  git commit -m "fix(wave1): address final review findings" || echo "nothing to commit"
  ```

- [ ] **Step 4: Report completion**

  Summarize:
  - Wave 1 Task 1.3 / 1.4 / 1.5 complete.
  - Test counts and coverage.
  - Any remaining warnings (e.g. Jest worker force-exit).
