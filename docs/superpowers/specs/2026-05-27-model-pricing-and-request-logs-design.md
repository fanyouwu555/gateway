# Model Pricing & Enhanced Request Logs Design

## Overview

Add a config + runtime-overridable model pricing system to the AI Gateway, and enhance the frontend dashboard's "Recent Requests" table with full columns (time, provider, model, input/output tokens, cost, duration, status, tenant source) and pagination.

## Architecture

```
conf/default.json
  model_pricing: { "gpt-4o": { in, out }, ... }
       │
       ▼ (loaded at startup)
PricingService (new module, src/services/pricing.ts)
  ├── getPrice(model) → { input_price, output_price }
  ├── setPrice(model, in, out) → runtime override
  ├── getAllPrices() → merged (config + overrides)
  ├── getCost(model, tokens) → number
  └── resetPrices() → clears runtime overrides
       │
       ├── used by chat.ts logging (cost calculation)
       └── used by Admin API pricing endpoints
              │
              ▼
       Frontend request-logs table (cost display)
```

## Model Pricing Config

New section in `conf/default.json`:

```json
{
  "model_pricing": {
    "gpt-4o": { "input": 2.50, "output": 10.00 },
    "gpt-4o-mini": { "input": 0.15, "output": 0.60 },
    "claude-3-opus": { "input": 15.00, "output": 75.00 },
    "claude-3-sonnet": { "input": 3.00, "output": 15.00 },
    "claude-3-haiku": { "input": 0.25, "output": 1.25 },
    "deepseek-chat": { "input": 0.14, "output": 0.28 },
    "gemini-1.5-pro": { "input": 1.25, "output": 5.00 },
    "default": { "input": 1.00, "output": 2.00 }
  }
}
```

Prices are in USD per 1K tokens. Unknown models fall back to `default`, then to `0` if no default exists.

## PricingService

**File:** `src/services/pricing.ts`

- **`getPrice(model: string)`** — exact match → runtime override → config → `default` key → `{ input: 0, output: 0 }`
- **`setPrice(model: string, input: number, output: number)`** — stores in a runtime `Map<string, { input, output }>`, higher priority than config
- **`getAllPrices(): Record<string, { input, output }>`** — merges config + runtime overrides (overrides win)
- **`getCost(model: string, promptTokens: number, completionTokens: number): number`** — `(promptTokens * inputPrice + completionTokens * outputPrice) / 1000`
- **`resetPrices(): void`** — clears runtime overrides
- **`initialize(): void`** — loads config prices at startup (called from index.ts or app.ts)

Caching: no caching needed — O(1) Map lookups.

## Admin API Endpoints

Added to `adminRouter` in `src/routes/admin.ts`:

| Method | Path | Body | Response | Description |
|--------|------|------|----------|-------------|
| `GET` | `/v1/pricing` | — | `{ prices: Record<string, { input, output }> }` | All model prices (config + runtime) |
| `PUT` | `/v1/pricing/:model` | `{ input, output }` | `{ model, input, output }` | Set/update a model's price |
| `DELETE` | `/v1/pricing/:model` | — | `{ success: true }` | Remove runtime override, revert to config |

Validation: `input` and `output` must be non-negative numbers.

## Request Log Cost Calculation

In `src/routes/chat.ts`, where `logStore.add()` is called (both streaming and non-streaming paths), replace the existing cost calculation:

```typescript
// Before:
// calculateCost(model, tokens)  — needs verification

// After:
import { getPricingService } from '../services/pricing';
const pricing = getPricingService();
const cost = pricing.getCost(model, prompt_tokens, completion_tokens);
```

This ensures the cost stored in `IRequestLogDetail.cost` uses the new pricing system.

## Frontend: Enhanced "Recent Requests" Table

### Data Source Changes

1. **Historical load**: On mount and time-range change, fetch `GET /v1/request-logs?start=...&end=...&limit=50`
2. **Pagination**: Connect `total` from API response to Ant Design `Table` pagination
3. **WebSocket**: Prepend new `request_complete` events to the first page (cap at 50 visible)
4. **Debounce**: Avoid duplicate re-fetches when time range changes rapidly

### Column Definition

| Column Header | Data Field | Format | Notes |
|---------------|-----------|--------|-------|
| 时间 | `timestamp` | `YYYY-MM-DD HH:mm:ss` | local time |
| 供应商 | `provider` | string | raw provider name |
| 计费模型 | `model` | string | model name |
| 输入 | `prompt_tokens` | `toLocaleString()` | input tokens |
| 输出 | `completion_tokens` | `toLocaleString()` | output tokens |
| 成本 | `cost` | `$0.0000` | 4 decimal places |
| 用时 | `duration_ms` | `{v}ms` | total duration |
| 状态 | `status_code` | Tag (green 2xx/red others) | status tag |
| 来源 | `tenant_id` | string | tenant name |

### Frontend API Layer

Add to `ai-gateway-admin/src/services/api.ts`:

```typescript
export function getRequestLogs(params: {
  start?: number;
  end?: number;
  tenant_id?: string;
  model?: string;
  status_code?: number;
  limit?: number;
  offset?: number;
}): Promise<{ logs: RequestLogItem[]; total: number }>
```

### Frontend Types

Add to `ai-gateway-admin/src/types/index.ts`:

```typescript
interface RequestLogItem {
  request_id: string;
  timestamp: number;
  provider?: string;
  model?: string;
  status_code: number;
  duration_ms: number;
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  cost?: number;
  tenant_id?: string;
  error?: string;
}
```

### Time Range Linking

The existing time range selector (1h/6h/24h/7d/30d) already triggers all chart refetches. The request-logs table should also respond to this:

- `start = now - timeRange`
- `end = now`
- Pass as query params to `GET /v1/request-logs`

### Empty/Loading/Error States

| State | Behavior |
|-------|----------|
| Loading | Table shows Ant Design `Table` loading skeleton |
| Empty (no logs) | `Empty` component: "暂无请求日志" |
| Error | `message.error` toast + inline error row |
| WebSocket-off | Badge shows "disconnected" but REST data still loads |

### Test Plan

- PricingService unit tests: exact match, default fallback, runtime override, getCost accuracy
- Admin pricing API tests: CRUD, validation, persistence
- Dashboard table tests: historical load, pagination, empty state, error state, real-time append

## Files Changed

### Backend
- `conf/default.json` — add `model_pricing` section
- `src/services/pricing.ts` — new file, PricingService
- `src/services/index.ts` — export getPricingService
- `src/routes/admin.ts` — add pricing CRUD endpoints, update request-logs if needed
- `src/routes/chat.ts` — use PricingService for cost calculation
- `src/types/index.ts` — add pricing types if needed
- `tests/services/pricing.test.ts` — new test file
- `tests/routes/admin-pricing.test.ts` — new test file

### Frontend
- `ai-gateway-admin/src/types/index.ts` — add `RequestLogItem`
- `ai-gateway-admin/src/services/api.ts` — add `getRequestLogs()`, add pricing API calls
- `ai-gateway-admin/src/pages/Dashboard/index.tsx` — enhanced table with all columns, pagination, historical loading
- `ai-gateway-admin/src/pages/Dashboard/index.test.tsx` — update tests