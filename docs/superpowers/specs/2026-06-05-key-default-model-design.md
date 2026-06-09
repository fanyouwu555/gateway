# API Key Default Model — Design Spec

Date: 2026-06-05 | Status: Approved

## Overview

为 API Key 分配默认模型：用户获取 key 可用的模型列表、未指定模型时自动使用默认模型、也可指定白名单中的模型使用。

## Data Model

### `IApiKeyMeta` 新增字段

```typescript
default_model?: string;  // 该 key 的默认模型
```

- 可选字段，创建/更新时均可设置
- 不校验模型是否存在（模型可能后续动态加入）
- `default_model` 不受 `allowed_models` 限制，始终可用

### Zod Schema 更新

- `createApiKeySchema` — 新增 `default_model: z.string().optional()`
- `updateKeyPolicySchema` — 新增 `default_model: z.string().optional()`
- Chat request schema — `model` 字段由必填改为可选

## API Changes

### 1. Key 创建/更新接口扩展

`POST /v1/tenants/:id/keys` 和 `PUT /v1/tenants/:id/keys/:keyHash` 的 request body 支持新字段 `default_model`。

### 2. `GET /v1/models` 增强

按当前请求的 API Key 过滤模型列表并标记默认模型。

**过滤逻辑：**
- key 有 `allowed_models` → `data` 只返回白名单中的模型 + `default_model`（若不在白名单中）
- key 无 `allowed_models` → `data` 返回全部模型

**响应格式：**
```json
{
  "object": "list",
  "data": [...],
  "default_model": "gpt-4o"
}
```
- key 有 `default_model` → 响应包含 `default_model` 字段
- key 无 `default_model` → 不返回 `default_model` 字段

### 3. Chat Completions 模型选择优先级

1. 请求中明确传了 `model` → 使用该模型（校验 `allowed_models`，`default_model` 自动放行）
2. 请求中未传 `model`，key 有 `default_model` → 使用 `default_model`
3. 请求中未传 `model`，key 无 `default_model` → 使用路由配置中第一个可用模型

## File Changes

| File | Change |
|---|---|
| `src/types/index.ts` | `IApiKeyMeta` 加 `default_model?: string` |
| `src/validation/index.ts` | schema 加 `default_model`；chat `model` 改可选 |
| `src/services/tenant.ts` | `updateApiKeyPolicy` 支持 `default_model` |
| `src/routes/admin.ts` | key 创建/更新透传 `default_model` |
| `src/routes/model.ts` | 按 key 过滤模型 + 标记 `default_model` |
| `src/routes/chat.ts` | 未传 model 时的默认模型解析 |
| `tests/` | model 过滤、默认模型选择、allowed_models 放行测试 |

## Behavior Notes

- Stream 与普通 chat 行为一致：模型解析在流启动前完成
- Embeddings 不做默认模型逻辑（需求仅限 chat 场景）
- `default_model` 独立于 `allowed_models`，始终可用
- Tenant 级别不设置默认模型（仅 Key 级别）
