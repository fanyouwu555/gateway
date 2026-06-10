# Wallet 计费系统设计文档

**日期**: 2026-06-09  
**目标**: 为 AI Gateway 实现面向 IDE 插件编程用户的完整计费系统  
**方案**: 分层架构（方案 3）  
**货币**: 人民币（CNY），精度到微元（micro-CNY，1 = ¥0.000001）

---

## 1. 概述

### 1.1 背景

当前网关使用 `quota.ts` 的"配额限制"模式（日请求/日 token/月度费用硬上限），不支持：
- 预付费余额系统
- 按功能差异化定价（代码补全/聊天/代码解释）
- 用户自助充值
- 流式响应的精准结算

### 1.2 设计目标

1. **双层钱包**：Tenant（组织总池）+ API Key（个人独立账户）
2. **预扣结算**：请求前预扣预估费用，完成后按实际用量多退少补
3. **功能定价**：通过模型名后缀（`model:function_type`）区分功能定价
4. **自助支付**：支持 Admin 手动充值 + 用户自助支付（Stripe/支付宝/微信预留）
5. **精准结算**：非流式用 Provider usage，流式用 tiktoken + 兜底估算
6. **审计追踪**：每笔资金变动留痕，支持差异对账

### 1.3 非目标

- 自动对账（第一版只做差异记录和报表，人工确认后调整）
- 实时汇率转换（定价直接配 CNY，无汇率逻辑）
- 阶梯定价/套餐定价（后续迭代）

---

## 2. 数据模型

### 2.1 Wallet（钱包）

双层结构，每个 Tenant 和每个 API Key 各有一个钱包。

```typescript
interface IWallet {
  owner_type: 'tenant' | 'key';      // 归属类型
  owner_id: string;                   // tenant_id 或 key_hash
  balance_cny_micro: number;          // 可用余额（人民币微元）
  frozen_cny_micro: number;           // 冻结金额（预扣未结算）
  total_recharged_cny_micro: number;  // 累计充值
  total_consumed_cny_micro: number;   // 累计消费
  updated_at: number;
}
```

**存储 Key**：
- `wallet:tenant:{tenantId}`
- `wallet:key:{keyHash}`

**扣费逻辑**：
- 消费默认从 **API Key 钱包**扣款
- Key 余额不足时返回 **402 Payment Required**，不自动透传 Tenant 余额
- Tenant 向 Key 划拨通过显式 `transfer` 交易

**金额单位**：微元（micro-CNY），1 = ¥0.000001。全部用整数存储，禁止浮点运算。

### 2.2 Transaction（交易流水）

每笔资金变动必须留痕，不可删除。

```typescript
interface ITransaction {
  id: string;                         // tx_{timestamp}_{random}
  wallet_type: 'tenant' | 'key';
  wallet_id: string;
  type: 'recharge' | 'freeze' | 'unfreeze' | 'deduct' | 'refund' | 'adjust' | 'transfer';
  amount_cny_micro: number;           // 变动金额（正 = 增加，负 = 减少）
  balance_before_cny_micro: number;
  balance_after_cny_micro: number;
  related_request_id?: string;        // 关联网关请求 ID
  related_order_id?: string;          // 关联支付订单 ID
  metadata: {
    model?: string;
    function_type?: string;
    prompt_tokens?: number;
    completion_tokens?: number;
    actual_cost_cny_micro?: number;
    estimated_cost_cny_micro?: number;
    reason?: string;
    admin_key_hash?: string;          // 手动充值/调整的操作人
  };
  created_at: number;
}
```

**存储**：按天滚动分片
- 写入：`transactions:{wallet_id}:{YYYY-MM-DD}`（Redis lPush / Memory array.unshift）
- 查询最近 N 条：从最近几天的列表中合并取
- 保留策略：90 天后由后台任务归档或删除

### 2.3 PricingRule（定价规则）

支持"模型 + 功能"二维定价。

```typescript
interface IPricingRule {
  model: string;                      // 基础模型名，如 'gpt-4o'
  function_type: string | null;       // 'completion' | 'chat' | 'explain' | null（默认）
  input_price_cny_micro: number;      // 每 1M input tokens（人民币微元）
  output_price_cny_micro: number;     // 每 1M output tokens（人民币微元）
  request_price_cny_micro?: number;   // 每次请求固定费用（可选，防高频攻击）
}
```

**匹配优先级**：
1. `(model + function_type)` 精确匹配
2. `(model + null)` 模型默认
3. `('*' + null)` 全局默认（兜底）

**功能类型解析**：从请求 `model` 字段解析后缀。
- `gpt-4o:completion` → model=`gpt-4o`, function_type=`completion`
- `gpt-4o` → model=`gpt-4o`, function_type=`null`
- 解析后的 `model` 用于 Provider 路由调用，原始值用于计费和缓存

**存储**：`pricing:rule:{model}:{function_type || '_default_'}` → JSON

### 2.4 PaymentOrder（支付订单）

```typescript
interface IPaymentOrder {
  id: string;                         // order_{timestamp}_{random}
  user_type: 'tenant' | 'key';
  user_id: string;
  amount_cny_micro: number;           // 充值金额
  channel: 'manual' | 'stripe' | 'alipay' | 'wechat';
  status: 'pending' | 'paid' | 'failed' | 'refunded';
  metadata: Record<string, unknown>;  // 渠道特定数据（Stripe session ID 等）
  created_at: number;
  paid_at?: number;
}
```

**存储**：`payment:order:{orderId}` → JSON

**状态流转**：
```
pending → paid（回调验签成功）→ refunded（Admin 退款）
pending → failed（超时或支付失败）
```

### 2.5 FreezeRecord（预扣记录）

用于追踪未结算的预扣，防止资金悬空。

```typescript
interface IFreezeRecord {
  freeze_id: string;                  // freeze_{timestamp}_{random}
  wallet_type: 'tenant' | 'key';
  wallet_id: string;
  amount_cny_micro: number;           // 预扣金额
  request_id: string;
  created_at: number;
  settled_at?: number;
}
```

**存储**：`freeze:{freezeId}` → JSON

**过期清理**：定时任务扫描 `created_at > 5 分钟` 且未 settle 的记录，自动解冻。

---

## 3. 请求生命周期集成

### 3.1 插入点

当前 `chat.ts` 请求管道：
```
auth → virtualKey → rateLimit → checkQuota → guardrail → requestPlugin → resolveModel → resolveProvider → checkCache → providerCall → responsePlugin → log
```

Wallet 插入位置：
```
... → rateLimit → 【checkBalance】→ checkQuota → guardrail → requestPlugin → resolveModel → resolveProvider → checkCache → providerCall → 【settleBalance】→ responsePlugin → log
```

**为什么 `checkBalance` 在 `checkQuota` 之前？**  
余额不足直接 402，这是 IDE 用户最关心的信息。`checkQuota` 降级为统计和软告警。

### 3.2 预扣流程（非流式 & 流式请求前）

```typescript
// 1. 解析模型和功能类型
const { resolvedModel, functionType } = resolveModelWithFunction(req.model);

// 2. 计算预估费用
const promptTokens = await countPromptTokens(req.messages, resolvedModel);
const maxTokens = req.max_tokens || 4096;
const estimatedCost = pricingEngine.calculateCost(
  resolvedModel,
  functionType,
  promptTokens,
  maxTokens
);

// 3. 预扣余额
const freezeResult = await walletService.freeze(keyHash, estimatedCost, requestId);
if (!freezeResult.success) {
  return c.json({
    error: {
      message: 'Insufficient balance',
      type: 'payment_required',
      code: 'insufficient_balance'
    }
  }, 402);
}

// 4. 存入 context 供后续 settle 使用
c.set('wallet_freeze_id', freezeResult.freezeId);
c.set('wallet_estimated_cost', estimatedCost);
c.set('wallet_function_type', functionType);
c.set('wallet_resolved_model', resolvedModel);
```

### 3.3 结算流程（请求完成后）

```typescript
// 非流式响应
const actualPromptTokens = providerResponse.usage?.prompt_tokens || await countPromptTokens(req.messages, resolvedModel);
const actualCompletionTokens = providerResponse.usage?.completion_tokens || 0;
const actualCost = pricingEngine.calculateCost(resolvedModel, functionType, actualPromptTokens, actualCompletionTokens);

await walletService.settle(freezeId, estimatedCost, actualCost, requestId);
```

### 3.4 流式响应结算

**核心策略**：
- 流开始时预扣 `estimatedCost = promptTokens * inputPrice + maxTokens * outputPrice`
- 流进行中：累加内容，不操作钱包
- 流正常结束：
  - 如果 Provider 最后一个 chunk 返回 `usage`，直接使用
  - 否则用 `countCompletionTokens(accumulatedContent)` 估算
  - 计算 `actualCost`，执行 settle
- 流中断（客户端断开）：
  - 用已累加的内容计算 partial tokens
  - 计算 `partialCost`
  - 执行 settle：`actualCost = partialCost`

**流中断检测**（Hono SSE 流中）：
```typescript
try {
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    // ... 处理 chunk，累加内容 ...
  }
  // 正常结束，执行 settle
} catch (e) {
  // 客户端断开或异常
  const partialTokens = await countCompletionTokens(accumulatedContent, resolvedModel);
  const partialCost = pricingEngine.calculateCost(resolvedModel, functionType, promptTokens, partialTokens);
  await walletService.settle(freezeId, estimatedCost, partialCost, requestId);
  c.set('stream_aborted', true);
}
```

### 3.5 缓存命中结算

缓存命中时，不调用 Provider，但仍按正常定价计费（缓存也是网关资源）。

```typescript
const cacheCost = pricingEngine.calculateCost(resolvedModel, functionType, promptTokens, completionTokens);
await walletService.settle(freezeId, estimatedCost, cacheCost, requestId);
```

若希望缓存作为福利降价，后续可通过 `cache_input_price` / `cache_output_price` 扩展 PricingRule。

### 3.6 Embedding 请求结算

Embedding 是非流式，直接按 Provider 返回的 `usage.prompt_tokens` 精确结算。

---

## 4. 钱包服务（WalletService）

### 4.1 核心接口

```typescript
interface IWalletService {
  // 查询余额
  getBalance(ownerType: 'tenant' | 'key', ownerId: string): Promise<IWallet | null>;

  // 预扣（请求前）
  freeze(ownerId: string, amount: number, requestId: string): Promise<{ success: boolean; freezeId?: string; reason?: string }>;

  // 结算（请求完成后）
  settle(freezeId: string, estimatedCost: number, actualCost: number, requestId: string): Promise<void>;

  // 解冻（请求失败时）
  unfreeze(freezeId: string): Promise<void>;

  // 充值
  recharge(ownerType: 'tenant' | 'key', ownerId: string, amount: number, orderId?: string): Promise<void>;

  // 划拨（Tenant → Key）
  transfer(fromTenantId: string, toKeyHash: string, amount: number): Promise<{ success: boolean; reason?: string }>;

  // 调整（Admin 纠错）
  adjust(ownerType: 'tenant' | 'key', ownerId: string, amount: number, reason: string, adminKeyHash: string): Promise<void>;

  // 查询流水
  getTransactions(ownerType: 'tenant' | 'key', ownerId: string, limit?: number): Promise<ITransaction[]>;
}
```

### 4.2 原子性保证

**Redis 模式**：使用 Lua 脚本保证原子性。

```lua
-- freeze.lua
local walletKey = KEYS[1]
local freezeKey = KEYS[2]
local amount = tonumber(ARGV[1])
local requestId = ARGV[2]
local now = ARGV[3]

local balance = tonumber(redis.call('hget', walletKey, 'balance_cny_micro') or 0)
if balance < amount then
  return {0, 'insufficient_balance'}
end

redis.call('hincrby', walletKey, 'balance_cny_micro', -amount)
redis.call('hincrby', walletKey, 'frozen_cny_micro', amount)
redis.call('hset', walletKey, 'updated_at', now)
redis.call('set', freezeKey, cjson.encode({
  wallet_type = ARGV[4],
  wallet_id = ARGV[5],
  amount_cny_micro = amount,
  request_id = requestId,
  created_at = tonumber(now)
}))

return {1, freezeKey}
```

**Memory 模式**：使用 `async-mutex` 锁，按 `walletId` 粒度加锁。

```typescript
private locks = new Map<string, Mutex>();

private async withLock<T>(walletId: string, fn: () => Promise<T>): Promise<T> {
  let mutex = this.locks.get(walletId);
  if (!mutex) {
    mutex = new Mutex();
    this.locks.set(walletId, mutex);
  }
  return mutex.runExclusive(fn);
}
```

### 4.3 定时任务

**Freeze 过期清理**（每 5 分钟）：
```typescript
async function cleanupStaleFreezes(): Promise<void> {
  const freezeKeys = await store.keys('freeze:*');
  for (const key of freezeKeys) {
    const data = await store.get(key);
    if (data) {
      const record = JSON.parse(data) as IFreezeRecord;
      if (Date.now() - record.created_at > 5 * 60 * 1000 && !record.settled_at) {
        await walletService.unfreeze(record.freeze_id);
        await store.delete(key);
      }
    }
  }
}
```

**启动时批量解冻**：网关启动时扫描所有未 settle 的 freeze 记录，批量解冻（防止上次崩溃导致资金悬空）。

---

## 5. 定价引擎（PricingEngine）

### 5.1 核心接口

```typescript
interface IPricingEngine {
  // 计算费用
  calculateCost(model: string, functionType: string | null, promptTokens: number, completionTokens: number): number;

  // 获取规则
  getRule(model: string, functionType: string | null): IPricingRule;

  // 设置规则
  setRule(rule: IPricingRule): void;

  // 删除规则
  deleteRule(model: string, functionType: string | null): boolean;

  // 获取所有规则
  getAllRules(): IPricingRule[];
}
```

### 5.2 计算逻辑

```typescript
function calculateCost(model: string, functionType: string | null, promptTokens: number, completionTokens: number): number {
  const rule = getRule(model, functionType);
  const inputCost = (promptTokens * rule.input_price_cny_micro) / 1_000_000;
  const outputCost = (completionTokens * rule.output_price_cny_micro) / 1_000_000;
  const requestCost = rule.request_price_cny_micro || 0;
  return Math.ceil(inputCost + outputCost + requestCost); // 向上取整到微元
}
```

### 5.3 规则匹配

```typescript
function getRule(model: string, functionType: string | null): IPricingRule {
  // 1. 精确匹配
  const exact = rules.get(`${model}:${functionType || '_default_'}`);
  if (exact) return exact;

  // 2. 模型默认
  const modelDefault = rules.get(`${model}:_default_`);
  if (modelDefault) return modelDefault;

  // 3. 全局默认
  const globalDefault = rules.get(`*:_default_`);
  if (globalDefault) return globalDefault;

  // 4. 硬编码兜底
  return { model: '*', function_type: null, input_price_cny_micro: 30000000, output_price_cny_micro: 60000000 };
}
```

---

## 6. 支付网关抽象

### 6.1 接口

```typescript
interface IPaymentGateway {
  name: string;

  // 创建支付订单
  createOrder(order: IPaymentOrder): Promise<{
    orderId: string;
    payUrl?: string;
    qrCode?: string;
    rawResponse?: unknown;
  }>;

  // 验证回调
  verifyCallback(payload: unknown, signature?: string): Promise<{
    valid: boolean;
    orderId: string;
    amount_cny_micro: number;
  }>;

  // 查询订单状态
  queryOrder(orderId: string): Promise<{ status: 'pending' | 'paid' | 'failed' }>;
}
```

### 6.2 实现

**ManualRechargeGateway（手动充值）**：
- Admin 后台直接调用 `walletService.recharge`
- 创建 PaymentOrder（channel='manual', status='paid'），跳过支付流程

**StripeGateway（预留）**：
- `createOrder`: 创建 Stripe Checkout Session，返回支付 URL
- `verifyCallback`: 验证 Stripe Webhook 签名
- 需要 `STRIPE_SECRET_KEY` 和 `STRIPE_WEBHOOK_SECRET`

**AlipayGateway / WechatGateway（预留）**：
- 接口预留，后续实现

### 6.3 充值流程

```
用户/Admin 请求充值
    ↓
创建 PaymentOrder（status=pending）
    ↓
调用 PaymentGateway.createOrder → 返回支付链接
    ↓
用户完成支付 → 支付平台回调网关
    ↓
PaymentGateway.verifyCallback（验签 + 金额校验）
    ↓
更新订单 status=paid
    ↓
WalletService.recharge（入账）
    ↓
记录 Transaction（type='recharge'）
```

**幂等保护**：同一回调多次执行，通过 PaymentOrder `status` 判断，已 `paid` 的订单直接返回成功，不重复充值。

---

## 7. Admin API

### 7.1 用户侧 API（IDE 插件调用）

| 方法 | 路径 | 描述 | Auth |
|------|------|------|------|
| GET | `/v1/wallet` | 查询当前 Key 钱包余额 | API Key |
| GET | `/v1/wallet/transactions` | 查询当前 Key 交易流水 | API Key |
| POST | `/v1/wallet/payment/create` | 创建支付订单（自助充值） | API Key |
| GET | `/v1/wallet/payment/:orderId` | 查询支付订单状态 | API Key |

### 7.2 Admin API

| 方法 | 路径 | 描述 | Auth |
|------|------|------|------|
| GET | `/v1/admin/wallet` | 查询任意钱包（?owner_type=&owner_id=） | Admin |
| POST | `/v1/admin/wallet/recharge` | 手动充值 | Admin |
| POST | `/v1/admin/wallet/transfer` | Tenant → Key 划拨 | Admin |
| POST | `/v1/admin/wallet/adjust` | 余额调整（纠错） | Admin |
| GET | `/v1/admin/wallet/transactions` | 查询任意钱包流水 | Admin |
| GET | `/v1/admin/wallet/pricing` | 查询定价规则 | Admin |
| PUT | `/v1/admin/wallet/pricing` | 设置定价规则（body: model, function_type, ...） | Admin |
| DELETE | `/v1/admin/wallet/pricing` | 删除定价规则 | Admin |
| GET | `/v1/admin/wallet/reconciliation` | 差异报表（gateway_cost vs provider_usage） | Admin |

### 7.3 支付回调（Webhook）

| 方法 | 路径 | 描述 |
|------|------|------|
| POST | `/v1/wallet/payment/callback/stripe` | Stripe Webhook |
| POST | `/v1/wallet/payment/callback/alipay` | 支付宝回调（预留） |
| POST | `/v1/wallet/payment/callback/wechat` | 微信回调（预留） |

### 7.4 响应格式

**余额查询**（`GET /v1/wallet`）：
```json
{
  "owner_type": "key",
  "owner_id": "sk_xxx_hash",
  "balance": "12.34",
  "balance_cny_micro": 12340000,
  "frozen": "3.21",
  "frozen_cny_micro": 3210000,
  "currency": "CNY"
}
```

**余额不足错误**（402）：
```json
{
  "error": {
    "message": "Insufficient balance. Required: ¥0.52, Available: ¥0.12",
    "type": "payment_required",
    "code": "insufficient_balance"
  }
}
```

---

## 8. 风险处理

| 风险 | 防御措施 |
|------|----------|
| **并发超卖** | Redis Lua 脚本 / Memory Mutex 原子操作；预扣时检查 `balance >= estimatedCost` |
| **freeze 悬空** | 持久化 freeze 记录；定时任务 5 分钟清理未结算；启动时批量解冻 |
| **流中断资金丢失** | 连接断开时执行 partial settle；已累加内容按 tiktoken 计数结算 |
| **Provider 计费误差** | 记录每笔请求的 `gateway_cost` vs `provider_usage`；Admin API 差异报表供人工审核；定价预留 5-10% 缓冲 |
| **恶意高频零 token 请求** | `request_price_cny_micro` 固定请求费；QPS 限流保留 |
| **充值回调伪造** | 支付网关验签；订单金额校验；幂等处理（已 paid 订单不重复充值） |
| **精度丢失** | 金额全部用整数微元，禁止浮点运算；计算结果向上取整 |
| **API Key 被盗刷** | Key 策略保留 `daily_budget_cny_micro` / `monthly_budget_cny_micro` 作为安全阀；超限拒绝即使余额充足 |
| **多实例数据不一致** | Memory 模式仅用于单实例开发；生产环境必须使用 Redis |

---

## 9. 与现有模块的关系

### 9.1 quota.ts

**策略**：共存，quota 硬限制转为可选。

- `checkQuota`：保留调用，但硬限制可通过 `WALLET_MODE=true` 关闭（仅保留统计和告警）
- `recordUsage`：继续调用，用量统计不受影响
- `getQuotaStatus`：继续提供数据给 Admin Dashboard

**修改点**：`src/routes/chat.ts` 中 `checkQuota` 后新增 `checkBalance` 调用。

### 9.2 pricing.ts

**策略**：扩展而非替换。

- 现有 `pricing.ts` 的模型级定价保留作为默认规则
- 新增 `pricing-engine.ts`，支持 `function_type` 维度
- `calculateCost` 增加 `functionType` 参数（可选，默认 null）
- 现有代码调用方式不变（不传 functionType 时走模型默认定价）

### 9.3 token-counter.ts

**策略**：无修改，直接使用。

- `countPromptTokens` 用于预扣前估算
- `countCompletionTokens` 用于流式响应兜底结算

### 9.4 tenant.ts

**策略**：扩展 Key 策略。

- `IApiKeyMeta` 增加 `daily_budget_cny_micro` 和 `monthly_budget_cny_micro`
- 创建 Key 时可设置消费限额

### 9.5 stores/factory.ts

**策略**：不修改。WalletService 内部根据存储类型选择原子性实现。

---

## 10. 实现阶段划分

### Phase 1：Wallet 核心（可独立上线）

1. `src/services/wallet.ts` — WalletService 实现
2. `src/services/pricing-engine.ts` — PricingEngine 实现
3. `src/services/payment.ts` — PaymentService + ManualRechargeGateway
4. `src/routes/admin/wallet.ts` — Admin API
5. `src/routes/wallet.ts` — 用户侧 API（余额查询、流水）
6. `src/routes/chat.ts` 修改 — 插入 checkBalance 和 settleBalance
7. `src/types/index.ts` 扩展 — IWallet, ITransaction, IPricingRule 等类型
8. `src/validation/index.ts` 扩展 — Wallet 相关 Zod schema
9. 测试：WalletService 单元测试、PricingEngine 测试、集成测试

**验收标准**：
- Admin 可手动充值
- 用户可查询余额和流水
- 请求前预扣、完成后结算
- 余额不足返回 402
- 所有金额用整数微元

### Phase 2：自助支付

1. `src/services/payment/stripe.ts` — StripeGateway 实现
2. `src/routes/wallet/payment.ts` — 用户充值 API
3. Webhook 回调处理
4. 前端 Admin Dashboard 充值页面

**验收标准**：
- 用户可自助创建 Stripe 支付订单
- 支付完成后余额自动到账
- 回调验签 + 幂等保护

### Phase 3：功能定价 & 对账

1. `src/services/chat-pipeline.ts` 修改 — 解析 `model:function_type` 后缀
2. Admin Dashboard 定价规则管理页面
3. `src/services/reconciliation.ts` — 差异记录和报表
4. 定时任务：freeze 清理、旧流水归档

**验收标准**：
- `gpt-4o:completion` 和 `gpt-4o:chat` 可设置不同价格
- Admin 可查看 gateway_cost vs provider_usage 差异报表

---

## 11. 附录

### 11.1 模型后缀解析示例

| 请求 model | resolvedModel | functionType | 实际调用 Provider |
|-----------|---------------|--------------|------------------|
| `gpt-4o:completion` | `gpt-4o` | `completion` | gpt-4o |
| `gpt-4o:chat` | `gpt-4o` | `chat` | gpt-4o |
| `gpt-4o` | `gpt-4o` | `null` | gpt-4o |
| `deepseek-chat:explain` | `deepseek-chat` | `explain` | deepseek-chat |

### 11.2 金额计算示例

**场景**：代码补全请求，gpt-4o，prompt 500 tokens，completion 200 tokens

定价：input ¥21.6/M，output ¥86.4/M，request ¥0.0001

```
input_cost = 500 * 21_600_000 / 1_000_000 = 10_800_000 微元 = ¥10.8
output_cost = 200 * 86_400_000 / 1_000_000 = 17_280_000 微元 = ¥17.28
request_cost = 100 微元 = ¥0.0001
total = 10_800_000 + 17_280_000 + 100 = 28_080_100 微元 = ¥28.0801
```

### 11.3 配置项

```env
# Wallet 配置
WALLET_MODE=true                    # 启用钱包计费（替代 quota 硬限制）
WALLET_STORAGE=redis                # 钱包存储（memory/redis）
FREEZE_TIMEOUT_MS=300000            # freeze 超时时间（5分钟）
TRANSACTION_RETENTION_DAYS=90       # 流水保留天数

# 支付网关配置（Phase 2）
STRIPE_SECRET_KEY=sk_xxx
STRIPE_WEBHOOK_SECRET=whsec_xxx
```
