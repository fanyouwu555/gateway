# 租户模板 + 默认 API Key 设计文档

## 背景与目标

目前管理员创建租户后，需要再手动进入租户详情创建 API Key，并单独配置限额、模型、计费模式等。本文档设计「租户模板」能力，使创建租户时可基于模板一键生成预配置租户，并可选择同时创建默认 API Key。

目标：
- 通过模板减少重复配置。
- 创建租户时可选择自动生成默认 API Key，明文 Key 仅在创建时返回一次。
- 不造轮子：复用现有 KV Store、TenantService、API Key Service、WalletService、Zod 校验、Audit 等模块。

## 设计决策

| 决策点 | 选择 | 原因 |
|--------|------|------|
| 模板范围 | 租户配置 + 默认 Key 策略 | 覆盖创建租户时最常见的配置项，减少后续手动操作。 |
| 模板生命周期 | 动态 CRUD | 管理员可在运行时维护模板，无需重启服务。 |
| 默认 Key | 可选开关控制 | 由调用方决定是否需要默认 Key，模板可预设推荐策略。 |
| 实现架构 | 独立 Template Service + 新 Admin 路由 | 与 PromptService 等现有模块对齐，职责清晰。 |
| 存储 | 复用 `createKVStore('tenant-template')` | 默认内存，可选 Redis，与 Tenant/Wallet 等保持一致。 |
| 字段合并 | 模板为基线，请求体字段可覆盖 | 允许模板兜底、单次调用微调，兼顾一致性与灵活性。 |

## 数据模型

### `ITenantTemplate`（新增到 `src/types/index.ts`）

```typescript
export interface ITenantTemplate {
  template_id: string;
  name: string;
  description?: string;
  is_default?: boolean;        // 创建租户弹窗中默认选中的模板

  /** 租户级默认配置 */
  tenant: {
    plan: 'free' | 'pro' | 'enterprise';
    status: 'active' | 'suspended' | 'trial';
    settings?: TenantSettings; // 复用现有类型
    limits?: TenantLimits;     // 复用现有类型
  };

  /** 可选的默认 API Key 策略 */
  default_key?: {
    name: string;
    billing_mode?: 'competition' | 'subscription' | 'prepaid';
    balance?: number;          // 微元，仅 prepaid 模式有效
    allowed_models?: string[];
    default_model?: string;
    rate_limit_qps?: number;
    rate_limit_burst?: number;
    monthly_budget?: number;
    max_tokens_per_request?: number;
    subscription_expires_at?: number;
    expires_at?: number;
    metadata?: Record<string, string>;
  };

  created_at: number;
  updated_at: number;
}
```

### 与现有类型的关系

- `TenantSettings`、`TenantLimits` 直接复用 `src/types/index.ts` 中现有定义。
- `default_key` 字段集与 `IApiKeyMeta` 中可配置策略字段对齐，方便直接透传给 `createTenantApiKey()`。

## 后端设计

### 新增服务：`src/services/tenant-template.ts`

复用现有 `TenantStore` 的存储模式：

- 内存 `Map<string, ITenantTemplate>` 作为主存储。
- 可选 Redis 持久化：`tenant-template:data:${template_id}`。
- 提供 `loadFromStorage()` / `flushToStorage()`，在 `src/index.ts` 启动流程中调用。

核心函数：

```typescript
export async function createTenantTemplate(template: Omit<ITenantTemplate, 'template_id' | 'created_at' | 'updated_at'>): Promise<ITenantTemplate>
export function getTenantTemplate(templateId: string): ITenantTemplate | null
export async function updateTenantTemplate(templateId: string, updates: Partial<Omit<ITenantTemplate, 'template_id' | 'created_at'>>): Promise<ITenantTemplate | null>
export async function deleteTenantTemplate(templateId: string): Promise<boolean>
export function listTenantTemplates(): ITenantTemplate[]
export function getDefaultTenantTemplate(): ITenantTemplate | null
```

### 新增路由：`src/routes/admin/tenant-template.ts`

挂载到 `adminRouter`，所有接口受 `requireAdmin` 保护：

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/v1/tenant-templates` | 列出所有模板 |
| GET | `/v1/tenant-templates/:id` | 获取单个模板 |
| POST | `/v1/tenant-templates` | 创建模板 |
| PUT | `/v1/tenant-templates/:id` | 更新模板 |
| DELETE | `/v1/tenant-templates/:id` | 删除模板 |

错误格式复用统一格式：`{ error: { message, type, code } }`。

### 租户创建接口改造：`src/routes/admin/tenant.ts`

`POST /v1/tenants` 请求体扩展两个可选字段：

```typescript
{
  name: string;                    // 租户名称，必填
  template_id?: string;            // 选中模板
  create_default_key?: boolean;    // 默认 false

  // 以下字段若提供，可覆盖模板中的对应值
  plan?: 'free' | 'pro' | 'enterprise';
  status?: 'active' | 'suspended' | 'trial';
  settings?: TenantSettings;
  limits?: TenantLimits;
}
```

注意：当 `template_id` 存在时，`plan/status/settings/limits` 可作为覆盖值；`name` 始终由调用方指定。当模板不存在时返回 `404 invalid_request`。

处理流程：

1. 校验请求体（使用扩展后的 Zod schema）。
2. 若提供 `template_id`，加载模板并校验存在性。
3. 构建最终租户配置：
   - 租户名称使用请求体中的 `name`。
   - 租户其他配置按字段合并：
     - `plan` / `status`：请求体值优先，否则取模板值。
     - `settings`：字段级合并 `{ ...template?.tenant.settings, ...requestOverrides.settings }`，请求体只传部分字段时不会丢失模板的其他设置。
     - `limits`：字段级合并 `{ ...template?.tenant.limits, ...requestOverrides.limits }`。
   - 若未使用模板且未传 `limits`，`createTenant()` 内部仍会根据 `plan` 应用默认限额。
4. 调用现有 `createTenant()` 创建租户。
5. 若 `create_default_key === true`：
   - 若模板存在且 `template.default_key` 存在，以其为策略；
   - 否则使用最简默认策略：`{ name: 'default', billing_mode: 'competition' }`。
   - 调用现有 `createTenantApiKey()` 创建 Key。
   - 若 `billing_mode === 'prepaid'` 且提供了 `balance`，调用 `setBalance()` 写入钱包。
6. 返回（注意：这是 `POST /v1/tenants` 的破坏性变更，Admin 前端需同步更新类型）：

```typescript
{
  tenant: TenantConfig;
  default_key?: IApiKeyMeta;        // 明文 key 仅此时返回
  default_key_error?: {             // 仅当 create_default_key=true 但 Key 创建失败时返回
    message: string;
    code: string;
  };
}
```

默认 Key 创建失败（如 `max_api_keys` 已达上限）不会导致租户创建回滚，而是通过 `default_key_error` 暴露错误，调用方可手动重试或调整限额。

### 校验模式扩展（`src/validation/index.ts`）

为复用，先从现有 `tenantConfigSchema` 中提取命名 schema：

```typescript
export const tenantSettingsSchema = z.object({
  default_provider: z.string().optional(),
  allowed_providers: z.array(z.string()).optional(),
  allowed_models: z.array(z.string()).optional(),
  webhook_url: z.string().url().optional(),
  notification_email: z.string().email().optional(),
});

export const tenantLimitsSchema = z.object({
  daily_requests: z.number().int().positive(),
  daily_tokens: z.number().int().positive(),
  max_api_keys: z.number().int().positive(),
  concurrent_requests: z.number().int().positive(),
});
```

然后更新 `tenantConfigSchema` 使用上述命名 schema，并新增模板相关 schema：

```typescript
export const tenantConfigSchema = z.object({
  name: z.string().min(1),
  status: z.enum(['active', 'suspended', 'trial']),
  plan: z.enum(['free', 'pro', 'enterprise']),
  settings: tenantSettingsSchema.optional(),
  limits: tenantLimitsSchema.optional(),
});

export const tenantTemplateSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  is_default: z.boolean().optional(),
  tenant: z.object({
    plan: z.enum(['free', 'pro', 'enterprise']),
    status: z.enum(['active', 'suspended', 'trial']),
    settings: tenantSettingsSchema.optional(),
    limits: tenantLimitsSchema.optional(),
  }),
  default_key: createApiKeySchema.extend({
    name: z.string().min(1),         // 模板中 name 必填
  }).optional(),
});

export const tenantTemplateUpdateSchema = tenantTemplateSchema.partial().extend({
  name: z.string().min(1).optional(),
});

export const createTenantWithTemplateSchema = tenantConfigSchema.extend({
  template_id: z.string().optional(),
  create_default_key: z.boolean().optional(),
});
```

说明：

- `tenantConfigSchema` 中的 `name` 保持必填。租户名称由调用方指定，不使用模板的 `name`（模板 `name` 仅用于标识模板本身）。
- `template_id` 为可选；提供时，模板中的 `tenant` 字段作为基础，请求体中的 `plan/status/settings/limits` 可覆盖对应值。
- 覆盖规则为浅合并：`settings` 和 `limits` 整体被请求体中的对象替换；若请求体只传部分字段，应完整填充模板值后再发送。

### 启动加载

在 `src/index.ts` 的初始化流程中，与 `initTenantStore()` 并列调用 `initTenantTemplateStore()`，确保 Redis 模式下模板数据可恢复。

## 前端设计

### 新增 API 服务（`ai-gateway-admin/src/services/api.ts`）

```typescript
export async function getTenantTemplates(): Promise<{ templates: TenantTemplate[] }>
export async function createTenantTemplate(data: TenantTemplateFormData): Promise<TenantTemplate>
export async function updateTenantTemplate(id: string, data: TenantTemplateFormData): Promise<TenantTemplate>
export async function deleteTenantTemplate(id: string): Promise<void>
export async function createTenant(data: CreateTenantData): Promise<{
  tenant: Tenant
  default_key?: ApiKey
  default_key_error?: { message: string; code: string }
}>
```

### 新增类型（`ai-gateway-admin/src/types/index.ts`）

```typescript
export interface TenantTemplate {
  template_id: string
  name: string
  description?: string
  is_default?: boolean
  tenant: {
    plan: 'free' | 'pro' | 'enterprise'
    status: 'active' | 'suspended' | 'trial'
    settings?: TenantSettings
    limits?: TenantLimits
  }
  default_key?: DefaultKeyPolicy
  created_at: number
  updated_at: number
}

export interface DefaultKeyPolicy {
  name: string
  billing_mode?: 'competition' | 'subscription' | 'prepaid'
  balance?: number
  allowed_models?: string[]
  default_model?: string
  rate_limit_qps?: number
  rate_limit_burst?: number
  monthly_budget?: number
  max_tokens_per_request?: number
  subscription_expires_at?: number
  expires_at?: number
  metadata?: Record<string, string>
}

export interface CreateTenantData {
  name: string
  plan?: 'free' | 'pro' | 'enterprise'
  status?: 'active' | 'suspended' | 'trial'
  settings?: TenantSettings
  limits?: Partial<TenantLimits>
  template_id?: string
  create_default_key?: boolean
}
```

### 新增页面：`ai-gateway-admin/src/pages/TenantTemplates/index.tsx`

- 表格展示所有模板：名称、描述、计划、默认 Key 计费模式、是否默认模板、操作。
- 创建/编辑弹窗：
  - 基本信息：名称、描述、是否设为默认模板。
  - 租户配置：计划、状态、settings（provider/model/webhook）、limits。
  - 默认 Key 策略（可选）：名称、计费模式、余额、模型限制、QPS/突发、月度预算等。
- 删除需 `Modal.confirm`。

### 租户页面改造：`ai-gateway-admin/src/pages/Tenants/index.tsx`

创建租户弹窗：

1. 顶部增加「模板」选择器（Select），数据来源 `getTenantTemplates()`，默认选中 `is_default === true` 的模板。
2. 选择模板后，自动填充下方表单（plan、status、settings、limits、default_key 信息只读展示）。
3. 增加「同时创建默认 API Key」复选框：
   - 默认未勾选。
   - 若模板存在 `default_key`，勾选后展示策略摘要（名称、计费模式、余额）。
4. 提交后若后端返回 `default_key`，复用现有「API Key 创建成功」复制弹窗展示明文 Key。

### 菜单/路由

在 Admin Layout 菜单中新增「租户模板」入口，路径 `/tenant-templates`，路由注册到 `ai-gateway-admin/src/App.tsx`。

## 安全与审计

- 所有模板管理接口均在 `adminRouter.use('*', requireAdmin)` 保护下。
- 创建模板、更新模板、删除模板、基于模板创建租户、创建默认 Key 均调用 `auditAdmin()` 记录审计日志。
- 明文 API Key 仅创建时返回一次，与现有行为一致；后端只存储哈希值。
- 校验 `balance` 为非负数，`monthly_budget` 等限额为正数，防止异常输入。

## 测试计划

### 后端测试

1. `tests/services/tenant-template.test.ts`
   - 模板 CRUD。
   - 默认模板查询。
   - Redis 加载/持久化（可选）。

2. `tests/routes/tenant-template.test.ts`
   - 管理接口权限（非 admin key 被拒绝）。
   - 创建、更新、删除模板接口。

3. 扩展 `tests/routes/tenant.test.ts` / `tests/services/tenant.test.ts`
   - 基于模板创建租户。
   - 模板字段被请求体字段覆盖。
   - `create_default_key` 为 true 时生成默认 Key。
   - 预付模式下初始余额正确写入钱包。
   - 未勾选时不生成 Key。

### 前端测试

1. `ai-gateway-admin/src/pages/TenantTemplates/index.test.tsx`
   - 列表渲染、创建模板表单提交、删除确认。

2. 扩展 `ai-gateway-admin/src/pages/Tenants/index.test.tsx`
   - 选择模板后表单自动填充。
   - 创建租户时携带 `template_id` 和 `create_default_key`。

## 复用清单

| 能力 | 复用模块 |
|------|----------|
| 存储抽象 | `createKVStore('tenant-template')` |
| 租户创建 | `createTenant()` in `src/services/tenant.ts` |
| API Key 创建 | `createTenantApiKey()` in `src/services/tenant.ts` |
| 钱包余额 | `setBalance()` in `src/services/wallet.ts` |
| 请求校验 | Zod in `src/validation/index.ts` |
| 审计日志 | `auditAdmin()` in `src/utils/audit.ts` |
| 统一错误 | `GatewayError` / `{ error: {...} }` 格式 |
| 前端组件 | Ant Design Form/Modal/Table/Select，现有 Tenants 页面模式 |

## 风险与回退

- **模板删除后不影响已创建租户**：模板只是创建时的快照，删除模板不会级联删除租户。
- **is_default 冲突**：多个模板同时设置 `is_default` 时，前端默认选择列表中第一个；后端不强制唯一性，避免复杂约束。
- **字段合并歧义**：`settings` 和 `limits` 采用浅合并。若需要完全替换某一项，可在 UI 中提供「覆盖」提示。

## 后续可扩展

- 模板导入/导出（JSON）。
- 模板版本控制或克隆。
- 创建租户时根据模板自动初始化 Quota 计数器（当前 QuotaService 为日限额，已由 `TenantLimits` 驱动）。
