# AI Gateway 综合审查修复方案设计

**Date**: 2026-07-09
**Scope**: 覆盖 64 项审查发现（13 HIGH / 37 MEDIUM / 14 LOW）
**Strategy**: 混合分波 — 安全优先 + 子系统边界

---

## 1. 总体策略

采用 **4 波混合修复**：
- Wave 1 消灭全部生产安全风险（HIGH 中的财务/认证/限流/failover）
- Wave 2 解决核心路由技术债务（chat.ts 拆分 + 流式健壮性 + embed failover）
- Wave 3 架构稳固（Redis 连接共享 + 启动分阶段 + 关闭注册表 + config 合并）
- Wave 4 质量清理（幽灵代码 + 硬编码提取 + 前端优化 + 重复代码统一）

每波独立 review、独立测试、可独立 merge。不造轮子，不引入外部依赖（除非已有）。

---

## 2. Wave 1 — 安全与财务（生产风险）

### 2.1 原子化 Wallet/Quota/Billing 操作

**问题**：`deductBalance`、`increment`、`recordKeyCost` 均为读-改-写，并发下可超扣/超限。

**方案**：
- **Memory 模式**：在 `WalletStore`、`QuotaStore`、`BillingCostTracker` 中引入 `inFlight: Map<string, Promise>` 队列锁。同一 key 的扣减/增量串行化，不同 key 并行。
  ```ts
  private inFlight = new Map<string, Promise<unknown>>();
  private async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.inFlight.get(key);
    const next = (async () => { if (prev) await prev; return fn(); })();
    this.inFlight.set(key, next);
    try { return await next; } finally { if (this.inFlight.get(key) === next) this.inFlight.delete(key); }
  }
  ```
- **Redis 模式**：
  - Wallet 余额使用 `INCRBY` 原子扣减（负数表示扣除）。Lua 脚本检查余额充足性。
  - Quota 使用 `HINCRBY` + Lua 脚本检查上限。
  - Billing 使用 `INCRBY` 原子累加月度成本。
- **接口不变**：外部调用 `deductBalance(keyHash, cost)` 无需改动，内部实现原子化。

**测试策略**：
- 并发测试：启动 10 个并行请求对同一 key 扣费，验证最终余额 = 初始 - 总扣费，无负余额。
- 单测覆盖 `withLock` 的串行保证。

### 2.2 认证中间件优化（消除 O(n) scrypt）

**问题**：`authMiddleware` 对 ALL keys 执行 `verifyApiKey`（scrypt），100+ key 时延迟线性增长。

**方案**：
- `TenantStore` 已维护 `keyPrefixIndex: Map<string, string[]>`（10 字符前缀 → hashedKey 列表）。
- 修改 `validateApiKey(apiKey)`：
  1. 提取 `apiKey` 前 10 字符为 `prefix`。
  2. 查 `tenantStore.findByPrefix(prefix)` → 候选 key 列表（通常 1-2 个）。
  3. 对候选 key 执行 `verifyApiKey`。
  4. 若都不匹配，回退到 config key 检查（config key 通常 < 10 个，量极小）。
- 新增 `TenantStore.findByPrefix(prefix): string[]` 方法。
- 移除 `getAllApiKeys()` 的 O(n) 遍历。

**测试策略**：
- 性能基准：100 个租户 key 下，认证延迟从 ~300ms 降至 < 20ms。
- 正确性：确保前缀冲突（两个 key 前 10 字符相同）时仍能正确匹配。

### 2.3 WebSocket 补全速率限制

**问题**：WS 消息处理器未调用 `rateLimitMiddleware`，不检查 QPS/burst/token-rate-limit/concurrency。

**方案**：
- 将限流检查逻辑从 Hono middleware 提取为可编程函数 `checkRateLimit(requestInfo: RateLimitRequestInfo): Promise<RateLimitResult>`。
- `RateLimitRequestInfo` 包含：tenantId, keyHash, isAdminPath, model（用于 token-rate-limit）。
- `rateLimitMiddleware` 内部调用 `checkRateLimit`。
- `handleWSMessage` → `handleChatCompletion` 在业务逻辑前显式调用 `checkRateLimit`，若拒绝则发送 WS error 消息并关闭。
- 并发限制：复用 `ConcurrencyLimiter`，WS 连接也占一个并发槽。

**测试策略**：
- WS 客户端发送 100 条消息/秒，验证被限流返回 error。
- 并发限制：打开超过限制数量的 WS 连接，验证新连接被拒绝。

### 2.4 Failover 4xx 级联修复

**问题**：`chatComplete()` 捕获任何错误都继续 failover，导致客户端错误（4xx）也级联浪费 quota。

**方案**：
- 在 `catch` 块中检查 `statusCode`：
  - `isRetryableError(statusCode, errMsg)` 为 true（5xx / 网络 / 429）→ 继续 failover。
  - 4xx 错误（400, 401, 403, 404 等）→ 立即抛出，不继续 failover。
- `isRetryableError` 已存在于 `src/services/retry.ts`，复用即可。

**测试策略**：
- mock provider 返回 404，验证 failover 不触发，直接返回 404 error。
- mock provider 返回 503，验证 failover 正常切换。

### 2.5 计费错误类型语义修正

**问题**：余额不足返回 `rate_limit_error`，订阅过期返回 `authentication_error`。

**方案**：
- 新增 `billing_error` error type 到 `GatewayError`。
- 余额不足 → `type: 'billing_error', code: 'insufficient_balance'`。
- 订阅过期 → `type: 'billing_error', code: 'subscription_expired'`。
- 月预算超限 → `type: 'billing_error', code: 'monthly_budget_exceeded'`。
- HTTP 状态码统一 402（Payment Required）。

**兼容性**：前端需要更新错误处理逻辑以识别 `billing_error`。Wave 1 一并修改。

---

## 3. Wave 2 — 核心路由健壮性

### 3.1 chat.ts 拆分（Surgical，不拆过度）

**当前**：891 行，`handleStreamingResponse` ~230 行，`handleNonStreamingResponse` ~180 行。

**拆分方案**：
- **`src/services/stream-processor.ts`**（~200 行）：
  - `processSSEStream(reader, onChunk, onComplete, onError)`
  - 负责 SSE 解析、内容累积、token 计数、finish_reason 收集。
  - 流式错误时通过 `onError` 回调返回已累积的内容，确保 caller 可以记录 billing/metrics。
- **`src/services/post-processor.ts`**（~150 行）：
  - `runPostProcessing(ctx: PostProcessContext)`
  - 统一执行：billing deduction、metrics recording、conversation logging、request logging。
  - 被 stream 的 `finally` 和非 stream 的末尾调用，确保无论成功/失败都执行。
- **`src/routes/chat.ts`** 保留：
  - 路由注册、Zod 校验、checkKeyPolicies、checkCaches、pipeline 编排、provider 调用、response 返回。
  - 目标压缩到 ~400 行。

**边界原则**：
- 不引入 DI 框架、不创建抽象基类。
- StreamProcessor 和 PostProcessor 是纯函数/简单类，无外部依赖（除了 token-counter）。

### 3.2 流式响应错误兜底

**问题**：`reader.read()` 网络错误时，`done` 块不执行，billing/metrics/logging 丢失。

**方案**：
- 在 `StreamProcessor` 中，用 `try/finally` 包裹读取循环：
  ```ts
  try {
    while (!done) {
      const { value, done: readerDone } = await reader.read();
      if (readerDone) break;
      // process chunk...
    }
  } catch (err) {
    // 通过回调通知 caller 已累积的部分内容
    onError(err, accumulatedContent);
  } finally {
    // 关闭 reader
    await reader.cancel().catch(() => {});
  }
  ```
- `onError` 回调由 `chat.ts` 提供，负责：记录 metrics（含部分 token）、billing（按实际已输出扣费）、conversation log（标记为 error 的 partial turn）。

### 3.3 Embedding 路由添加 Failover

**问题**：`createEmbedding()` 直接调用 provider，无 retry、无 failover。

**方案**：
- 提取 `callProviderWithRetry` 为 `src/providers/` 级别的共享 helper（当前在 `index.ts` 内部）。
- `createEmbedding()` 复用 `callProviderWithRetry` + failover 循环（同 `chatComplete` 的简化版）。
- 由于 embedding 无流式，可直接复用 `chatComplete` 的 failover 模式。
- 提取 `FailoverChain` 概念：给定 provider 列表，逐个尝试，成功即返，失败聚合错误。

**边界**：不引入新抽象层，`createEmbedding` 内部实现约 80 行 failover 逻辑。

### 3.4 统一错误处理（渐进替换）

**问题**：32 处手工 `c.json({ error: {...} })` 与 `GatewayError` 混用。

**方案**：
- 新增 `src/routes/utils.ts`：
  ```ts
  export function requireParam(c: Context, param: string, name: string): string | Response { ... }
  export function notFound(c: Context, resource: string, id: string): Response { ... }
  export function badRequest(c: Context, message: string, code?: string): Response { ... }
  ```
- Wave 2 修改 chat/embed/admin 路由时，顺手将手工 error JSON 替换为 `throw GatewayError.xxx()` 或 helper。
- 不一次性全改，降低 review 负担。

### 3.5 提取共享计费检查

**问题**：chat/embed/websocket 三处复制粘贴计费检查逻辑。

**方案**：
- 新增 `src/services/billing.ts` 导出 `checkRequestBilling(ctx: BillingCheckContext): BillingCheckResult`。
- `BillingCheckContext` 包含 keyHash、billingMode、monthlyBudget、subscriptionExpiry、model。
- 返回 `{ allowed: boolean; response?: Response }`，若 `!allowed` 直接返回 `response`（已格式化）。
- chat/embed/websocket 统一调用此函数。

---

## 4. Wave 3 — 架构稳固

### 4.1 Redis 连接共享

**问题**：每个 `createKVStore()` 新建一个 `ioredis` 实例，10+ store = 10+ 连接。

**方案**：
- `src/stores/factory.ts` 缓存全局 `Redis` client 实例：
  ```ts
  let globalRedisClient: Redis | null = null;
  function getSharedRedisClient(): Redis {
    if (!globalRedisClient) {
      globalRedisClient = new Redis({ ... });
    }
    return globalRedisClient;
  }
  ```
- `RedisKVStore` 构造函数接收 `client: Redis` + `prefix: string`。
- `createKVStore('prefix')` 内部调用 `getSharedRedisClient()` 传入共享 client。
- `IKVStore` 接口不变，所有调用方无需修改。
- `isConnected()` 检查共享 client 状态。

### 4.2 分阶段启动

**问题**：`index.ts` 顺序 await 15+ 初始化，无依赖图，任一失败阻塞全部。

**方案**：
- 定义 `StartupPhase`：
  ```ts
  type StartupPhase = {
    name: string;
    critical: boolean;
    inits: Array<() => Promise<void>>;
  };
  ```
  - Phase 1 (critical): config, storage, providers, auth
  - Phase 2 (critical): services that depend on Phase 1
  - Phase 3 (best-effort): metrics, alerts, conversation logs, cache warm
- `runStartup(phases)`：Phase 1/2 内用 `Promise.all`，任一失败则 abort；Phase 3 内用 `Promise.allSettled`，失败仅 warn 不阻塞。

### 4.3 ShutdownRegistry

**问题**：优雅关闭仅 flush 4 个 store，漏了 billing/request-log/conversation-log/metrics。

**方案**：
- 新增 `src/utils/shutdown.ts`：
  ```ts
  export const shutdownRegistry = {
    handlers: new Map<string, () => Promise<void>>(),
    register(name: string, handler: () => Promise<void>) { ... },
    async flushAll(): Promise<void> { ... }
  };
  ```
- 各 service 的 `initXxx()` 或 `getXxxStore()` 中自动 `register('xxx', flushXxxStore)`。
- `handleShutdown` 调用 `shutdownRegistry.flushAll()`。

### 4.4 Config 深合并统一

**问题**：`setConfig()` 只对 auth/providers 深合并，其余嵌套对象被完全覆盖。

**方案**：
- 已有 `deepMergeConfig` 在 `initConfig()` 中使用。
- `setConfig()` 也复用 `deepMergeConfig`，对所有嵌套对象统一处理。
- 注意：数组字段（如 `api_keys`）应替换而非合并，需在 `deepMergeConfig` 中通过选项控制。

---

## 5. Wave 4 — 质量清理

### 5.1 幽灵代码清理

- 移除 `src/middleware/error.ts` 中未使用的 `validateString`、`normalizeProviderError`。
- 移除 `src/middleware/auth.ts` 中未使用的 `generateTestApiKey`、`generateTestPlaintextKey`（或移到 `tests/utils/`）。
- 移除 `src/types/index.ts` 中未使用的 `ApiKey` type alias。
- 清理 `ai-gateway-admin/src/services/api.ts` 中未使用的 ~12 个 API 函数。
- 清理 `ai-gateway-admin/src/types/index.ts` 中未使用的 ~25 个 type export。
- 合并 `src/routes/embed.ts` 中重复的 `recordUsage` import。

### 5.2 硬编码提取

- 租户套餐限额（`planDefaults`）→ `conf/default.json` 中 `plan_defaults` 字段。
- 路由阈值（`5000` 字符）→ `IGatewayConfig.routing.long_text_threshold`。
- Plugin VM 超时（`5000`）→ `PLUGIN_TIMEOUT` env var。
- Provider fetch 超时（`30000`）→ `PROVIDER_DEFAULT_TIMEOUT` env var。
- WS 心跳/广播/超时间隔 → `WS_HEARTBEAT_INTERVAL` / `WS_METRICS_INTERVAL` / `WS_IDLE_TIMEOUT` env var。
- Cache TTLs → 统一到 config。
- Metrics 中重复的 `Math.round(x*1000)/1000` → `round3()` / `round4()` helper。
- `24 * 60 * 60 * 1000` → `DAY_MS` 常量。

### 5.3 前端优化

- 决定 Zustand store 命运：用于共享引用数据（config、providers、currentTenant），否则删除。
- 移除 Axios response interceptor 的 `.data` 解包，或改用 Zod 校验。
- 修复 WebSocket 重连丢失 `tenantId` / `options`。
- 拆分 `Tenants/index.tsx`（~800 行）为子组件。
- 提取 `useApiFetch()` hook 消除 13+ 页面的重复样板。
- 提取 `useProviderModelOptions()` hook。
- 添加 `eslint.config.js`。

### 5.4 重复代码统一

- 32 处手工 error JSON → Wave 2 已渐进替换，Wave 4 扫尾。
- `recordMetric` 参数块重复 → 提取 `buildMetricContext(c: Context)` helper。
- 前端 `Modal.confirm + message.success` 删除模式 → `confirmDelete()` utility。
- `countCompletionTokens` 被 embed 误用 → 改用 `countPromptTokens`。

---

## 6. 跨波次依赖

| 依赖 | 上游 | 下游 |
|------|------|------|
| `checkRequestBilling` 提取 | Wave 1 | Wave 2 (chat/embed/WS 统一调用) |
| `GatewayError.billing_error` | Wave 1 | Wave 2 (路由替换) |
| `StreamProcessor` 提取 | Wave 2 | Wave 3 (架构稳固无直接依赖) |
| `round3/round4` helper | Wave 4 | Wave 3 可提前用 |
| Redis 共享连接 | Wave 3 | Wave 1 的 Redis 原子操作依赖 |

**调整**：Redis 共享连接必须在 Wave 1 前完成（因为 Wave 1 的 Lua 脚本需要稳定连接）。将 Redis 共享连接移到 Wave 0（预准备），或并入 Wave 1。

**最终调整**：将 Redis 共享连接 + 认证优化合并为 Wave 1 第一部分（infra ready），财务原子化紧随其后。

---

## 7. 测试策略

### 每波必做
- `npm run lint` → `tsc --noEmit` → `npm test`
- 新增单测覆盖改动代码
- 若改动涉及 Redis，用 `jest --testNamePattern="redis"` 跑相关测试

### Wave 1
- 并发扣费测试（10 并发同一 key）。
- 认证延迟基准（100 keys）。
- WS 限流功能测试。
- Failover 4xx 边界测试。

### Wave 2
- StreamProcessor 单元测试（mock SSE stream，验证内容累积和错误回调）。
- PostProcessor 单元测试（验证 metrics/billing/conversation 被调用）。
- Embedding failover 测试。
- chat.ts 压缩后行数验证（< 450 行）。

### Wave 3
- Redis 连接数验证（启动后 `redis-cli CLIENT LIST | wc -l`）。
- 启动失败模拟（mock Redis 连接失败，验证非关键服务不阻塞）。
- Shutdown 全 store flush 验证。

### Wave 4
- 幽灵代码清理后 `tsc --noEmit` 无错误。
- 硬编码提取后配置加载测试。
- 前端 `pnpm lint` + `pnpm tsc --noEmit` 通过。

---

## 8. 回滚预案

- 每波在独立分支：`fix/wave1-security`, `fix/wave2-routing`, `fix/wave3-infra`, `fix/wave4-cleanup`。
- Wave 1-3 改动涉及核心业务，merge 前需全量测试通过（1073+ tests）。
- Wave 4 纯 cleanup，风险最低，可随时中断。
- 若某波发现问题，回滚该分支即可，不影响其他波。

---

## 9. 不引入的新依赖

| 可能 tempted | 拒绝理由 | 替代方案 |
|-------------|---------|---------|
| ioredis Lua 脚本库 | 已有 `ioredis.defineCommand` | 手动 `redis.defineCommand` |
| 分布式锁库 (redlock) | 单实例队列锁足够 | `Map<string, Promise>` |
| DI 框架 | 违背"不造轮子/不引入框架" | 函数参数传递 |
| Zod（前端）| 可选，非必须 | 先用类型断言 + 运行时检查 |
| React Query | 可选，非必须 | 先用 `useApiFetch` hook |

---

## 10. 成功标准

- [ ] Wave 1 后：并发扣费测试通过，认证 100 keys 延迟 < 20ms，WS 限流测试通过，4xx failover 测试通过。
- [ ] Wave 2 后：`chat.ts` < 450 行，流式错误 billing 不丢失，embedding 有 failover，无手工 error JSON 残留。
- [ ] Wave 3 后：Redis 连接数 <= 3（主 + pub/sub + sentinel 如有），启动分阶段验证，shutdown flush 全覆盖。
- [ ] Wave 4 后：无未使用 export，硬编码全部提取，前端 lint/tsc 绿，无重复 boilerplate。
