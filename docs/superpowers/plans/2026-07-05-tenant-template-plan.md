# 租户模板 + 默认 API Key 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现运行时租户模板 CRUD，并在创建租户时支持基于模板一键生成预配置租户与默认 API Key。

**Architecture:** 新增独立的 `TenantTemplateStore` 与 `/v1/tenant-templates` Admin 路由；`POST /v1/tenants` 扩展 `template_id` 与 `create_default_key` 字段，复用现有 `createTenant()` 与 `createTenantApiKey()`；前端新增「租户模板」管理页面，并在「创建租户」弹窗中加入模板选择与默认 Key 开关。

**Tech Stack:** TypeScript, Hono, Zod, Jest, React 18, Ant Design 5, Vite, Vitest

## Global Constraints

- 所有 Admin 路由必须位于 `src/routes/admin/*` 并统一挂载到 `adminRouter`（已应用 `requireAdmin`）。
- 后端存储复用 `createKVStore('tenant-template')`，默认内存，可选 Redis。
- 明文 API Key 仅创建时返回一次；后端只存储哈希值。
- 余额单位统一为「微元」。
- 不引入额外依赖；不重构与本次需求无关的代码。
- 单测使用 Jest（后端）与 Vitest（前端），运行前需通过 `lint` 与 `tsc --noEmit`。

---

## File Structure

| 文件 | 职责 |
|------|------|
| `src/validation/index.ts` | 抽取 `tenantSettingsSchema` / `tenantLimitsSchema`；新增模板相关 Zod schema。 |
| `src/types/index.ts` | 新增 `ITenantTemplate` 类型。 |
| `src/services/tenant-template.ts` | 模板存储、CRUD、默认模板查询、Redis 加载/持久化。 |
| `src/index.ts` | 启动时调用 `initTenantTemplateStore()`。 |
| `src/routes/admin/tenant.ts` | 改造 `POST /v1/tenants`，支持模板与默认 Key。 |
| `src/routes/admin/tenant-template.ts` | 新增 `/v1/tenant-templates` CRUD 路由。 |
| `src/routes/admin/index.ts` | 挂载模板路由。 |
| `ai-gateway-admin/src/types/index.ts` | 新增 `TenantTemplate`、`DefaultKeyPolicy`、`CreateTenantData` 等类型。 |
| `ai-gateway-admin/src/services/api.ts` | 新增模板 API 与更新 `createTenant` 签名。 |
| `ai-gateway-admin/src/pages/TenantTemplates/index.tsx` | 模板列表 + 创建/编辑/删除弹窗。 |
| `ai-gateway-admin/src/App.tsx` | 注册模板页面路由。 |
| Admin Layout 菜单文件 | 新增「租户模板」入口（路径需确认当前 layout 文件位置）。 |
| `ai-gateway-admin/src/pages/Tenants/index.tsx` | 创建租户弹窗加入模板选择器与默认 Key 复选框。 |
| `tests/services/tenant-template.test.ts` | 模板服务单元测试。 |
| `tests/routes/tenant-template.test.ts` | 模板路由测试（权限 + CRUD）。 |
| `tests/routes/tenant.test.ts` | 扩展基于模板创建租户、默认 Key 测试。 |
| `tests/services/tenant.test.ts` | 扩展默认 Key 创建失败场景。 |
| `ai-gateway-admin/src/pages/TenantTemplates/index.test.tsx` | 前端模板页面测试。 |
| `ai-gateway-admin/src/pages/Tenants/index.test.tsx` | 扩展创建租户模板选择测试。 |

---

## Task 1: 抽取并复用租户 Settings / Limits 的 Zod Schema

**Files:**
- Modify: `src/validation/index.ts:87-106`

**Interfaces:**
- Produces: `tenantSettingsSchema`, `tenantLimitsSchema`（供 Task 2、Task 3 复用）

- [ ] **Step 1: 抽取命名 schema 并更新 tenantConfigSchema**

将 `tenantConfigSchema` 中的 `settings` 与 `limits` 内联定义提取为命名 schema，并复用：

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

export const tenantConfigSchema = z.object({
  name: z.string().min(1),
  status: z.enum(['active', 'suspended', 'trial']),
  plan: z.enum(['free', 'pro', 'enterprise']),
  settings: tenantSettingsSchema.optional(),
  limits: tenantLimitsSchema.optional(),
});
```

- [ ] **Step 2: 运行 lint 与 tsc 验证无回归**

```bash
npm run lint
npx tsc --noEmit
```

Expected: 无新增错误。

- [ ] **Step 3: Commit**

```bash
git add src/validation/index.ts
git commit -m "refactor(validation): extract tenant settings/limits schemas for reuse"
```

---

## Task 2: 新增 ITenantTemplate 类型

**Files:**
- Modify: `src/types/index.ts`

**Interfaces:**
- Consumes: `TenantSettings`, `TenantLimits`（同文件）
- Produces: `ITenantTemplate`

- [ ] **Step 1: 在 `src/types/index.ts` 中添加 `ITenantTemplate`**

找到 `TenantLimits` 定义之后追加：

```typescript
export interface ITenantTemplate {
  template_id: string;
  name: string;
  description?: string;
  is_default?: boolean;

  tenant: {
    plan: 'free' | 'pro' | 'enterprise';
    status: 'active' | 'suspended' | 'trial';
    settings?: TenantSettings;
    limits?: TenantLimits;
  };

  default_key?: {
    name: string;
    billing_mode?: 'competition' | 'subscription' | 'prepaid';
    balance?: number;
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

- [ ] **Step 2: 运行 tsc 检查**

```bash
npx tsc --noEmit
```

Expected: 无新增错误。

- [ ] **Step 3: Commit**

```bash
git add src/types/index.ts
git commit -m "types: add ITenantTemplate interface"
```

---

## Task 3: 实现 TenantTemplateStore 服务

**Files:**
- Create: `src/services/tenant-template.ts`

**Interfaces:**
- Consumes: `ITenantTemplate`, `createKVStore`, `generateRequestId`, `writeLog`, `shouldUseRedis`
- Produces: `createTenantTemplate`, `getTenantTemplate`, `updateTenantTemplate`, `deleteTenantTemplate`, `listTenantTemplates`, `getDefaultTenantTemplate`, `initTenantTemplateStore`, `resetTenantTemplateStore`

- [ ] **Step 1: 创建服务文件**

完整实现 `src/services/tenant-template.ts`：

```typescript
import type { ITenantTemplate } from '../types';
import { generateRequestId, shouldUseRedis } from '../utils';
import { writeLog } from '../utils/logger';
import { createKVStore } from '../stores/factory';

class TenantTemplateStore {
  private templates = new Map<string, ITenantTemplate>();
  private useRedis = false;
  private store: ReturnType<typeof createKVStore> | null = null;

  constructor() {
    this.useRedis = shouldUseRedis('TENANT_STORAGE'); // 与 tenant 共用开关，或新增 TENANT_TEMPLATE_STORAGE
  }

  private async getStore(): Promise<ReturnType<typeof createKVStore>> {
    if (!this.store) {
      this.store = createKVStore('tenant-template');
    }
    if (!this.store.isConnected()) {
      await this.store.connect();
    }
    return this.store;
  }

  private async persist(templateId: string): Promise<void> {
    if (!this.useRedis) return;
    try {
      const store = await this.getStore();
      const template = this.templates.get(templateId);
      if (template) {
        await store.set(`tenant-template:data:${templateId}`, JSON.stringify(template));
      }
    } catch {
      // 持久化失败不影响主流程
    }
  }

  private async removeFromStorage(templateId: string): Promise<void> {
    if (!this.useRedis) return;
    try {
      const store = await this.getStore();
      await store.delete(`tenant-template:data:${templateId}`);
    } catch {
      // 删除失败不影响主流程
    }
  }

  async loadFromStorage(): Promise<void> {
    if (!this.useRedis) return;
    try {
      const store = await this.getStore();
      const keys = await store.keys('tenant-template:data:*');
      for (const key of keys) {
        const templateId = key.replace('tenant-template:data:', '');
        const data = await store.get(key);
        if (data) {
          try {
            const template = JSON.parse(data) as ITenantTemplate;
            this.templates.set(templateId, template);
          } catch {
            // 忽略解析失败的条目
          }
        }
      }
      writeLog('info', 'Tenant templates loaded from Redis', { count: keys.length });
    } catch (err) {
      writeLog('warn', 'Failed to load tenant templates from Redis', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async flushToStorage(): Promise<void> {
    if (!this.useRedis) return;
    try {
      const store = await this.getStore();
      for (const [templateId, template] of this.templates.entries()) {
        await store.set(`tenant-template:data:${templateId}`, JSON.stringify(template));
      }
    } catch (err) {
      writeLog('warn', 'Failed to flush tenant templates to Redis', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  create(template: Omit<ITenantTemplate, 'template_id' | 'created_at' | 'updated_at'>): ITenantTemplate {
    const templateId = `tpl_${generateRequestId()}`;
    const now = Date.now();
    const newTemplate: ITenantTemplate = {
      ...template,
      template_id: templateId,
      created_at: now,
      updated_at: now,
    };
    this.templates.set(templateId, newTemplate);
    this.persist(templateId);
    return newTemplate;
  }

  get(templateId: string): ITenantTemplate | null {
    return this.templates.get(templateId) || null;
  }

  async update(templateId: string, updates: Partial<Omit<ITenantTemplate, 'template_id' | 'created_at'>>): Promise<ITenantTemplate | null> {
    const template = this.templates.get(templateId);
    if (!template) return null;

    const updated: ITenantTemplate = {
      ...template,
      ...updates,
      updated_at: Date.now(),
    };
    this.templates.set(templateId, updated);
    await this.persist(templateId);
    return updated;
  }

  async delete(templateId: string): Promise<boolean> {
    const deleted = this.templates.delete(templateId);
    if (deleted) {
      await this.removeFromStorage(templateId);
    }
    return deleted;
  }

  list(): ITenantTemplate[] {
    return Array.from(this.templates.values());
  }

  getDefault(): ITenantTemplate | null {
    for (const template of this.templates.values()) {
      if (template.is_default) {
        return template;
      }
    }
    return null;
  }
}

let store = new TenantTemplateStore();

export function resetTenantTemplateStore(): void {
  store = new TenantTemplateStore();
}

export async function initTenantTemplateStore(): Promise<void> {
  await store.loadFromStorage();
}

export async function flushTenantTemplateStore(): Promise<void> {
  await store.flushToStorage();
}

export function createTenantTemplate(template: Omit<ITenantTemplate, 'template_id' | 'created_at' | 'updated_at'>): ITenantTemplate {
  return store.create(template);
}

export function getTenantTemplate(templateId: string): ITenantTemplate | null {
  return store.get(templateId);
}

export async function updateTenantTemplate(
  templateId: string,
  updates: Partial<Omit<ITenantTemplate, 'template_id' | 'created_at'>>
): Promise<ITenantTemplate | null> {
  return store.update(templateId, updates);
}

export async function deleteTenantTemplate(templateId: string): Promise<boolean> {
  return store.delete(templateId);
}

export function listTenantTemplates(): ITenantTemplate[] {
  return store.list();
}

export function getDefaultTenantTemplate(): ITenantTemplate | null {
  return store.getDefault();
}
```

注意：`shouldUseRedis('TENANT_STORAGE')` 复用租户存储开关；如需独立控制，可改为 `TENANT_TEMPLATE_STORAGE` 并在 `src/config/index.ts` 增加解析。

- [ ] **Step 2: 添加服务单元测试（最小通过集）**

创建 `tests/services/tenant-template.test.ts`：

```typescript
import { describe, it, expect, beforeEach } from '@jest/globals';
import {
  createTenantTemplate,
  getTenantTemplate,
  updateTenantTemplate,
  deleteTenantTemplate,
  listTenantTemplates,
  getDefaultTenantTemplate,
  resetTenantTemplateStore,
} from '../../src/services/tenant-template';

describe('TenantTemplateService', () => {
  beforeEach(() => {
    resetTenantTemplateStore();
  });

  it('creates and retrieves a template', () => {
    const created = createTenantTemplate({
      name: 'Pro Template',
      tenant: {
        plan: 'pro',
        status: 'active',
        limits: { daily_requests: 10000, daily_tokens: 1000000, max_api_keys: 20, concurrent_requests: 50 },
      },
    });
    expect(created.template_id).toMatch(/^tpl_/);
    expect(getTenantTemplate(created.template_id)?.name).toBe('Pro Template');
  });

  it('lists templates', () => {
    createTenantTemplate({ name: 'A', tenant: { plan: 'free', status: 'active' } });
    createTenantTemplate({ name: 'B', tenant: { plan: 'pro', status: 'active' } });
    expect(listTenantTemplates()).toHaveLength(2);
  });

  it('updates a template', async () => {
    const created = createTenantTemplate({ name: 'Old', tenant: { plan: 'free', status: 'active' } });
    const updated = await updateTenantTemplate(created.template_id, { name: 'New' });
    expect(updated?.name).toBe('New');
  });

  it('deletes a template', async () => {
    const created = createTenantTemplate({ name: 'ToDelete', tenant: { plan: 'free', status: 'active' } });
    expect(await deleteTenantTemplate(created.template_id)).toBe(true);
    expect(getTenantTemplate(created.template_id)).toBeNull();
  });

  it('returns default template', () => {
    createTenantTemplate({ name: 'Default', is_default: true, tenant: { plan: 'free', status: 'active' } });
    createTenantTemplate({ name: 'Other', tenant: { plan: 'pro', status: 'active' } });
    expect(getDefaultTenantTemplate()?.name).toBe('Default');
  });
});
```

- [ ] **Step 3: 运行测试**

```bash
npx jest tests/services/tenant-template.test.ts --no-coverage
```

Expected: 全部通过。

- [ ] **Step 4: Commit**

```bash
git add src/services/tenant-template.ts tests/services/tenant-template.test.ts
git commit -m "feat(tenant-template): add TenantTemplateStore with CRUD and tests"
```

---

## Task 4: 启动入口加载模板存储

**Files:**
- Modify: `src/index.ts`

**Interfaces:**
- Consumes: `initTenantTemplateStore`

- [ ] **Step 1: 在启动流程中调用 `initTenantTemplateStore()`**

找到 `src/index.ts` 中与 `initTenantStore()` 并列的初始化调用，追加：

```typescript
import { initTenantTemplateStore } from './services/tenant-template';

// 在 startServer() 或 init() 中，与 initTenantStore() 一起调用
await Promise.all([initTenantStore(), initTenantTemplateStore()]);
```

- [ ] **Step 2: Commit**

```bash
git add src/index.ts
git commit -m "feat(server): load tenant templates on startup"
```

---

## Task 5: 新增 /v1/tenant-templates Admin 路由

**Files:**
- Create: `src/routes/admin/tenant-template.ts`
- Modify: `src/routes/admin/index.ts`

**Interfaces:**
- Consumes: `tenantTemplateSchema`, `tenantTemplateUpdateSchema`, `createTenantTemplate`, `getTenantTemplate`, `updateTenantTemplate`, `deleteTenantTemplate`, `listTenantTemplates`
- Produces: `/v1/tenant-templates` CRUD 端点

- [ ] **Step 1: 创建路由文件**

```typescript
import { Hono } from 'hono';
import type { Context } from 'hono';
import {
  createTenantTemplate,
  getTenantTemplate,
  updateTenantTemplate,
  deleteTenantTemplate,
  listTenantTemplates,
} from '../../services/tenant-template';
import { tenantTemplateSchema, tenantTemplateUpdateSchema } from '../../validation';
import { auditAdmin } from '../../utils/audit';

const router = new Hono();

router.get('/v1/tenant-templates', (c: Context) => {
  return c.json({ templates: listTenantTemplates() });
});

router.get('/v1/tenant-templates/:id', (c: Context) => {
  const id = c.req.param('id')!;
  const template = getTenantTemplate(id);
  if (!template) {
    return c.json({ error: { message: 'Template not found', type: 'invalid_request_error', code: 'not_found' } }, 404);
  }
  return c.json(template);
});

router.post('/v1/tenant-templates', async (c: Context) => {
  const parsed = tenantTemplateSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({
      error: {
        message: parsed.error.errors[0]?.message || 'Invalid template',
        type: 'invalid_request_error',
        code: 'invalid_request',
      },
    }, 400);
  }
  const template = createTenantTemplate(parsed.data);
  auditAdmin({
    ruleId: 'admin.template_created',
    action: 'allow',
    metadata: { template_id: template.template_id, name: template.name },
    severity: 'low',
  });
  return c.json(template, 201);
});

router.put('/v1/tenant-templates/:id', async (c: Context) => {
  const id = c.req.param('id')!;
  const parsed = tenantTemplateUpdateSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({
      error: {
        message: parsed.error.errors[0]?.message || 'Invalid template update',
        type: 'invalid_request_error',
        code: 'invalid_request',
      },
    }, 400);
  }
  const template = await updateTenantTemplate(id, parsed.data);
  if (!template) {
    return c.json({ error: { message: 'Template not found', type: 'invalid_request_error', code: 'not_found' } }, 404);
  }
  auditAdmin({
    ruleId: 'admin.template_updated',
    action: 'allow',
    metadata: { template_id: id, name: template.name },
    severity: 'low',
  });
  return c.json(template);
});

router.delete('/v1/tenant-templates/:id', async (c: Context) => {
  const id = c.req.param('id')!;
  const deleted = await deleteTenantTemplate(id);
  if (!deleted) {
    return c.json({ error: { message: 'Template not found', type: 'invalid_request_error', code: 'not_found' } }, 404);
  }
  auditAdmin({
    ruleId: 'admin.template_deleted',
    action: 'allow',
    metadata: { template_id: id },
    severity: 'low',
  });
  return c.json({ deleted: true });
});

export default router;
```

- [ ] **Step 2: 挂载路由**

在 `src/routes/admin/index.ts` 中导入并挂载：

```typescript
import tenantTemplateRouter from './tenant-template';

adminRouter.route('/', tenantTemplateRouter);
```

- [ ] **Step 3: 添加路由测试**

创建 `tests/routes/tenant-template.test.ts`：

```typescript
import { describe, it, expect, beforeEach } from '@jest/globals';
import app from '../../src/app';
import { resetTenantTemplateStore } from '../../src/services/tenant-template';

const ADMIN_KEY = 'test-admin-key';

describe('Tenant Template Routes', () => {
  beforeEach(() => {
    resetTenantTemplateStore();
  });

  it('rejects non-admin requests', async () => {
    const res = await app.request('/v1/tenant-templates', {
      method: 'GET',
      headers: { Authorization: 'Bearer invalid' },
    });
    expect(res.status).toBe(401);
  });

  it('creates and lists templates', async () => {
    const createRes = await app.request('/v1/tenant-templates', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${ADMIN_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: 'Pro',
        tenant: { plan: 'pro', status: 'active' },
      }),
    });
    expect(createRes.status).toBe(201);

    const listRes = await app.request('/v1/tenant-templates', {
      headers: { Authorization: `Bearer ${ADMIN_KEY}` },
    });
    const data = await listRes.json();
    expect(data.templates).toHaveLength(1);
    expect(data.templates[0].name).toBe('Pro');
  });
});
```

注意：测试需确保 `app` 已加载 admin key，或当前测试基础设施已处理。如果 `ADMIN_KEY` 需要与 `conf/default.json` 一致，请使用现有测试中的 admin key 获取方式。

- [ ] **Step 4: 运行测试**

```bash
npx jest tests/routes/tenant-template.test.ts --no-coverage
```

Expected: 全部通过。

- [ ] **Step 5: Commit**

```bash
git add src/routes/admin/tenant-template.ts src/routes/admin/index.ts tests/routes/tenant-template.test.ts
git commit -m "feat(admin): add /v1/tenant-templates CRUD routes and tests"
```

---

## Task 6: 改造 POST /v1/tenants 支持模板与默认 Key

**Files:**
- Modify: `src/routes/admin/tenant.ts:32-48`
- Modify: `src/validation/index.ts`（新增 `createTenantWithTemplateSchema`）

**Interfaces:**
- Consumes: `createTenantWithTemplateSchema`, `getTenantTemplate`, `createTenant`, `createTenantApiKey`, `setBalance`
- Produces: 新响应结构 `{ tenant, default_key?, default_key_error? }`

- [ ] **Step 1: 在 `src/validation/index.ts` 新增 `createTenantWithTemplateSchema`**

```typescript
export const createTenantWithTemplateSchema = tenantConfigSchema.extend({
  template_id: z.string().optional(),
  create_default_key: z.boolean().optional(),
});
```

- [ ] **Step 2: 修改 `src/routes/admin/tenant.ts` 的 `POST /v1/tenants` 处理器**

替换现有处理器为：

```typescript
import { createTenantWithTemplateSchema } from '../../validation';
import { getTenantTemplate } from '../../services/tenant-template';
import { setBalance } from '../../services/wallet';

router.post('/v1/tenants', async (c: Context) => {
  const parsed = createTenantWithTemplateSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({
      error: {
        message: parsed.error.errors[0]?.message || 'Invalid tenant config',
        type: 'invalid_request_error',
        code: 'invalid_request',
      },
    }, 400);
  }

  const { template_id, create_default_key, ...tenantInput } = parsed.data;

  let template: ReturnType<typeof getTenantTemplate> = null;
  if (template_id) {
    template = getTenantTemplate(template_id);
    if (!template) {
      return c.json({ error: { message: 'Template not found', type: 'invalid_request_error', code: 'not_found' } }, 404);
    }
  }

  const mergedTenant = {
    name: tenantInput.name,
    plan: tenantInput.plan ?? template?.tenant.plan ?? 'free',
    status: tenantInput.status ?? template?.tenant.status ?? 'active',
    settings: { ...template?.tenant.settings, ...tenantInput.settings },
    limits: { ...template?.tenant.limits, ...tenantInput.limits },
  };

  const tenant = await createTenant(mergedTenant);
  if (!tenant) {
    return c.json({ error: { message: 'Failed to create tenant', type: 'invalid_request_error', code: 'create_failed' } }, 400);
  }

  const response: {
    tenant: typeof tenant;
    default_key?: Awaited<ReturnType<typeof createTenantApiKey>>;
    default_key_error?: { message: string; code: string };
  } = { tenant };

  if (create_default_key) {
    const keyPolicy = template?.default_key ?? { name: 'default', billing_mode: 'competition' as const };
    const key = await createTenantApiKey(
      tenant.tenant_id,
      keyPolicy.name,
      keyPolicy.expires_at,
      {
        allowed_models: keyPolicy.allowed_models,
        default_model: keyPolicy.default_model,
        rate_limit_qps: keyPolicy.rate_limit_qps,
        rate_limit_burst: keyPolicy.rate_limit_burst,
        monthly_budget: keyPolicy.monthly_budget,
        max_tokens_per_request: keyPolicy.max_tokens_per_request,
        metadata: keyPolicy.metadata,
        billing_mode: keyPolicy.billing_mode,
        subscription_expires_at: keyPolicy.subscription_expires_at,
      },
      keyPolicy.balance
    );

    if (key) {
      response.default_key = key;
      auditAdmin({
        tenantId: tenant.tenant_id,
        ruleId: 'admin.key_created',
        action: 'allow',
        metadata: { key_name: key.name, source: 'template_default', template_id },
        severity: 'low',
      });
    } else {
      response.default_key_error = {
        message: 'Failed to create default API key. The tenant was created successfully; please create a key manually.',
        code: 'default_key_failed',
      };
    }
  }

  auditAdmin({
    ruleId: 'admin.tenant_created',
    action: 'allow',
    tenantId: tenant.tenant_id,
    metadata: { template_id, create_default_key },
    severity: 'low',
  });

  return c.json(response, 201);
});
```

注意：`createTenantApiKey` 返回的 `key` 字段为明文，直接放入 `default_key` 即可。

- [ ] **Step 3: 扩展租户路由测试**

在 `tests/routes/tenant.test.ts` 中新增用例（若文件不存在则创建）：

```typescript
it('creates tenant from template with default key', async () => {
  // 先创建模板
  const templateRes = await app.request('/v1/tenant-templates', {
    method: 'POST',
    headers: { Authorization: `Bearer ${ADMIN_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'Pro Template',
      tenant: { plan: 'pro', status: 'active' },
      default_key: { name: 'default', billing_mode: 'competition' },
    }),
  });
  const template = await templateRes.json();

  const res = await app.request('/v1/tenants', {
    method: 'POST',
    headers: { Authorization: `Bearer ${ADMIN_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'From Template',
      template_id: template.template_id,
      create_default_key: true,
    }),
  });
  expect(res.status).toBe(201);
  const data = await res.json();
  expect(data.tenant.plan).toBe('pro');
  expect(data.default_key).toBeDefined();
  expect(data.default_key.key).toMatch(/^sk-v1-/);
});
```

- [ ] **Step 4: 运行相关测试**

```bash
npx jest tests/routes/tenant.test.ts tests/services/tenant.test.ts --no-coverage
```

Expected: 全部通过。

- [ ] **Step 5: Commit**

```bash
git add src/validation/index.ts src/routes/admin/tenant.ts tests/routes/tenant.test.ts tests/services/tenant.test.ts
git commit -m "feat(tenant): support template-based creation and optional default key"
```

---

## Task 7: 后端 Lint / TypeScript / Jest 回归

- [ ] **Step 1: Lint**

```bash
npm run lint
```

Expected: 无错误。

- [ ] **Step 2: TypeScript**

```bash
npx tsc --noEmit
```

Expected: 无错误。

- [ ] **Step 3: Jest 全量**

```bash
npm test
```

Expected: 现有测试 + 新增测试全部通过。

- [ ] **Step 4: Commit（如仅修复 lint/tsc 问题）**

```bash
git commit -m "chore: fix lint and type errors for tenant template feature"
```

---

## Task 8: 前端新增类型定义

**Files:**
- Modify: `ai-gateway-admin/src/types/index.ts`

**Interfaces:**
- Produces: `TenantTemplate`, `DefaultKeyPolicy`, `CreateTenantData`

- [ ] **Step 1: 在类型文件中追加**

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

- [ ] **Step 2: Commit**

```bash
git add ai-gateway-admin/src/types/index.ts
git commit -m "types(admin): add TenantTemplate and CreateTenantData interfaces"
```

---

## Task 9: 前端 API 服务扩展

**Files:**
- Modify: `ai-gateway-admin/src/services/api.ts`

**Interfaces:**
- Consumes: `TenantTemplate`, `DefaultKeyPolicy`, `CreateTenantData`, `Tenant`, `ApiKey`
- Produces: 模板 CRUD 函数、更新后的 `createTenant`

- [ ] **Step 1: 在 api.ts 中追加模板 API 并更新 createTenant**

```typescript
export async function getTenantTemplates(): Promise<{ templates: TenantTemplate[] }> {
  return get<{ templates: TenantTemplate[] }>('/v1/tenant-templates')
}

export async function createTenantTemplate(data: Omit<TenantTemplate, 'template_id' | 'created_at' | 'updated_at'>): Promise<TenantTemplate> {
  return post<TenantTemplate>('/v1/tenant-templates', data)
}

export async function updateTenantTemplate(id: string, data: Partial<Omit<TenantTemplate, 'template_id' | 'created_at'>>): Promise<TenantTemplate> {
  return put<TenantTemplate>(`/v1/tenant-templates/${id}`, data)
}

export async function deleteTenantTemplate(id: string): Promise<{ deleted: boolean }> {
  return del<{ deleted: boolean }>(`/v1/tenant-templates/${id}`)
}

export async function createTenant(data: CreateTenantData): Promise<{
  tenant: Tenant
  default_key?: ApiKey
  default_key_error?: { message: string; code: string }
}> {
  return post<{
    tenant: Tenant
    default_key?: ApiKey
    default_key_error?: { message: string; code: string }
  }>('/v1/tenants', data)
}
```

注意：`createTenant` 的返回类型变更会影响 `Tenants` 页面调用点，需在 Task 11 中同步修改。

- [ ] **Step 2: Commit**

```bash
git add ai-gateway-admin/src/services/api.ts
git commit -m "feat(admin-api): add tenant template service methods and update createTenant signature"
```

---

## Task 10: 新增租户模板管理页面

**Files:**
- Create: `ai-gateway-admin/src/pages/TenantTemplates/index.tsx`
- Create: `ai-gateway-admin/src/pages/TenantTemplates/index.test.tsx`

**Interfaces:**
- Consumes: `getTenantTemplates`, `createTenantTemplate`, `updateTenantTemplate`, `deleteTenantTemplate`

- [ ] **Step 1: 创建页面组件**

实现一个表格 + 弹窗页面，字段与 Tenants 创建表单一致，并额外包含：
- 基本信息：名称、描述、是否默认模板
- 租户配置：plan、status、settings、limits
- 默认 Key 策略（可选折叠面板）：name、billing_mode、balance、allowed_models、default_model、rate_limit、monthly_budget 等

由于篇幅较长，此处不展开完整 JSX，实现时请遵循现有 `Tenants/index.tsx` 的 Form/Modal/Table 模式：
- 使用 `useState` + `useEffect` 加载列表。
- 删除操作使用 `Modal.confirm`。
- 表单提交后 `message.success` 并刷新列表。

- [ ] **Step 2: 创建基础测试**

```typescript
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import TenantTemplates from './index'
import * as api from '@/services/api'

vi.mock('@/services/api')

describe('TenantTemplates', () => {
  it('renders template list', async () => {
    vi.mocked(api.getTenantTemplates).mockResolvedValue({
      templates: [{
        template_id: 'tpl_1',
        name: 'Pro',
        tenant: { plan: 'pro', status: 'active' },
        created_at: Date.now(),
        updated_at: Date.now(),
      }],
    })
    render(<TenantTemplates />)
    await waitFor(() => expect(screen.getByText('Pro')).toBeInTheDocument())
  })
})
```

- [ ] **Step 3: Commit**

```bash
git add ai-gateway-admin/src/pages/TenantTemplates/index.tsx ai-gateway-admin/src/pages/TenantTemplates/index.test.tsx
git commit -m "feat(admin-ui): add TenantTemplates management page"
```

---

## Task 11: 注册模板页面路由与菜单

**Files:**
- Modify: `ai-gateway-admin/src/App.tsx`
- Modify: Admin Layout 菜单文件（如 `ai-gateway-admin/src/components/Layout/index.tsx` 或类似位置）

**Interfaces:**
- Consumes: `TenantTemplates` 页面

- [ ] **Step 1: 在 App.tsx 中添加路由**

```typescript
import TenantTemplates from './pages/TenantTemplates'

// 在路由配置中加入
<Route path="/tenant-templates" element={<TenantTemplates />} />
```

- [ ] **Step 2: 在 Layout 菜单中添加「租户模板」入口**

在现有菜单数组中追加：

```typescript
{
  key: '/tenant-templates',
  icon: <FileTextOutlined />,
  label: '租户模板',
}
```

- [ ] **Step 3: Commit**

```bash
git add ai-gateway-admin/src/App.tsx ai-gateway-admin/src/components/Layout/index.tsx
git commit -m "feat(admin-ui): register TenantTemplates route and menu"
```

---

## Task 12: 改造 Tenants 页面创建租户弹窗

**Files:**
- Modify: `ai-gateway-admin/src/pages/Tenants/index.tsx`

**Interfaces:**
- Consumes: `getTenantTemplates`, `createTenant`（新签名）
- Produces: 模板选择器、默认 Key 复选框、复制 Key 弹窗复用

- [ ] **Step 1: 加载模板列表并在创建弹窗中加入选择器**

在 `Tenants` 组件中添加：

```typescript
const [templates, setTemplates] = useState<TenantTemplate[]>([])

const fetchTemplates = async () => {
  try {
    const data = await getTenantTemplates()
    setTemplates(data.templates || [])
  } catch {
    // 静默失败
  }
}

useEffect(() => {
  fetchTenants()
  fetchProviderAndModelOptions()
  fetchTemplates()
}, [])
```

在创建租户 Form 中，在「名称」字段前加入：

```typescript
<Form.Item label="模板（可选）" name="template_id">
  <Select
    placeholder="请选择模板"
    allowClear
    showSearch
    options={templates.map((t) => ({ label: t.name, value: t.template_id }))}
    onChange={(value) => {
      const tpl = templates.find((t) => t.template_id === value)
      if (tpl) {
        form.setFieldsValue({
          plan: tpl.tenant.plan,
          status: tpl.tenant.status,
          settings: tpl.tenant.settings,
          limits: tpl.tenant.limits,
          create_default_key: !!tpl.default_key,
        })
      }
    }}
  />
</Form.Item>

<Form.Item name="create_default_key" valuePropName="checked">
  <Checkbox>同时创建默认 API Key</Checkbox>
</Form.Item>
```

- [ ] **Step 2: 调整 `handleCreate` 以使用新 `createTenant` 签名**

```typescript
const result = await createTenant(payload)
message.success('创建成功')
if (result.default_key?.key) {
  setNewKeyData({ key: result.default_key.key, name: result.default_key.name })
} else if (result.default_key_error) {
  message.warning(`租户已创建，但默认 Key 生成失败：${result.default_key_error.message}`)
}
setCreateModalVisible(false)
form.resetFields()
fetchTenants()
```

- [ ] **Step 3: 扩展 Tenants 页面测试**

在 `ai-gateway-admin/src/pages/Tenants/index.test.tsx` 中新增：
- 选择模板后表单值被填充。
- 提交时携带 `template_id` 与 `create_default_key`。

- [ ] **Step 4: Commit**

```bash
git add ai-gateway-admin/src/pages/Tenants/index.tsx ai-gateway-admin/src/pages/Tenants/index.test.tsx
git commit -m "feat(admin-ui): template selector and default key option in tenant creation"
```

---

## Task 13: 前端 Lint / TypeScript / Vitest 回归

- [ ] **Step 1: Lint**

```bash
cd ai-gateway-admin
pnpm lint
```

Expected: 无错误，max-warnings 0。

- [ ] **Step 2: TypeScript**

```bash
pnpm tsc --noEmit
```

Expected: 无错误。

- [ ] **Step 3: Vitest**

```bash
pnpm test
```

Expected: 全部通过。

- [ ] **Step 4: Commit（如仅修复 lint/tsc 问题）**

```bash
git commit -m "chore(admin-ui): fix lint and type errors for tenant template feature"
```

---

## Task 14: 端到端验证

- [ ] **Step 1: 启动后端与前端的 dev 服务**

```bash
# 后端
npm run dev

# 前端（新终端）
cd ai-gateway-admin
pnpm dev
```

- [ ] **Step 2: 手动验证流程**

1. 登录 Admin 面板。
2. 进入「租户模板」页面，创建一个包含默认 Key 策略的模板。
3. 进入「租户管理」页面，点击「创建租户」。
4. 选择模板，观察表单自动填充。
5. 勾选「同时创建默认 API Key」，提交。
6. 确认弹出复制 Key 弹窗，且后端只存储哈希值。
7. 检查租户详情中已存在默认 Key。

- [ ] **Step 3: 如无问题，可进行一次汇总提交**

```bash
git commit -m "feat: tenant templates and default API key creation"
```

---

## Self-Review

### Spec Coverage

| 需求 | 任务 |
|------|------|
| 动态模板 CRUD | Task 3, Task 5 |
| 创建租户时选择模板 | Task 6, Task 12 |
| 字段级合并 | Task 6 |
| 可选默认 API Key | Task 6, Task 12 |
| 预付余额初始化 | Task 6（复用 `createTenantApiKey` 的 balance 逻辑） |
| 明文 Key 仅返回一次 | Task 6 |
| 默认 Key 创建失败不回滚 | Task 6 |
| 前端模板管理页面 | Task 10, Task 11 |
| 前端创建租户弹窗改造 | Task 12 |
| 审计日志 | Task 5, Task 6 |
| 测试覆盖 | Task 3, Task 5, Task 6, Task 10, Task 12 |

### Placeholder Scan

- 无 TBD / TODO。
- Admin Layout 菜单文件路径未在文档中硬编码，实际执行时需根据项目结构确认。
- `ADMIN_KEY` 在测试代码中为示意，需使用项目现有测试基础设施中的真实 admin key。

### Type Consistency

- `ITenantTemplate` 与前端 `TenantTemplate` 字段一致。
- `createTenant` 前后端返回结构一致（`tenant`, `default_key?`, `default_key_error?`）。
- `balance` 单位统一为微元。

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-05-tenant-template-plan.md`.

Two execution options:

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
