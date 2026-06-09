# Key Default Model — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `default_model` support to API keys — users can set a default model per key, `GET /v1/models` filters by key and marks the default, and chat requests without a `model` field use the default.

**Architecture:** Extend the existing `IApiKeyMeta` type, validation schemas, tenant service, and admin routes. Enhance `GET /v1/models` to filter by key's `allowed_models` and mark `default_model`. Modify chat completions to resolve model from default when not provided. 4 files modified, no new files.

**Tech Stack:** TypeScript, Hono, Zod, Jest

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `src/types/index.ts:226-245` | `IApiKeyMeta` interface | Add `default_model?: string` |
| `src/validation/index.ts:52,129-149` | Request schemas | `model` optional, schemas + `default_model` |
| `src/services/tenant.ts:145-149,266-269` | Key create/update Pick types | Include `default_model` in policy Pick |
| `src/routes/admin.ts:353-418` | Admin key CRUD | Destructure + pass `default_model` |
| `src/routes/model.ts` | Model listing | Per-key filter + default_model marker |
| `src/routes/chat.ts:67,90-120` | Chat completions | Default model fallback logic |

---

### Task 1: Type + Schema Changes

**Files:**
- Modify: `src/types/index.ts:239`
- Modify: `src/validation/index.ts:52,129-149`

- [ ] **Step 1: Add `default_model` to `IApiKeyMeta`**

In `src/types/index.ts`, add after line 239 (`allowed_models`):

```typescript
  default_model?: string;                // 该 Key 的默认模型
```

- [ ] **Step 2: Add `default_model` to Zod schemas, make chat `model` optional**

In `src/validation/index.ts`:

Change line 53 (`model` field in `chatCompletionRequestSchema`):
```typescript
  model: z.string().optional(),
```

Add to `createApiKeySchema` (line 129), after `allowed_models`:
```typescript
  default_model: z.string().optional(),
```

Add to `updateKeyPolicySchema` (line 140), after `allowed_models`:
```typescript
  default_model: z.string().optional(),
```

- [ ] **Step 3: Run tsc to verify types compile**

Run: `npx tsc --noEmit`
Expected: PASS (no type errors)

- [ ] **Step 4: Commit**

```bash
git add src/types/index.ts src/validation/index.ts
git commit -m "feat: add default_model to IApiKeyMeta and validation schemas"
```

---

### Task 2: Tenant Service + Admin Route Changes

**Files:**
- Modify: `src/services/tenant.ts:145-149,266-269`
- Modify: `src/routes/admin.ts:353-418`

- [ ] **Step 5: Update `createApiKey` Pick type to include `default_model`**

In `src/services/tenant.ts` line 149, change the `policy` parameter type from:

```typescript
    policy?: Pick<IApiKeyMeta, 'allowed_models' | 'rate_limit_qps' | 'rate_limit_burst' | 'monthly_budget' | 'max_tokens_per_request' | 'metadata'>
```

to:

```typescript
    policy?: Pick<IApiKeyMeta, 'allowed_models' | 'default_model' | 'rate_limit_qps' | 'rate_limit_burst' | 'monthly_budget' | 'max_tokens_per_request' | 'metadata'>
```

- [ ] **Step 6: Update `updateApiKeyPolicy` Pick type to include `default_model`**

In `src/services/tenant.ts` line 268, change the `updates` parameter type from:

```typescript
    updates: Partial<Pick<IApiKeyMeta, 'name' | 'expires_at' | 'allowed_models' | 'rate_limit_qps' | 'rate_limit_burst' | 'monthly_budget' | 'max_tokens_per_request' | 'metadata'>>
```

to:

```typescript
    updates: Partial<Pick<IApiKeyMeta, 'name' | 'expires_at' | 'allowed_models' | 'default_model' | 'rate_limit_qps' | 'rate_limit_burst' | 'monthly_budget' | 'max_tokens_per_request' | 'metadata'>>
```

- [ ] **Step 7: Update admin route to destructure and pass `default_model`**

In `src/routes/admin.ts` line 363, change the destructure from:

```typescript
  const { name, expires_at, allowed_models, rate_limit_qps, rate_limit_burst, monthly_budget, max_tokens_per_request, metadata } = parsed.data;
  const key = createTenantApiKey(tenantId, name, expires_at, {
    allowed_models,
    rate_limit_qps,
    rate_limit_burst,
    monthly_budget,
    max_tokens_per_request,
    metadata,
  });
```

to:

```typescript
  const { name, expires_at, allowed_models, default_model, rate_limit_qps, rate_limit_burst, monthly_budget, max_tokens_per_request, metadata } = parsed.data;
  const key = createTenantApiKey(tenantId, name, expires_at, {
    allowed_models,
    default_model,
    rate_limit_qps,
    rate_limit_burst,
    monthly_budget,
    max_tokens_per_request,
    metadata,
  });
```

- [ ] **Step 8: Run tsc to verify types compile**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add src/services/tenant.ts src/routes/admin.ts
git commit -m "feat: pass default_model through tenant service and admin routes"
```

---

### Task 3: Model Listing — Per-Key Filter + Default Marker

**Files:**
- Modify: `src/routes/model.ts`

- [ ] **Step 10: Rewrite model route to filter by key and mark default**

Replace the content of `src/routes/model.ts`:

```typescript
/**
 * Models 路由处理
 * GET /v1/models
 */
import { Hono } from 'hono';
import { getConfig } from '../config';

const modelRouter = new Hono();

/**
 * 获取可用模型列表（按当前 Key 过滤 + 标记默认模型）
 */
modelRouter.get('/v1/models', (c) => {
  const config = getConfig();

  // 从 routing 配置中提取所有可用模型
  const models: Array<{ id: string; object: string; owned_by: string }> = [];
  for (const strategy of config.routing) {
    for (const rule of strategy.rules) {
      models.push({
        id: rule.model,
        object: 'model',
        owned_by: rule.provider,
      });
    }
  }

  // 去重
  const allModels = models.filter(
    (model, index, self) => index === self.findIndex((m) => m.id === model.id)
  );

  // 按当前 Key 过滤
  const apiKeyMeta = c.get('api_key_meta') as import('../types').IApiKeyMeta | undefined;
  const allowedModels = apiKeyMeta?.allowed_models;
  const defaultModel = apiKeyMeta?.default_model;

  let data: typeof allModels;
  if (allowedModels && allowedModels.length > 0) {
    // 白名单过滤：allowed_models + default_model（始终可见）
    const allowedSet = new Set(allowedModels);
    if (defaultModel) {
      allowedSet.add(defaultModel);
    }
    data = allModels.filter((m) => allowedSet.has(m.id));
  } else {
    data = allModels;
  }

  const response: { object: string; data: typeof data; default_model?: string } = {
    object: 'list',
    data,
  };
  if (defaultModel) {
    response.default_model = defaultModel;
  }

  return c.json(response);
});

export default modelRouter;
```

- [ ] **Step 11: Run tsc to verify types compile**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 12: Commit**

```bash
git add src/routes/model.ts
git commit -m "feat: filter /v1/models by key allowed_models and mark default_model"
```

---

### Task 4: Chat Completions — Default Model Fallback

**Files:**
- Modify: `src/routes/chat.ts:67,88-120`

- [ ] **Step 13: Add default model resolution logic in chat.ts**

In `src/routes/chat.ts`, after line 91 (model alias resolution block), insert default model resolution:

Current code (lines 90-91):
```typescript
    // 解析模型别名
    request = { ...request, model: resolveModelAlias(request.model) };
```

Change to:
```typescript
    // 解析模型别名
    if (request.model) {
      request = { ...request, model: resolveModelAlias(request.model) };
    }

    // 默认模型解析：请求未传 model → key default_model → 路由首个模型
    if (!request.model) {
      const apiKeyMeta = c.get('api_key_meta') as import('../types').IApiKeyMeta | undefined;
      if (apiKeyMeta?.default_model) {
        request = { ...request, model: resolveModelAlias(apiKeyMeta.default_model) };
      } else {
        // 兜底：使用路由配置中第一个可用模型
        const firstRule = config.routing[0]?.rules[0];
        if (firstRule) {
          request = { ...request, model: firstRule.model };
        }
      }
    }
```

Note: the `const config = getConfig();` already exists at line 161 — but we need it earlier. Move the config retrieval up, or add an early `getConfig()` call. The simplest approach: add `const config = getConfig();` right before the default model block. Since `getConfig()` is called again at line 161, this is fine (it's a lightweight call returning a reference).

Actually, looking at the code more carefully, `getConfig()` is already imported at line 18. Let me place the default model resolution right after template rendering (line 88) and before the alias resolution (line 90), and add `const config = getConfig();` just for the first-model fallback.

Final code block to insert after line 88 (`}` closing the template block):

```typescript

    // 默认模型解析：请求未传 model → key default_model → 路由首个模型
    if (!request.model) {
      const apiKeyMeta = c.get('api_key_meta') as import('../types').IApiKeyMeta | undefined;
      if (apiKeyMeta?.default_model) {
        request = { ...request, model: resolveModelAlias(apiKeyMeta.default_model) };
      } else {
        const firstRule = getConfig().routing[0]?.rules[0];
        if (firstRule) {
          request = { ...request, model: firstRule.model };
        }
      }
    }

    // 解析模型别名
    if (request.model) {
      request = { ...request, model: resolveModelAlias(request.model) };
    }
```

And change the original line 90-91:
```typescript
    // 解析模型别名
    request = { ...request, model: resolveModelAlias(request.model) };
```

to the guarded version shown above.

- [ ] **Step 14: Run tsc to verify types compile**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 15: Commit**

```bash
git add src/routes/chat.ts
git commit -m "feat: resolve default model when chat request has no model field"
```

---

### Task 5: Run Full Test Suite

- [ ] **Step 16: Run all tests**

```bash
npm test
```
Expected: 859+ tests PASS (existing tests must not regress)

- [ ] **Step 17: Commit if any snapshot updates needed**

```bash
git add -A && git commit -m "test: update snapshots for default_model changes"
```
(Only if needed)

---

### Task 6: Write Tests for New Behavior

**Files:**
- Modify: `tests/routes/chat.test.ts`
- Modify: `tests/routes/admin.test.ts`
- Modify: `tests/services/tenant.test.ts`

- [ ] **Step 18: Add test for default model fallback in chat**

In `tests/routes/chat.test.ts`, add a test case (use existing test patterns):

```typescript
describe('default_model fallback', () => {
  it('should use key default_model when request has no model', async () => {
    // Create a key with default_model set
    // Send chat request without model field
    // Assert the request uses the default model
  });

  it('should use first routing model when no default_model set', async () => {
    // Send chat request without model field with a key that has no default_model
    // Assert it falls back to the first routing rule's model
  });

  it('should allow default_model even when not in allowed_models', async () => {
    // Create key with allowed_models=['gpt-4'] and default_model='claude-3'
    // Send request without model → should use 'claude-3'
    // Send request with model='gpt-4' → should work
    // Send request with model='claude-3' → should work (default_model bypasses whitelist)
  });
});
```

- [ ] **Step 19: Add test for /v1/models filtering**

In `tests/routes/admin.test.ts` or `tests/routes.test.ts`, add:

```typescript
describe('GET /v1/models with key filtering', () => {
  it('should filter models by allowed_models', async () => { ... });
  it('should include default_model in response when set', async () => { ... });
  it('should include default_model in data even when not in allowed_models', async () => { ... });
  it('should return all models when no allowed_models set', async () => { ... });
});
```

- [ ] **Step 20: Add test for key create/update with default_model**

In `tests/services/tenant.test.ts`, add:

```typescript
describe('default_model in key policy', () => {
  it('should create key with default_model', async () => { ... });
  it('should update key default_model', async () => { ... });
});
```

- [ ] **Step 21: Run tests to verify**

Run: `npx jest --no-coverage tests/routes/chat.test.ts tests/routes/admin.test.ts tests/services/tenant.test.ts`
Expected: New tests PASS

- [ ] **Step 22: Run full test suite**

Run: `npm test`
Expected: All tests PASS

- [ ] **Step 23: Commit**

```bash
git add tests/
git commit -m "test: add default_model behavior tests"
```
