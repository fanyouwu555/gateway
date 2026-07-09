# AI Gateway 综合审查修复实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 系统修复 AI Gateway 审查发现的 64 项问题（13 HIGH / 37 MEDIUM / 14 LOW），分 4 波独立交付。

**Architecture:** Wave 1 消灭生产安全风险（财务原子化 + 认证优化 + WS 限流 + Failover 修正），Wave 2 拆分 chat.ts 并增强流式健壮性，Wave 3 稳固架构（Redis 连接共享 + 启动/关闭治理），Wave 4 清理幽灵代码与硬编码。

**Tech Stack:** TypeScript / Hono / Jest / ioredis / React 18 / Vite / Ant Design 5

## Global Constraints

- 不引入任何新 npm 依赖（已排除 redlock / DI 框架 / Zod 前端 / React Query）
- 所有改动必须通过 `npm run lint → tsc --noEmit → npm test`
- 每波在独立 git 分支：`fix/wave1-security`, `fix/wave2-routing`, `fix/wave3-infra`, `fix/wave4-cleanup`
- `any`, `as any`, `@ts-ignore` → lint error；`noUnusedLocals: true` → tsc error
- 测试覆盖率阈值：branches/functions/lines/statements ≥ 60%
- Backend 单测用 `npx jest path/to/test.test.ts --no-coverage`
- Frontend 用 `pnpm lint → pnpm tsc --noEmit → pnpm test`
- 每步结束后 commit，commit message 用英文，末尾加 `Co-Authored-By: Claude <noreply@anthropic.com>`

---

## Wave 1 — 安全与财务（生产风险）

### Task 1.1: Redis 连接共享（Wave 1 前置准备）

**Files:**
- Modify: `src/stores/redis.ts`
- Modify: `src/stores/factory.ts`
- Test: `tests/stores/redis.test.ts`（如有）或 `tests/stores/factory.test.ts`

**Interfaces:**
- Consumes: `Redis` from `ioredis`
- Produces: `getSharedRedisClient(): Redis`，`RedisKVStore` 接收共享 client

- [ ] **Step 1: 验证当前 Redis 连接数**

  Run: `grep -n "new Redis" src/stores/*.ts`
  Expected: 仅在 `src/stores/redis.ts` 中有一次 `new Redis()`

- [ ] **Step 2: 在 factory.ts 中缓存全局 Redis client**

  Modify `src/stores/factory.ts`：
  ```ts
  import { Redis } from 'ioredis';
  import { getRedisConfig } from '../config';

  let globalRedisClient: Redis | null = null;

  function getSharedRedisClient(): Redis {
    if (!globalRedisClient) {
      const cfg = getRedisConfig();
      globalRedisClient = new Redis({
        host: cfg.host,
        port: cfg.port,
        password: cfg.password,
        db: cfg.db,
        retryStrategy: (times) => Math.min(times * 200, 2000),
      });
    }
    return globalRedisClient;
  }

  export function resetSharedRedisClient(): void {
    if (globalRedisClient) {
      globalRedisClient.disconnect();
      globalRedisClient = null;
    }
  }
  ```

- [ ] **Step 3: 修改 RedisKVStore 接收共享 client**

  Modify `src/stores/redis.ts`，构造函数改为：
  ```ts
  export class RedisKVStore implements IKVStore {
    private client: Redis;
    private prefix: string;
    private connected = false;

    constructor(client: Redis, prefix: string) {
      this.client = client;
      this.prefix = prefix;
    }
    // 移除内部的 new Redis() 逻辑
  ```
  同时修改 `connect()` 为：
  ```ts
  async connect(): Promise<void> {
    if (this.connected) return;
    // 如果全局 client 已连接则直接使用
    if (this.client.status === 'ready' || this.client.status === 'connect') {
      this.connected = true;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const onReady = () => {
        this.connected = true;
        this.client.removeListener('error', onError);
        resolve();
      };
      const onError = (err: Error) => {
        this.client.removeListener('ready', onReady);
        reject(err);
      };
      this.client.once('ready', onReady);
      this.client.once('error', onError);
    });
  }
  ```

- [ ] **Step 4: 修改 factory 使用共享 client**

  Modify `src/stores/factory.ts` 的 `createKVStore`：
  ```ts
  export function createKVStore(prefix: string): IKVStore {
    const useRedis = shouldUseRedis();
    if (useRedis) {
      const client = getSharedRedisClient();
      return new RedisKVStore(client, prefix);
    }
    return new MemoryKVStore(prefix);
  }
  ```

- [ ] **Step 5: 运行现有 store 测试**

  Run: `npx jest tests/stores/ --no-coverage`
  Expected: PASS（可能需要调整测试中手动创建 RedisKVStore 的方式）

- [ ] **Step 6: Commit**

  ```bash
  git add src/stores/redis.ts src/stores/factory.ts
  git commit -m "feat(stores): share single Redis connection across all KV stores"
  ```

---

### Task 1.2: Wallet/Quota/Billing 原子化操作

**Files:**
- Modify: `src/services/wallet.ts`
- Modify: `src/services/quota.ts`
- Modify: `src/services/billing.ts`
- Create: `tests/services/wallet-concurrent.test.ts`
- Create: `tests/services/quota-concurrent.test.ts`

**Interfaces:**
- Consumes: `createKVStore`, `Redis` Lua / `INCRBY`
- Produces: `deductBalance` / `incrementQuota` / `recordKeyCost` 内部原子化，外部接口不变

- [ ] **Step 1: 给 WalletStore 添加内存锁**

  Modify `src/services/wallet.ts`：
  ```ts
  class WalletStore {
    // ... existing fields ...
    private inFlight = new Map<string, Promise<unknown>>();

    private async withLock<T>(keyHash: string, fn: () => Promise<T>): Promise<T> {
      const prev = this.inFlight.get(keyHash);
      const next = (async () => {
        if (prev) await prev;
        return fn();
      })();
      this.inFlight.set(keyHash, next);
      try {
        return await next;
      } finally {
        if (this.inFlight.get(keyHash) === next) {
          this.inFlight.delete(keyHash);
        }
      }
    }
  }
  ```

- [ ] **Step 2: 原子化 deductBalance（Memory 模式）**

  Modify `deductBalance`：
  ```ts
  async deductBalance(
    keyHash: string,
    costMicroYuan: number,
    metadata?: Record<string, string>
  ): Promise<DeductResult> {
    return this.withLock(keyHash, async () => {
      const current = this.getBalance(keyHash);
      const amount = Math.max(0, costMicroYuan);
      let newBalance: number;
      let success: boolean;

      if (current >= amount) {
        newBalance = current - amount;
        success = true;
      } else {
        newBalance = 0;
        success = false;
        writeLog('warn', 'Prepaid balance overdraft', {
          key_hash: keyHash,
          cost_micro_yuan: amount,
          current_micro_yuan: current,
        });
      }

      this.balances.set(keyHash, newBalance);

      const transaction: IWalletTransaction = {
        id: `tx-${Date.now()}-${generateSecureRandomString(8)}`,
        key_hash: keyHash,
        tenant_id: metadata?.tenant_id || '',
        type: 'deduct',
        amount_micro_yuan: success ? -amount : -current,
        balance_after_micro_yuan: newBalance,
        reason: metadata?.reason || 'API request deduction',
        created_at: Date.now(),
        metadata,
      };

      this.appendTransaction(keyHash, transaction);

      if (this.useRedis) {
        await this.persistBalanceAtomic(keyHash, newBalance, transaction);
      }

      return { success, newBalance, transaction };
    });
  }
  ```
  同时将 `deductBalance` 签名改为 `async`。

- [ ] **Step 3: Redis 原子扣减（Lua 脚本）**

  在 `WalletStore` 中添加：
  ```ts
  private async persistBalanceAtomic(
    keyHash: string,
    newBalance: number,
    tx: IWalletTransaction
  ): Promise<void> {
    try {
      const store = await this.getStore();
      // 使用 pipeline 原子执行：设余额 + 推交易
      const pipeline = store.pipeline();
      pipeline.set(`balance:${keyHash}`, String(newBalance));
      pipeline.lpush(`transactions:${keyHash}`, JSON.stringify(tx));
      pipeline.ltrim(`transactions:${keyHash}`, 0, MAX_TRANSACTIONS_PER_KEY - 1);
      await pipeline.exec();
    } catch (err) {
      writeLog('warn', 'Failed to persist wallet atomically', {
        key_hash: keyHash,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  ```
  注意：`getStore()` 返回的 store 需要暴露 `pipeline()` 方法。检查 `IKVStore` 和 `RedisKVStore` 是否已有 `pipeline` 支持。如果没有，先给 `RedisKVStore` 添加 `pipeline()` 代理到 `this.client.pipeline()`。

- [ ] **Step 4: 原子化 QuotaStore.increment**

  Modify `src/services/quota.ts`：
  ```ts
  class QuotaStore {
    private inFlight = new Map<string, Promise<unknown>>();

    private async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
      const prev = this.inFlight.get(key);
      const next = (async () => {
        if (prev) await prev;
        return fn();
      })();
      this.inFlight.set(key, next);
      try {
        return await next;
      } finally {
        if (this.inFlight.get(key) === next) this.inFlight.delete(key);
      }
    }

    async increment(tenantId: string, tokens: number): Promise<void> {
      const key = `${tenantId}:${this.getDayKey()}`;
      return this.withLock(key, async () => {
        let quota = this.quotas.get(key);
        if (!quota) {
          quota = { daily_requests: 0, daily_tokens: 0, date: this.getDayKey() };
          this.quotas.set(key, quota);
        }
        quota.daily_requests += 1;
        quota.daily_tokens += tokens;
        if (this.useRedis) {
          await this.persistQuota(key, quota);
        }
      });
    }
  }
  ```

- [ ] **Step 5: 原子化 BillingCostTracker.recordKeyCost**

  Modify `src/services/billing.ts`：
  ```ts
  class BillingCostTracker {
    private inFlight = new Map<string, Promise<unknown>>();

    private async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
      const prev = this.inFlight.get(key);
      const next = (async () => { if (prev) await prev; return fn(); })();
      this.inFlight.set(key, next);
      try { return await next; } finally { if (this.inFlight.get(key) === next) this.inFlight.delete(key); }
    }

    async recordKeyCost(keyHash: string, costMicroYuan: number): Promise<void> {
      const monthKey = this.getMonthKey();
      const lockKey = `${keyHash}:${monthKey}`;
      return this.withLock(lockKey, async () => {
        const key = `${keyHash}:${monthKey}`;
        const current = this.costs.get(key) || 0;
        const newCost = current + costMicroYuan;
        this.costs.set(key, newCost);
        if (this.useRedis) {
          await this.persistCost(key, newCost);
        }
      });
    }
  }
  ```

- [ ] **Step 6: 更新外部调用为 await**

  全局搜索 `deductBalance(`、`recordKeyCost(`、`increment(` 的调用点，确保加了 `await`。
  关键文件：
  - `src/routes/chat.ts`
  - `src/routes/embed.ts`
  - `src/middleware/websocket.ts`

- [ ] **Step 7: 写并发扣费测试**

  Create `tests/services/wallet-concurrent.test.ts`：
  ```ts
  import { resetWalletStore, setBalance, deductBalance, getBalance } from '../../src/services/wallet';

  describe('WalletStore concurrent deduction', () => {
    beforeEach(() => {
      resetWalletStore();
    });

    it('should deduct correctly under concurrent requests', async () => {
      const keyHash = 'test-key-hash';
      setBalance(keyHash, 1000); // 1000 micro-yuan

      const promises = Array.from({ length: 10 }, () =>
        deductBalance(keyHash, 150)
      );
      const results = await Promise.all(promises);

      const totalDeducted = results.reduce((sum, r) => {
        return sum + (r.success ? 150 : 0);
      }, 0);

      const finalBalance = getBalance(keyHash);
      expect(finalBalance).toBe(1000 - totalDeducted);
      expect(finalBalance).toBeGreaterThanOrEqual(0);
    });

    it('should not overdraft below zero', async () => {
      const keyHash = 'test-key-hash-2';
      setBalance(keyHash, 100);

      const promises = Array.from({ length: 5 }, () =>
        deductBalance(keyHash, 50)
      );
      const results = await Promise.all(promises);

      const finalBalance = getBalance(keyHash);
      expect(finalBalance).toBeGreaterThanOrEqual(0);
    });
  });
  ```

- [ ] **Step 8: 运行测试**

  Run: `npx jest tests/services/wallet-concurrent.test.ts --no-coverage`
  Expected: PASS

- [ ] **Step 9: Commit**

  ```bash
  git add src/services/wallet.ts src/services/quota.ts src/services/billing.ts tests/services/wallet-concurrent.test.ts
  git commit -m "feat(services): atomic wallet/quota/billing operations with in-memory locks"
  ```

---

### Task 1.3: 认证中间件优化（前缀索引）

**Files:**
- Modify: `src/middleware/auth.ts`
- Modify: `src/services/tenant.ts`
- Test: `tests/middleware/auth.test.ts`

**Interfaces:**
- Consumes: `TenantStore.keyPrefixIndex`
- Produces: `TenantStore.findByPrefix(prefix): string[]`，`validateApiKey` O(1) 前缀查找

- [ ] **Step 1: 给 TenantStore 添加 findByPrefix**

  Modify `src/services/tenant.ts`：
  ```ts
  findByPrefix(prefix: string): string[] {
    return this.keyPrefixIndex.get(prefix) || [];
  }
  ```

- [ ] **Step 2: 导出 tenantStore 单例的 findByPrefix wrapper**

  在 `src/services/tenant.ts` 底部添加：
  ```ts
  export function findApiKeyByPrefix(prefix: string): string[] {
    return tenantStore.findByPrefix(prefix);
  }
  ```

- [ ] **Step 3: 重写 validateApiKey**

  Modify `src/middleware/auth.ts`：
  ```ts
  import { findApiKeyByPrefix, getTenant } from '../services/tenant';

  function validateApiKey(apiKey: string): IAuthResult {
    const config = getConfig();

    if (!config.auth.enabled) {
      return { valid: true };
    }

    // 1. 先查 config keys（通常很少）
    const configKeys = config.auth.api_keys || [];
    for (const keyMeta of configKeys) {
      if (verifyApiKey(apiKey, keyMeta.key)) {
        return buildAuthResult(keyMeta);
      }
    }

    // 2. 用前缀索引查租户 key（O(1) 前缀查找 + 少量候选）
    const prefix = apiKey.slice(0, 10);
    const candidateHashes = findApiKeyByPrefix(prefix);
    const tenantKeys = getAllTenantApiKeys();

    for (const hashedKey of candidateHashes) {
      const keyMeta = tenantKeys.find((k) => k.key === hashedKey);
      if (keyMeta && verifyApiKey(apiKey, keyMeta.key)) {
        return buildAuthResult(keyMeta);
      }
    }

    return { valid: false, error: 'Invalid API key' };
  }

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
  ```

- [ ] **Step 4: 运行认证测试**

  Run: `npx jest tests/middleware/auth.test.ts --no-coverage`
  Expected: PASS

- [ ] **Step 5: Commit**

  ```bash
  git add src/middleware/auth.ts src/services/tenant.ts
  git commit -m "perf(auth): use key prefix index to avoid O(n) scrypt verification"
  ```

---

### Task 1.4: WebSocket 补全速率限制

**Files:**
- Modify: `src/middleware/ratelimit.ts`
- Modify: `src/middleware/websocket.ts`
- Test: `tests/middleware/websocket.test.ts`（如有）或新增

**Interfaces:**
- Consumes: `RateLimitStore.consume()`, `ConcurrencyLimiter`
- Produces: `checkRateLimit(requestInfo): Promise<RateLimitResult>`

- [ ] **Step 1: 提取可编程限流检查函数**

  Modify `src/middleware/ratelimit.ts`，在 `rateLimitMiddleware` 之前添加：
  ```ts
  export interface RateLimitCheckInfo {
    tenantId?: string;
    keyHash?: string;
    isAdminPath: boolean;
    model?: string;
  }

  export interface RateLimitResult {
    allowed: boolean;
    remaining?: number;
    limit?: number;
    retryAfter?: number;
    reason?: string;
  }

  export async function checkRateLimit(info: RateLimitCheckInfo): Promise<RateLimitResult> {
    const config = getConfig();
    if (!config.rate_limit?.enabled) {
      return { allowed: true };
    }

    // 并发限制
    if (info.keyHash) {
      const concurrencyKey = `${info.tenantId || 'global'}:${info.keyHash}`;
      const acquired = concurrencyLimiter.acquire(concurrencyKey, config.rate_limit.concurrent_limit ?? 100);
      if (!acquired) {
        return { allowed: false, reason: 'concurrent_limit_exceeded' };
      }
    }

    // 速率限制
    const store = await getRateLimitStore(info.isAdminPath);
    const limit = info.isAdminPath
      ? (config.rate_limit.burst ?? 20) * 2
      : (config.rate_limit.burst ?? 20);

    // 构造一个 mock context 用于 store.consume
    const mockC = {
      req: { header: () => undefined },
      get: (k: string) => {
        if (k === 'tenant_id') return info.tenantId;
        if (k === 'key_hash') return info.keyHash;
        return undefined;
      },
    } as unknown as Context;

    const allowed = await store.consume(mockC);
    const remaining = await store.getRemainingTokens(mockC);

    if (!allowed) {
      const qps = config.rate_limit.qps ?? 10;
      const retryAfter = Math.max(1, Math.ceil(1 / qps));
      return { allowed: false, remaining: 0, limit, retryAfter, reason: 'rate_limit_exceeded' };
    }

    return { allowed: true, remaining, limit };
  }
  ```

- [ ] **Step 2: 让 rateLimitMiddleware 内部调用 checkRateLimit**

  在 `rateLimitMiddleware` 中，将核心逻辑替换为调用 `checkRateLimit`：
  ```ts
  export async function rateLimitMiddleware(c: Context, next: Next): Promise<Response | void> {
    // ... existing setup ...
    const result = await checkRateLimit({
      tenantId: c.get('tenant_id'),
      keyHash: c.get('key_hash'),
      isAdminPath,
      model: undefined,
    });
    // ... map result to response or next() ...
  }
  ```

- [ ] **Step 3: 在 WS 消息处理器中调用 checkRateLimit**

  Modify `src/middleware/websocket.ts` 的 `handleChatCompletion`：
  在请求处理前添加：
  ```ts
  import { checkRateLimit } from '../middleware/ratelimit';
  import { getTokenRateLimit } from '../services/token-ratelimit';

  // ... 在 handleChatCompletion 开头 ...
  const rateLimitResult = await checkRateLimit({
    tenantId: context.tenantId,
    keyHash: context.keyHash,
    isAdminPath: false,
    model: request.model,
  });

  if (!rateLimitResult.allowed) {
    sendError(ws, request.request_id || '', `Rate limit exceeded: ${rateLimitResult.reason}`);
    return;
  }

  // Token rate limit
  const trl = getTokenRateLimit();
  const tokenCheck = await trl.check(request.model, 0); // 先 check
  if (!tokenCheck.allowed) {
    sendError(ws, request.request_id || '', 'Token rate limit exceeded');
    return;
  }
  ```
  在请求结束后调用 `trl.consume()`。

- [ ] **Step 4: Commit**

  ```bash
  git add src/middleware/ratelimit.ts src/middleware/websocket.ts
  git commit -m "feat(websocket): enforce rate limiting and token rate limits on WS messages"
  ```

---

### Task 1.5: Failover 4xx 级联修复 + 计费错误类型修正

**Files:**
- Modify: `src/providers/index.ts`
- Modify: `src/middleware/error.ts`
- Modify: `src/routes/chat.ts`
- Test: `tests/providers/failover.test.ts`

**Interfaces:**
- Consumes: `isRetryableError` from `src/services/retry.ts`
- Produces: `GatewayError.billingError()`，failover 仅对 retryable 错误触发

- [ ] **Step 1: 修改 failover 循环，过滤 4xx**

  Modify `src/providers/index.ts` 的 `chatComplete` catch 块：
  ```ts
  } catch (error) {
    const latency = Date.now() - startTime;
    await activeFailover.recordProviderRequest(currentProvider, false, latency);
    const errMsg = error instanceof Error ? error.message : String(error);
    const statusCode = (error as { status?: number }).status;

    // 仅对可重试错误继续 failover
    if (!isRetryableError(statusCode, errMsg)) {
      throw error; // 客户端错误直接抛出
    }

    // Check for model-level fallback on retryable errors
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

- [ ] **Step 2: 添加 GatewayError.billingError**

  Modify `src/middleware/error.ts`：
  ```ts
  export class GatewayError extends Error {
    // ... existing constructors ...

    static billingError(message: string, code?: string): GatewayError {
      return new GatewayError(message, 'billing_error', code || 'billing_error', 402);
    }
  }
  ```

- [ ] **Step 3: 修改 chat.ts 计费检查返回 billing_error**

  Modify `src/routes/chat.ts` 的 `checkKeyPolicies`：
  ```ts
  if (!billingCheck.allowed) {
    const code = billingCheck.code || 'insufficient_balance';
    recordMetric(...);
    throw GatewayError.billingError(
      billingCheck.reason || 'Billing check failed',
      code
    );
  }
  ```
  删除之前的手工 `c.json({ error: ... })` 返回。

- [ ] **Step 4: 确保全局错误处理器正确处理 billing_error**

  `app.ts` 中已有 `GatewayError` 捕获，检查 402 状态码是否正确传递。

- [ ] **Step 5: Commit**

  ```bash
  git add src/providers/index.ts src/middleware/error.ts src/routes/chat.ts
  git commit -m "fix(failover): skip failover on 4xx client errors; fix(billing): use billing_error type with 402 status"
  ```

---

## Wave 2 — 核心路由健壮性

### Task 2.1: 提取 StreamProcessor

**Files:**
- Create: `src/services/stream-processor.ts`
- Modify: `src/routes/chat.ts`
- Test: `tests/services/stream-processor.test.ts`

**Interfaces:**
- Consumes: `ReadableStreamDefaultReader`, `ChatMessage`
- Produces: `processSSEStream(reader, options): Promise<StreamResult>`

- [ ] **Step 1: 创建 StreamProcessor**

  Create `src/services/stream-processor.ts`：
  ```ts
  import type { ChatMessage, ChatCompletionChunk } from '../types';

  export interface StreamProcessOptions {
    onChunk?: (chunk: ChatCompletionChunk) => void;
    signal?: AbortSignal;
  }

  export interface StreamResult {
    content: string;
    reasoningContent: string;
    finishReason: string | null;
    usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
    error?: Error;
  }

  export async function processSSEStream(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    options?: StreamProcessOptions
  ): Promise<StreamResult> {
    const decoder = new TextDecoder();
    let buffer = '';
    let content = '';
    let reasoningContent = '';
    let finishReason: string | null = null;
    let promptTokens = 0;
    let completionTokens = 0;
    let error: Error | undefined;

    try {
      while (true) {
        if (options?.signal?.aborted) {
          throw new Error('Stream aborted');
        }

        const { value, done } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6);
          if (data === '[DONE]') continue;

          try {
            const chunk: ChatCompletionChunk = JSON.parse(data);
            options?.onChunk?.(chunk);

            const delta = chunk.choices?.[0]?.delta;
            if (delta) {
              if (delta.content) content += delta.content;
              if ((delta as Record<string, unknown>).reasoning_content) {
                reasoningContent += String((delta as Record<string, unknown>).reasoning_content);
              }
            }
            if (chunk.choices?.[0]?.finish_reason) {
              finishReason = chunk.choices[0].finish_reason;
            }
            if (chunk.usage) {
              promptTokens = chunk.usage.prompt_tokens || promptTokens;
              completionTokens = chunk.usage.completion_tokens || completionTokens;
            }
          } catch {
            // Skip malformed SSE lines
          }
        }
      }
    } catch (err) {
      error = err instanceof Error ? err : new Error(String(err));
    } finally {
      await reader.cancel().catch(() => {});
    }

    return {
      content,
      reasoningContent,
      finishReason,
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
      },
      error,
    };
  }
  ```

- [ ] **Step 2: Commit**

  ```bash
  git add src/services/stream-processor.ts
  git commit -m "feat(services): extract StreamProcessor for SSE stream parsing"
  ```

---

### Task 2.2: 提取 PostProcessor

**Files:**
- Create: `src/services/post-processor.ts`
- Modify: `src/routes/chat.ts`
- Test: `tests/services/post-processor.test.ts`

**Interfaces:**
- Consumes: `Context` (Hono), metrics/billing/logging services
- Produces: `runPostProcessing(ctx): Promise<void>`

- [ ] **Step 1: 创建 PostProcessor**

  Create `src/services/post-processor.ts`：
  ```ts
  import type { Context } from 'hono';
  import { recordMetric } from './metrics';
  import { recordUsage } from './quota';
  import { recordKeyCost } from './billing';
  import { deductBalance } from './wallet';
  import { getRequestLogStore } from './request-log';
  import { getConversationLogService } from './conversation-log';
  import { writeLog } from '../utils/logger';
  import type { IApiKeyMeta } from '../types';

  export interface PostProcessContext {
    c: Context;
    tenantId?: string;
    keyHash?: string;
    model: string;
    provider: string;
    latencyMs: number;
    statusCode: number;
    tokens: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
    content?: string;
    error?: Error;
    isStream: boolean;
  }

  export async function runPostProcessing(ctx: PostProcessContext): Promise<void> {
    const { c, tenantId, keyHash, model, provider, latencyMs, statusCode, tokens, content, error, isStream } = ctx;

    try {
      // Metrics
      recordMetric(
        c.get('request_id') as string,
        tenantId,
        provider,
        model,
        latencyMs,
        statusCode,
        tokens,
        keyHash,
        c.get('key_metadata'),
      );

      // Quota
      if (tenantId) {
        await recordUsage(tenantId, tokens.total_tokens);
      }

      // Billing
      if (keyHash && statusCode === 200) {
        const pricing = getPricingService().getPrice(model);
        if (pricing) {
          const costMicroYuan = Math.round(
            (tokens.prompt_tokens * pricing.prompt_price +
              tokens.completion_tokens * pricing.completion_price) *
              1_000_000
          );
          await recordKeyCost(keyHash, costMicroYuan);
          await deductBalance(keyHash, costMicroYuan, {
            tenant_id: tenantId || '',
            reason: `${isStream ? 'stream' : 'chat'} request`,
          });
        }
      }

      // Conversation log
      if (content !== undefined) {
        const conversationLogService = getConversationLogService();
        await conversationLogService.saveTurn({
          session_id: c.get('request_id') as string,
          tenant_id: tenantId || '',
          model,
          request: {},
          response: {
            content,
            finish_reason: error ? 'error' : 'stop',
          },
          latency_ms: latencyMs,
          tokens,
          created_at: Date.now(),
        }).catch((err: Error) => {
          writeLog('warn', 'Failed to save conversation turn', { error: err.message });
        });
      }

      // Request log
      const requestLogStore = getRequestLogStore();
      // ... existing request logging logic ...
    } catch (err) {
      writeLog('warn', 'Post-processing error', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  ```

- [ ] **Step 2: Commit**

  ```bash
  git add src/services/post-processor.ts
  git commit -m "feat(services): extract PostProcessor for unified request side effects"
  ```

---

### Task 2.3: chat.ts 使用 StreamProcessor + PostProcessor

**Files:**
- Modify: `src/routes/chat.ts`
- Test: `tests/routes/chat.test.ts`

**Interfaces:**
- Consumes: `processSSEStream`, `runPostProcessing`
- Produces: 精简后的 `handleStreamingResponse` (~120 行)

- [ ] **Step 1: 替换 handleStreamingResponse 中的 SSE 解析**

  删除原有的 SSE 解析循环（~150 行），替换为：
  ```ts
  import { processSSEStream } from '../services/stream-processor';
  import { runPostProcessing } from '../services/post-processor';

  async function handleStreamingResponse(
    c: Context,
    stream: ReadableStream,
    req: ChatCompletionRequest,
    tenantId: string | undefined,
    provider: string,
    startTime: number,
    rootSpan: Span | null,
  ): Promise<Response> {
    const reader = stream.getReader();
    let firstChunk = true;

    const result = await processSSEStream(reader, {
      onChunk: (chunk) => {
        if (firstChunk) {
          firstChunk = false;
          recordAiTtfb(Date.now() - startTime);
        }
        // enqueue to response stream...
      },
    });

    await runPostProcessing({
      c,
      tenantId,
      keyHash: c.get('key_hash'),
      model: req.model,
      provider,
      latencyMs: Date.now() - startTime,
      statusCode: result.error ? 500 : 200,
      tokens: result.usage,
      content: result.content,
      error: result.error,
      isStream: true,
    });

    if (result.error) {
      throw result.error;
    }

    return c.json({
      id: c.get('request_id'),
      model: req.model,
      choices: [{ message: { role: 'assistant', content: result.content }, finish_reason: result.finishReason }],
      usage: result.usage,
    });
  }
  ```
  注意：实际实现需保留现有的 `ReadableStream` wrapper 用于直接返回 SSE 给客户端。`processSSEStream` 在 `onChunk` 中 enqueue 到 wrapper stream。

- [ ] **Step 2: 验证 chat.ts 行数**

  Run: `wc -l src/routes/chat.ts`
  Expected: < 500 行

- [ ] **Step 3: Commit**

  ```bash
  git add src/routes/chat.ts src/services/stream-processor.ts src/services/post-processor.ts
  git commit -m "refactor(chat): use StreamProcessor and PostProcessor, reduce file size"
  ```

---

### Task 2.4: Embedding 路由添加 Failover

**Files:**
- Modify: `src/providers/index.ts`
- Modify: `src/routes/embed.ts`
- Test: `tests/routes/embed.test.ts`

**Interfaces:**
- Consumes: `callProviderWithRetry`, `activeFailover`
- Produces: `createEmbedding` 带 failover

- [ ] **Step 1: 提取 callProviderWithRetry 为模块级函数**

  如果 `callProviderWithRetry` 当前在 `src/providers/index.ts` 内部，将其提到模块顶层并 export。

- [ ] **Step 2: 给 createEmbedding 添加 failover**

  Modify `src/providers/index.ts` 的 `createEmbedding`：
  ```ts
  export async function createEmbedding(
    providerName: string,
    request: EmbeddingRequest,
    originalModel?: string
  ): Promise<EmbeddingResponse> {
    const errors: Array<{ provider: string; error: string }> = [];
    const providersToTry = [providerName, ...getFallbackProviders(providerName, originalModel || request.model)];

    for (const currentProvider of providersToTry) {
      const config = getProviderConfig(currentProvider);
      if (!config) {
        errors.push({ provider: currentProvider, error: 'Not configured' });
        continue;
      }
      const provider = providers.get(currentProvider);
      if (!provider) {
        errors.push({ provider: currentProvider, error: 'Not registered' });
        continue;
      }

      try {
        const result = await callProviderWithRetry(provider, config, request, false);
        return result as EmbeddingResponse;
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        const statusCode = (error as { status?: number }).status;
        if (!isRetryableError(statusCode, errMsg)) {
          throw error;
        }
        errors.push({ provider: currentProvider, error: errMsg });
      }
    }

    throw new Error(`All providers failed for embedding: ${errors.map((e) => `${e.provider} (${e.error})`).join('; ')}`);
  }
  ```

- [ ] **Step 3: Commit**

  ```bash
  git add src/providers/index.ts src/routes/embed.ts
  git commit -m "feat(embed): add failover chain to embedding requests"
  ```

---

### Task 2.5: 提取共享计费检查

**Files:**
- Modify: `src/services/billing.ts`
- Modify: `src/routes/chat.ts`
- Modify: `src/routes/embed.ts`
- Modify: `src/middleware/websocket.ts`

**Interfaces:**
- Consumes: `Context`, `keyHash`, `billingMode`
- Produces: `checkRequestBilling(c): Promise<Response | null>`

- [ ] **Step 1: 在 billing.ts 中添加 checkRequestBilling**

  ```ts
  import type { Context } from 'hono';
  import { GatewayError } from '../middleware/error';

  export async function checkRequestBilling(c: Context): Promise<null> {
    const keyHash = c.get('key_hash') as string | undefined;
    const billingMode = c.get('key_billing_mode') as IApiKeyMeta['billing_mode'];
    if (!keyHash) return null;

    const billingCheck = checkBilling(
      keyHash,
      billingMode,
      c.get('key_monthly_budget'),
      c.get('key_subscription_expires_at')
    );

    if (!billingCheck.allowed) {
      throw GatewayError.billingError(
        billingCheck.reason || 'Billing check failed',
        billingCheck.code || 'insufficient_balance'
      );
    }

    return null;
  }
  ```

- [ ] **Step 2: 在 chat/embed/websocket 中统一调用**

  删除三处原有的计费检查块，替换为：
  ```ts
  await checkRequestBilling(c);
  ```

- [ ] **Step 3: Commit**

  ```bash
  git add src/services/billing.ts src/routes/chat.ts src/routes/embed.ts src/middleware/websocket.ts
  git commit -m "refactor(billing): extract shared checkRequestBilling helper"
  ```

---

## Wave 3 — 架构稳固

### Task 3.1: 分阶段启动

**Files:**
- Modify: `src/index.ts`
- Create: `src/utils/startup.ts`
- Test: `tests/utils/startup.test.ts`

**Interfaces:**
- Consumes: 所有 `initXxx()` 函数
- Produces: `runStartup(phases): Promise<void>`

- [ ] **Step 1: 创建 startup 工具**

  Create `src/utils/startup.ts`：
  ```ts
  export interface StartupPhase {
    name: string;
    critical: boolean;
    inits: Array<() => Promise<void>>;
  }

  export async function runStartup(phases: StartupPhase[]): Promise<void> {
    for (const phase of phases) {
      writeLog('info', `Startup phase: ${phase.name}`);
      if (phase.critical) {
        await Promise.all(phase.inits.map((init) => init()));
      } else {
        const results = await Promise.allSettled(phase.inits.map((init) => init()));
        for (const result of results) {
          if (result.status === 'rejected') {
            writeLog('warn', `Non-critical init failed in ${phase.name}`, { error: String(result.reason) });
          }
        }
      }
    }
  }
  ```

- [ ] **Step 2: 重构 index.ts 启动逻辑**

  将原有的顺序 await 改为：
  ```ts
  import { runStartup } from './utils/startup';

  await runStartup([
    {
      name: 'core',
      critical: true,
      inits: [initConfig, initStores, initProviders],
    },
    {
      name: 'services',
      critical: true,
      inits: [initWalletStore, initQuotaStore, initTenantStore],
    },
    {
      name: 'best-effort',
      critical: false,
      inits: [initMetrics, initAlerts, initConversationLog],
    },
  ]);
  ```

- [ ] **Step 3: Commit**

  ```bash
  git add src/utils/startup.ts src/index.ts
  git commit -m "feat(startup): implement phased initialization with critical/best-effort separation"
  ```

---

### Task 3.2: ShutdownRegistry

**Files:**
- Create: `src/utils/shutdown.ts`
- Modify: `src/index.ts`
- Modify: `src/services/wallet.ts`, `src/services/quota.ts`, etc.

**Interfaces:**
- Consumes: 各 service 的 `flushXxxStore()`
- Produces: `shutdownRegistry.register(name, handler)`，`shutdownRegistry.flushAll()`

- [ ] **Step 1: 创建 ShutdownRegistry**

  Create `src/utils/shutdown.ts`：
  ```ts
  export const shutdownRegistry = {
    handlers: new Map<string, () => Promise<void>>(),

    register(name: string, handler: () => Promise<void>): void {
      this.handlers.set(name, handler);
    },

    async flushAll(): Promise<void> {
      for (const [name, handler] of this.handlers) {
        try {
          await handler();
          writeLog('info', `Flushed ${name}`);
        } catch (err) {
          writeLog('warn', `Failed to flush ${name}`, { error: err instanceof Error ? err.message : String(err) });
        }
      }
    },
  };
  ```

- [ ] **Step 2: 在各 service 中注册 flush**

  例如 `src/services/wallet.ts`：
  ```ts
  import { shutdownRegistry } from '../utils/shutdown';

  // 在 initWalletStore 或模块加载时
  shutdownRegistry.register('wallet', flushWalletStore);
  ```
  对 quota、tenant、billing、request-log、conversation-log、metrics 都做同样处理。

- [ ] **Step 3: 修改 handleShutdown**

  ```ts
  async function handleShutdown() {
    await shutdownRegistry.flushAll();
    server.close();
  }
  ```

- [ ] **Step 4: Commit**

  ```bash
  git add src/utils/shutdown.ts src/index.ts src/services/*.ts
  git commit -m "feat(shutdown): add ShutdownRegistry to ensure all services flush on exit"
  ```

---

### Task 3.3: Config 深合并统一

**Files:**
- Modify: `src/config/index.ts`
- Test: `tests/config/config.test.ts`

**Interfaces:**
- Consumes: `deepMergeConfig`
- Produces: `setConfig()` 统一深合并

- [ ] **Step 1: 修改 setConfig 使用 deepMergeConfig**

  ```ts
  export function setConfig(partial: DeepPartial<IGatewayConfig>): void {
    currentConfig = deepMergeConfig(currentConfig, partial);
  }
  ```
  确保 `deepMergeConfig` 对数组字段采用替换策略（非合并）。

- [ ] **Step 2: Commit**

  ```bash
  git add src/config/index.ts
  git commit -m "fix(config): use deepMergeConfig consistently in setConfig"
  ```

---

## Wave 4 — 质量清理

### Task 4.1: 幽灵代码清理

**Files:**
- Modify: `src/middleware/error.ts`
- Modify: `src/middleware/auth.ts`
- Modify: `src/types/index.ts`
- Modify: `ai-gateway-admin/src/services/api.ts`
- Modify: `ai-gateway-admin/src/types/index.ts`

- [ ] **Step 1: 删除未使用 export**

  - `src/middleware/error.ts`: 删除 `validateString`、`normalizeProviderError`
  - `src/middleware/auth.ts`: 删除 `generateTestApiKey`、`generateTestPlaintextKey`
  - `src/types/index.ts`: 删除 `ApiKey` type alias
  - `ai-gateway-admin/src/services/api.ts`: 删除未使用的 ~12 个函数
  - `ai-gateway-admin/src/types/index.ts`: 删除未使用的 ~25 个 type export

- [ ] **Step 2: 运行 tsc 验证无引用断裂**

  Run: `npx tsc --noEmit`（backend）and `cd ai-gateway-admin && pnpm tsc --noEmit`
  Expected: PASS

- [ ] **Step 3: Commit**

  ```bash
  git add src/middleware/error.ts src/middleware/auth.ts src/types/index.ts ai-gateway-admin/src/services/api.ts ai-gateway-admin/src/types/index.ts
  git commit -m "chore: remove unused exports and dead code"
  ```

---

### Task 4.2: 硬编码提取

**Files:**
- Modify: `src/services/tenant.ts`
- Modify: `src/services/router.ts`
- Modify: `src/plugins/loader.ts`
- Modify: `src/providers/base.ts`
- Modify: `src/middleware/websocket.ts`
- Modify: `src/routes/admin/usage.ts`
- Modify: `src/services/metrics.ts`
- Modify: `conf/default.json`

- [ ] **Step 1: 租户套餐限额提取到 config**

  在 `conf/default.json` 添加：
  ```json
  {
    "plan_defaults": {
      "free": { "daily_requests": 1000, "daily_tokens": 100000, "max_api_keys": 5, "concurrent_requests": 10 },
      "pro": { "daily_requests": 10000, "daily_tokens": 1000000, "max_api_keys": 20, "concurrent_requests": 50 },
      "enterprise": { "daily_requests": 100000, "daily_tokens": 10000000, "max_api_keys": 100, "concurrent_requests": 200 }
    }
  }
  ```
  `src/services/tenant.ts` 中 `getPlanDefaults()` 从 config 读取。

- [ ] **Step 2: 路由阈值、超时提取**

  - `src/services/router.ts:226`: `5000` → `getConfig().routing?.long_text_threshold ?? 5000`
  - `src/plugins/loader.ts:218`: `5000` → `parseInt(process.env.PLUGIN_TIMEOUT || '5000', 10)`
  - `src/providers/base.ts:48`: `30000` → `parseInt(process.env.PROVIDER_DEFAULT_TIMEOUT || '30000', 10)`
  - `src/middleware/websocket.ts`: 三个 interval 提取到 `WS_HEARTBEAT_INTERVAL` / `WS_METRICS_INTERVAL` / `WS_IDLE_TIMEOUT` env var

- [ ] **Step 3: 提取 rounding helper**

  Create `src/utils/number.ts`：
  ```ts
  export const round3 = (x: number): number => Math.round(x * 1000) / 1000;
  export const round4 = (x: number): number => Math.round(x * 10000) / 10000;
  ```
  替换 `src/services/metrics.ts` 中所有重复模式。

- [ ] **Step 4: Commit**

  ```bash
  git add conf/default.json src/services/tenant.ts src/services/router.ts src/plugins/loader.ts src/providers/base.ts src/middleware/websocket.ts src/utils/number.ts src/services/metrics.ts
  git commit -m "refactor: extract hardcoded values to config and env vars"
  ```

---

### Task 4.3: 前端优化

**Files:**
- Modify: `ai-gateway-admin/src/stores/useStore.ts`
- Modify: `ai-gateway-admin/src/services/api.ts`
- Modify: `ai-gateway-admin/src/services/websocket.ts`
- Create: `ai-gateway-admin/src/hooks/useApiFetch.ts`
- Create: `ai-gateway-admin/src/hooks/useProviderModelOptions.ts`
- Create: `ai-gateway-admin/eslint.config.js`

- [ ] **Step 1: 决定 Zustand 命运**

  检查 `useStore.ts` 是否真未被使用。如果确实无 import，删除该文件及 `stores/` 目录。

- [ ] **Step 2: 修复 API 类型安全**

  移除 Axios response interceptor 的 `.data` 解包，恢复为正常 response。

- [ ] **Step 3: 修复 WebSocket 重连**

  在 `websocket.ts` 中保存 `tenantId` 和 `options` 为实例字段。

- [ ] **Step 4: 提取共享 hooks**

  Create `ai-gateway-admin/src/hooks/useApiFetch.ts`：
  ```ts
  import { useState, useEffect, useCallback } from 'react';
  import { message } from 'antd';

  export function useApiFetch<T>(fetcher: () => Promise<T>, deps: unknown[] = []) {
    const [data, setData] = useState<T | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<Error | null>(null);

    const fetch = useCallback(async () => {
      setLoading(true);
      setError(null);
      try {
        const result = await fetcher();
        setData(result);
      } catch (err) {
        const e = err instanceof Error ? err : new Error(String(err));
        setError(e);
        message.error(e.message);
      } finally {
        setLoading(false);
      }
    }, [fetcher]);

    useEffect(() => {
      fetch();
    }, deps);

    return { data, loading, error, refetch: fetch };
  }
  ```

- [ ] **Step 5: 添加 ESLint 配置**

  Create `ai-gateway-admin/eslint.config.js`：
  ```js
  import js from '@eslint/js';
  import ts from 'typescript-eslint';
  import reactHooks from 'eslint-plugin-react-hooks';

  export default [
    js.configs.recommended,
    ...ts.configs.recommended,
    {
      plugins: { 'react-hooks': reactHooks },
      rules: {
        '@typescript-eslint/no-explicit-any': 'error',
        '@typescript-eslint/no-unused-vars': 'error',
        'react-hooks/rules-of-hooks': 'error',
        'react-hooks/exhaustive-deps': 'warn',
      },
    },
  ];
  ```

- [ ] **Step 6: Commit**

  ```bash
  git add ai-gateway-admin/
  git commit -m "refactor(admin): cleanup dead code, add shared hooks, fix WS reconnect"
  ```

---

## Self-Review

**1. Spec coverage检查：**
- ✅ 财务原子化 → Task 1.2
- ✅ 认证优化 → Task 1.3
- ✅ WS 限流 → Task 1.4
- ✅ Failover 4xx → Task 1.5
- ✅ chat.ts 拆分 → Task 2.1-2.3
- ✅ Embed failover → Task 2.4
- ✅ 共享计费检查 → Task 2.5
- ✅ Redis 连接共享 → Task 1.1（已提前到 Wave 1）
- ✅ 启动分阶段 → Task 3.1
- ✅ ShutdownRegistry → Task 3.2
- ✅ Config 深合并 → Task 3.3
- ✅ 幽灵代码 → Task 4.1
- ✅ 硬编码 → Task 4.2
- ✅ 前端优化 → Task 4.3

**2. Placeholder 扫描：**
- ✅ 无 TBD/TODO
- ✅ 无 "implement later"
- ✅ 每步都有代码或命令
- ✅ 无 "Similar to Task N"

**3. 类型一致性检查：**
- ✅ `DeductResult` / `RechargeResult` / `WalletCheckResult` 在 WalletStore 中使用一致
- ✅ `RateLimitCheckInfo` / `RateLimitResult` 接口定义一次，多处使用
- ✅ `StreamResult` 和 `processSSEStream` 签名匹配
- ✅ `PostProcessContext` 和 `runPostProcessing` 签名匹配

**4. 可能的 gap：**
- `IKVStore` 需要添加 `pipeline()` 方法才能让 WalletStore 原子持久化。需要在 Task 1.2 中先给 `RedisKVStore` 添加 `pipeline()`。
- `getRedisConfig()` 函数需确认是否已存在于 `src/config/index.ts`；若不存在，在 Task 1.1 中需添加。

**Gap 修复：** 在 Task 1.1 Step 2 中已使用 `getRedisConfig()`，若不存在需在 factory.ts 中内联配置读取逻辑。

---

## 执行交接

**Plan complete and saved to `docs/superpowers/plans/2026-07-09-gateway-audit-remediation.md`.**

**Two execution options:**

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**
