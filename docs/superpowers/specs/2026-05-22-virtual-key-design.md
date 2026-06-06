# Virtual Key System Design

## Overview

Add application-level API key isolation to the AI Gateway. Each tenant can create multiple "virtual keys" with independent rate limits, budget caps, model allowlists, and per-key usage tracking. This enables the gateway operator to distribute individual keys to end users, with each key carrying its own policy.

## Data Model

Extend `IApiKeyMeta` in `src/types/index.ts` with optional policy fields:

```typescript
export interface IApiKeyMeta {
  key: string;                      // scrypt hashed value
  tenant_id: TenantId;
  name: string;
  created_at: number;
  expires_at?: number;
  is_admin?: boolean;

  // Virtual key policy (all optional — existing keys are unaffected)
  allowed_models?: string[];             // model allowlist; empty = inherit tenant
  rate_limit_qps?: number;               // per-key QPS cap
  rate_limit_burst?: number;             // per-key burst capacity
  monthly_budget?: number;               // per-key monthly spend cap (USD)
  max_tokens_per_request?: number;       // clamp max_tokens per request
  metadata?: Record<string, string>;     // free-form labels (user_id, app_name, etc.)
}
```

### Design Decisions

- All fields are `?` optional — existing tenant keys are unchanged.
- `allowed_models = []` means "no extra restriction" (tenant-level allowlist still applies).
- `monthly_budget` at key level takes priority over tenant-level budget for that key's requests.
- `metadata` is propagated to structured logs and usage records for auditing and cost attribution.
- Key storage reuses the existing `TenantStore.apiKeys` map — no new store class needed.

## Admin API

### Create Virtual Key — `POST /v1/tenants/:id/keys`

Request body (extended):

```json
{
  "name": "user-zhangsan",
  "allowed_models": ["gpt-4o-mini", "deepseek-chat"],
  "rate_limit_qps": 5,
  "rate_limit_burst": 10,
  "monthly_budget": 20,
  "max_tokens_per_request": 4096,
  "metadata": { "user_id": "u123" }
}
```

Response includes the plaintext key (`sk-v1-{tenant_prefix}-{random}`) — returned only at creation.

### Update Key Policy — `PUT /v1/tenants/:id/keys/:keyHash`

Update any policy field. Key itself (plaintext, hash) is immutable.

### Get Key Usage — `GET /v1/tenants/:id/keys/:keyHash/usage`

Returns per-key stats: total_requests, total_tokens, total_cost, period.

### List Tenant Keys — `GET /v1/tenants/:id/keys` (unchanged)

## Request Pipeline Integration

A new lightweight middleware runs after auth, reading `api_key_meta` from context:

```
request → auth middleware → virtual key policy middleware → rate limit → chat handler
```

| Policy | Enforcement Point | Behavior |
|--------|------------------|----------|
| `allowed_models` | chat.ts entry | Reject with 403 if `request.model` not in allowlist |
| `rate_limit_qps/burst` | ratelimit middleware | Use `key:<hashedKey>` as isolated bucket key |
| `monthly_budget` | quota check | Track per-key monthly cost, reject if exceeded |
| `max_tokens_per_request` | chat.ts entry | Clamp `request.max_tokens` to this value |
| `metadata` | logging + metrics | Written to structured log and usage records |

### Usage Recording

Extend `recordUsage(tenantId, tokens, cost)` → `recordUsage(tenantId, tokens, cost, keyHash?, metadata?)` to track per-key metrics alongside per-tenant aggregates.

### Rate Limiting

When `rate_limit_qps` is set on the key, the rate limiter uses `<hashedKey>` as the bucket key instead of the tenant ID. The key's QPS/burst takes priority over any tenant-level or global rate limit for requests authenticated with that key.

## Files to Modify

| File | Change | Impact |
|------|--------|--------|
| `src/types/index.ts` | Extend `IApiKeyMeta` with policy fields | None (all optional) |
| `src/services/tenant.ts` | Add `updateApiKeyPolicy()` method, store plaintext prefix for hash lookup in updates | Internal only |
| `src/services/metrics.ts` | Extend `recordUsage` to accept keyHash + metadata; add `getKeyUsage()` | New exports |
| `src/services/quota.ts` | `checkQuota` to optionally validate at key level | Backward compat |
| `src/middleware/auth.ts` | Append key policy to context after auth | New export |
| `src/middleware/ratelimit.ts` | Support key-level bucket key | Optional path |
| `src/routes/admin.ts` | Add `PUT /keys/:keyHash`, `GET /keys/:keyHash/usage`; extend `POST /keys` schema | New routes |
| `src/validation/index.ts` | Update `createApiKeySchema` with new fields; add `updateKeyPolicySchema` | Schema extension |
| `ai-gateway-admin/src/pages/Tenants/` | Key list page: show policy columns; inline edit for allowed_models/qps/budget | Frontend |

## Verification

1. `POST /v1/tenants/default/keys` with policy fields → returns plaintext key + 201
2. Use returned key in `x-api-key` header → succeeds with applied restrictions
3. Request with disallowed model → 403 with model_not_allowed error
4. Exceed key monthly_budget → 429 with budget_exceeded error
5. `PUT /v1/tenants/default/keys/<hash>` → updates policy, subsequent requests reflect new policy
6. `GET /v1/tenants/default/keys/<hash>/usage` → returns per-key stats
7. All existing tests pass (38 suites / 395 tests, no regressions)