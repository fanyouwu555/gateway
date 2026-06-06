# Model Pricing & Enhanced Request Logs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a centralized PricingService with config + runtime override, Admin API endpoints, and enhance the dashboard's "Recent Requests" table with full columns and pagination.

**Architecture:** Extract existing pricing logic from `metrics.ts` into a standalone `PricingService`, add Admin API CRUD endpoints for runtime overrides, connect frontend to `GET /v1/request-logs` for historical data, and replace the 5-column WebSocket-only table with a 9-column paginated table.

**Tech Stack:** TypeScript/Hono (backend), React/Ant Design (frontend), Jest (tests)

---

### Task 1: Extract PricingService from metrics.ts

**Files:**
- Create: `src/services/pricing.ts`
- Modify: `src/services/metrics.ts:149-228`
- Create: `tests/services/pricing.test.ts`

- [ ] **Step 1: Write PricingService with tests-first approach**

Create `src/services/pricing.ts`:

```typescript
/**
 * 价格计算服务
 * 管理模型定价，支持配置加载和运行时覆盖
 */
export interface ModelPrice {
  input: number;   // 每 1M tokens 输入价格（美元）
  output: number;  // 每 1M tokens 输出价格（美元）
}

export type PricingMap = Record<string, ModelPrice>;

// 模型未配置定价时的默认价格
const DEFAULT_INPUT_PRICE = 30;
const DEFAULT_OUTPUT_PRICE = 60;

class PricingService {
  private configPrices: PricingMap = {};
  private overrides: PricingMap = {};

  /**
   * 从配置初始化定价
   */
  initialize(pricing?: PricingMap): void {
    this.configPrices = pricing || {};
    this.overrides = {};
  }

  /**
   * 获取某个模型的价格（overrides > config > default）
   */
  getPrice(model: string): ModelPrice {
    const override = this.overrides[model];
    if (override) return override;

    const config = this.configPrices[model];
    if (config) return config;

    const defaultPrice = this.configPrices['__default__'];
    if (defaultPrice) return defaultPrice;

    return { input: DEFAULT_INPUT_PRICE, output: DEFAULT_OUTPUT_PRICE };
  }

  /**
   * 运行时覆盖某个模型的价格
   */
  setPrice(model: string, input: number, output: number): void {
    this.overrides[model] = { input, output };
  }

  /**
   * 删除运行时覆盖，回退到配置值
   */
  deletePrice(model: string): boolean {
    if (this.overrides[model]) {
      delete this.overrides[model];
      return true;
    }
    return false;
  }

  /**
   * 获取所有价格（配置 + overrides，overrides 优先）
   */
  getAllPrices(): PricingMap {
    const merged = { ...this.configPrices, ...this.overrides };
    // 移除非模型条目如 __default__
    const result: PricingMap = {};
    for (const [key, val] of Object.entries(merged)) {
      if (key !== '__default__') {
        result[key] = val;
      }
    }
    return result;
  }

  /**
   * 获取运行时 overrides
   */
  getOverrides(): PricingMap {
    return { ...this.overrides };
  }

  /**
   * 计算请求费用
   */
  calculateCost(model: string, promptTokens: number, completionTokens: number): number {
    const { input, output } = this.getPrice(model);
    return (promptTokens * input + completionTokens * output) / 1_000_000;
  }

  /**
   * 重置所有运行时覆盖
   */
  resetOverrides(): void {
    this.overrides = {};
  }
}

const pricingService = new PricingService();

export function getPricingService(): PricingService {
  return pricingService;
}

export { PricingService };
```

- [ ] **Step 2: Write the test file for PricingService**

Create `tests/services/pricing.test.ts`:

```typescript
import { PricingService, getPricingService } from '../../src/services/pricing';

describe('PricingService', () => {
  let service: PricingService;

  beforeEach(() => {
    service = new PricingService();
  });

  describe('getPrice', () => {
    it('should return config price when model exists in config', () => {
      service.initialize({
        'gpt-4o': { input: 2.5, output: 10 },
      });
      const price = service.getPrice('gpt-4o');
      expect(price.input).toBe(2.5);
      expect(price.output).toBe(10);
    });

    it('should return override price when set', () => {
      service.initialize({ 'gpt-4o': { input: 2.5, output: 10 } });
      service.setPrice('gpt-4o', 3.0, 15);
      const price = service.getPrice('gpt-4o');
      expect(price.input).toBe(3.0);
      expect(price.output).toBe(15);
    });

    it('should fall back to __default__ when model not found', () => {
      service.initialize({ '__default__': { input: 1.0, output: 2.0 } });
      const price = service.getPrice('unknown-model');
      expect(price.input).toBe(1.0);
      expect(price.output).toBe(2.0);
    });

    it('should fall back to hardcoded defaults when no config', () => {
      service.initialize({});
      const price = service.getPrice('unknown-model');
      expect(price.input).toBe(30);
      expect(price.output).toBe(60);
    });
  });

  describe('calculateCost', () => {
    it('should calculate cost correctly for known model', () => {
      service.initialize({ 'gpt-4o': { input: 2.5, output: 10 } });
      // 1000 prompt + 500 completion tokens = (1000*2.5 + 500*10) / 1_000_000 = 0.0075
      const cost = service.calculateCost('gpt-4o', 1000, 500);
      expect(cost).toBe(0.0075);
    });
  });

  describe('deletePrice / resetOverrides', () => {
    it('should delete a specific override', () => {
      service.initialize({ 'gpt-4o': { input: 2.5, output: 10 } });
      service.setPrice('gpt-4o', 5, 20);
      expect(service.getPrice('gpt-4o').input).toBe(5);
      service.deletePrice('gpt-4o');
      expect(service.getPrice('gpt-4o').input).toBe(2.5);
    });

    it('should reset all overrides', () => {
      service.initialize({ 'gpt-4o': { input: 2.5, output: 10 } });
      service.setPrice('gpt-4o', 5, 20);
      service.setPrice('claude-3', 10, 50);
      service.resetOverrides();
      expect(service.getPrice('gpt-4o').input).toBe(2.5);
    });
  });

  describe('getAllPrices', () => {
    it('should merge config and overrides', () => {
      service.initialize({
        'gpt-4o': { input: 2.5, output: 10 },
        'claude-3': { input: 10, output: 50 },
      });
      service.setPrice('gpt-4o', 3, 12);
      const all = service.getAllPrices();
      expect(all['gpt-4o']).toEqual({ input: 3, output: 12 });
      expect(all['claude-3']).toEqual({ input: 10, output: 50 });
    });

    it('should not include __default__ in getAllPrices', () => {
      service.initialize({ '__default__': { input: 1, output: 2 } });
      const all = service.getAllPrices();
      expect(all['__default__']).toBeUndefined();
    });
  });
});

describe('getPricingService (singleton)', () => {
  it('should return the same instance', () => {
    const a = getPricingService();
    const b = getPricingService();
    expect(a).toBe(b);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails (no pricing.ts yet)**

Run: `npx jest tests/services/pricing.test.ts --no-coverage`
Expected: FAIL - "Cannot find module"

- [ ] **Step 4: Update metrics.ts to use PricingService**

Modify `src/services/metrics.ts`:

Replace the pricing-related code (lines 153-197) with a reference to PricingService:

Change the `_pricing`, `initPricing`, `getPricing`, `DEFAULT_INPUT_PRICE`, `DEFAULT_OUTPUT_PRICE` and `calculateCost` functions to delegate to PricingService:

```typescript
import { getPricingService } from './pricing';
// Remove: let _pricing: Record<string, ...> = {};
// Remove: export function initPricing...
// Remove: export function getPricing...
// Remove: DEFAULT_INPUT_PRICE, DEFAULT_OUTPUT_PRICE
// Remove: export function calculateCost...
```

Then update `recordMetric` (line 227):

```typescript
// Before (line 227):
const cost = calculateCost(model, tokens);
if (cost !== undefined) {

// After:
const cost = getPricingService().calculateCost(model, tokens.prompt_tokens, tokens.completion_tokens);
```

Also remove the `initPricing` dependency from `resetMetricsStore` (line 151):
```typescript
// Before:
export function resetMetricsStore(): void {
  metricsStore = new MetricsStore();
  _pricing = {};
}

// After:
export function resetMetricsStore(): void {
  metricsStore = new MetricsStore();
}
```

- [ ] **Step 5: Initialize PricingService in config startup**

Modify `src/config/index.ts`: After `initConfig()` runs, load pricing from config and initialize PricingService.

Add import at the top:
```typescript
import { getPricingService } from '../services/pricing';
```

Add at the end of `initConfig` function (before the `return config;` on line 333):
```typescript
// Initialize pricing service from config
getPricingService().initialize(config.pricing);
```

Add at the end of `reloadConfig` function (before the `return _config;` on line 415):
```typescript
getPricingService().initialize(_config.pricing);
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx jest tests/services/pricing.test.ts --no-coverage`
Expected: PASS (all tests green)

- [ ] **Step 7: Commit**

```bash
git add src/services/pricing.ts src/services/metrics.ts src/config/index.ts tests/services/pricing.test.ts
git commit -m "feat: extract PricingService from metrics with config + runtime override support"
```

---

### Task 2: Update chat.ts to use PricingService cost calculation

**Files:**
- Modify: `src/routes/chat.ts:454,598-600,637-641`

- [ ] **Step 1: Update streaming path cost calculation**

In `src/routes/chat.ts`, find the streaming path around line 454. Currently `cost` is already set from an earlier variable. Check the scope and ensure the `cost` variable used on line 454 (`cost,`) uses the PricingService.

Search for where `cost` is set in the streaming path. If it uses `calculateCost`, replace it with PricingService:

```typescript
// Before (wherever cost is calculated in streaming path):
const cost = calculateCost(model, { ... });

// After:
const cost = getPricingService().calculateCost(model, promptTokens, completionTokens);
```

Also ensure `getPricingService` is imported (add with other imports at top):
```typescript
import { getPricingService } from '../services/pricing';
```

- [ ] **Step 2: Update non-streaming path cost calculation** (lines 598-600)

```typescript
// Before:
const cost = response.usage ? (calculateCost(model, {
  prompt_tokens: response.usage.prompt_tokens || 0,
  completion_tokens: response.usage.completion_tokens || 0,
  total_tokens: response.usage.total_tokens || 0,
}) || 0) : 0;

// After:
const cost = response.usage ? getPricingService().calculateCost(
  model,
  response.usage.prompt_tokens || 0,
  response.usage.completion_tokens || 0,
) : 0;
```

- [ ] **Step 3: Update X-Gateway-Cost header** (lines 637-641)

```typescript
// Before:
const totalCost = response.usage ? calculateCost(model, {
  prompt_tokens: response.usage.prompt_tokens || 0,
  completion_tokens: response.usage.completion_tokens || 0,
  total_tokens: response.usage.total_tokens || 0,
}) || 0 : 0;

// After:
const totalCost = response.usage ? getPricingService().calculateCost(
  model,
  response.usage.prompt_tokens || 0,
  response.usage.completion_tokens || 0,
) : 0;
```

- [ ] **Step 4: Run existing tests to verify no regressions**

Run: `npx jest --no-coverage`
Expected: All tests pass (the metrics tests that tested `calculateCost` directly may need updates)

- [ ] **Step 5: Commit**

```bash
git add src/routes/chat.ts
git commit -m "refactor: use PricingService.calculateCost in chat routes"
```

---

### Task 3: Add Admin API pricing endpoints

**Files:**
- Modify: `src/routes/admin.ts`
- Create: `tests/routes/admin-pricing.test.ts`

- [ ] **Step 1: Add pricing CRUD routes to admin.ts**

Before the `// === 请求日志 ===` section (around line 731), add:

```typescript
// === 模型定价 ===
adminRouter.get('/v1/pricing', (c: Context) => {
  const prices = getPricingService().getAllPrices();
  const overrides = getPricingService().getOverrides();
  return c.json({ prices, overrides });
});

adminRouter.put('/v1/pricing/:model', async (c: Context) => {
  const model = c.req.param('model');
  let body: { input?: number; output?: number };
  try {
    body = await c.req.json();
  } catch {
    return c.json({
      error: { message: 'Invalid JSON body', type: 'invalid_request_error', code: 'parse_error' },
    }, 400);
  }
  const input = body.input;
  const output = body.output;
  if (typeof input !== 'number' || input < 0 || typeof output !== 'number' || output < 0) {
    return c.json({
      error: { message: 'input and output must be non-negative numbers', type: 'invalid_request_error', code: 'validation_error' },
    }, 400);
  }
  getPricingService().setPrice(model, input, output);
  return c.json({ model, input, output });
});

adminRouter.delete('/v1/pricing/:model', (c: Context) => {
  const model = c.req.param('model');
  const deleted = getPricingService().deletePrice(model);
  if (!deleted) {
    return c.json({
      error: { message: `No runtime override found for model: ${model}`, type: 'invalid_request_error', code: 'not_found' },
    }, 404);
  }
  return c.json({ success: true, model });
});
```

Add import at the top of admin.ts (with existing imports):
```typescript
import { getPricingService } from '../services/pricing';
```

- [ ] **Step 2: Write pricing API tests**

Create `tests/routes/admin-pricing.test.ts`:

```typescript
import { Hono } from 'hono';
import type { Context } from 'hono';
import { getPricingService } from '../../src/services/pricing';

// Build a minimal admin router for testing
import adminRouter from '../../src/routes/admin';

describe('Admin Pricing API', () => {
  beforeEach(() => {
    getPricingService().initialize({
      'gpt-4o': { input: 2.5, output: 10 },
      'claude-3': { input: 15, output: 75 },
    });
  });

  afterEach(() => {
    getPricingService().resetOverrides();
  });

  it('GET /v1/pricing returns all prices and overrides', async () => {
    const res = await adminRouter.request('/v1/pricing');
    expect(res.status).toBe(200);
    const body = await res.json() as { prices: Record<string, unknown>; overrides: Record<string, unknown> };
    expect(body.prices['gpt-4o']).toEqual({ input: 2.5, output: 10 });
    expect(body.overrides).toEqual({});
  });

  it('PUT /v1/pricing/:model sets a runtime override', async () => {
    const res = await adminRouter.request('/v1/pricing/gpt-4o', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: 3, output: 12 }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { model: string; input: number; output: number };
    expect(body.model).toBe('gpt-4o');
    expect(body.input).toBe(3);
    expect(body.output).toBe(12);
    expect(getPricingService().getPrice('gpt-4o')).toEqual({ input: 3, output: 12 });
  });

  it('PUT /v1/pricing/:model rejects negative values', async () => {
    const res = await adminRouter.request('/v1/pricing/gpt-4o', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: -1, output: 10 }),
    });
    expect(res.status).toBe(400);
  });

  it('DELETE /v1/pricing/:model removes a runtime override', async () => {
    getPricingService().setPrice('gpt-4o', 3, 12);
    const res = await adminRouter.request('/v1/pricing/gpt-4o', { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(getPricingService().getPrice('gpt-4o')).toEqual({ input: 2.5, output: 10 });
  });

  it('DELETE /v1/pricing/:model returns 404 for non-override', async () => {
    const res = await adminRouter.request('/v1/pricing/nonexistent', { method: 'DELETE' });
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 3: Run the pricing API tests**

Run: `npx jest tests/routes/admin-pricing.test.ts --no-coverage`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/routes/admin.ts tests/routes/admin-pricing.test.ts
git commit -m "feat: add Admin API pricing CRUD endpoints (GET/PUT/DELETE /v1/pricing)"
```

---

### Task 4: Update conf/default.json with model pricing and enable request_logging

**Files:**
- Modify: `conf/default.json`

- [ ] **Step 1: Add comprehensive model pricing to config**

Modify the `pricing` section of `conf/default.json` (replace lines 97-99):

```json
  "pricing": {
    "ark-code-latest": { "input": 0.5, "output": 2.0 },
    "kimi-for-coding": { "input": 0.5, "output": 2.0 },
    "kimi-k2.6": { "input": 0.5, "output": 2.0 },
    "gpt-4o": { "input": 2.5, "output": 10.0 },
    "gpt-4o-mini": { "input": 0.15, "output": 0.6 },
    "claude-3-opus": { "input": 15.0, "output": 75.0 },
    "claude-3-sonnet": { "input": 3.0, "output": 15.0 },
    "claude-3-haiku": { "input": 0.25, "output": 1.25 },
    "deepseek-chat": { "input": 0.14, "output": 0.28 }
  },
```

- [ ] **Step 2: Enable request_logging by default**

Change lines 78-82:

```json
  "request_logging": {
    "enabled": true,
    "max_body_size": 4096,
    "sample_rate": 1.0
  },
```

- [ ] **Step 3: Commit**

```bash
git add conf/default.json
git commit -m "feat: add model pricing config and enable request logging by default"
```

---

### Task 5: Add RequestLogItem type to frontend

**Files:**
- Modify: `ai-gateway-admin/src/types/index.ts`

- [ ] **Step 1: Add RequestLogItem interface**

Add after the `StatusCodeStats` interface (at end of file):

```typescript
// ============ 请求日志 ============
export interface RequestLogItem {
  request_id: string
  tenant_id?: string
  timestamp: number
  method: string
  path: string
  provider?: string
  model?: string
  status_code: number
  duration_ms: number
  prompt_tokens?: number
  completion_tokens?: number
  total_tokens?: number
  cost?: number
  error?: string
}
```

- [ ] **Step 2: Commit**

```bash
git add ai-gateway-admin/src/types/index.ts
git commit -m "feat: add RequestLogItem type for frontend request logs"
```

---

### Task 6: Add getRequestLogs API to frontend service layer

**Files:**
- Modify: `ai-gateway-admin/src/services/api.ts`

- [ ] **Step 1: Add getRequestLogs function**

Add after the existing usage API functions (after `getStatusCodeStats`, around line 310):

```typescript
// ============ 请求日志 ============
export async function getRequestLogs(params?: {
  start?: number
  end?: number
  tenant_id?: string
  model?: string
  status_code?: number
  limit?: number
  offset?: number
}) {
  const searchParams = new URLSearchParams()
  if (params) {
    if (params.start) searchParams.append('start', params.start.toString())
    if (params.end) searchParams.append('end', params.end.toString())
    if (params.tenant_id) searchParams.append('tenant_id', params.tenant_id)
    if (params.model) searchParams.append('model', params.model)
    if (params.status_code !== undefined) searchParams.append('status_code', params.status_code.toString())
    if (params.limit) searchParams.append('limit', params.limit.toString())
    if (params.offset) searchParams.append('offset', params.offset.toString())
  }
  return api.get(`/v1/request-logs?${searchParams}`)
}
```

- [ ] **Step 2: Commit**

```bash
git add ai-gateway-admin/src/services/api.ts
git commit -m "feat: add getRequestLogs API to frontend service layer"
```

---

### Task 7: Enhance Dashboard "Recent Requests" table

**Files:**
- Modify: `ai-gateway-admin/src/pages/Dashboard/index.tsx`

- [ ] **Step 1: Update imports and types**

Update the import block at the top of the file:

```typescript
import { getHealth, getCacheStats, getDashboardOverview, getTimeSeriesMetrics, getProviderStats, getStatusCodeStats, getRequestLogs } from '@/services/api'
import type { DashboardOverview, TimeSeriesPoint, ProviderStats, RequestLogItem } from '@/types'
```

Replace the `RecentLog` interface with:

```typescript
interface EnhancedLog extends RequestLogItem {
  _key: string  // unique key for table row
}
```

- [ ] **Step 2: Replace state variables and fetch logic**

Replace the existing `recentLogs` state and `seenRequestIds` ref:

```typescript
const [recentLogs, setRecentLogs] = useState<EnhancedLog[]>([])
const [logTotal, setLogTotal] = useState(0)
const [logPage, setLogPage] = useState(1)
const [logLoading, setLogLoading] = useState(false)
const seenRequestIds = useRef(new Set<string>())
```

Add a `fetchRequestLogs` function and call it in the existing `fetchData`:

Inside `fetchData`, after the try/catch, add before `finally`:

```typescript
// Fetch recent request logs with time range
try {
  setLogLoading(true)
  const logResult = await getRequestLogs({
    start,
    end: now,
    limit: 15,
    offset: 0,
  }) as unknown as { logs: RequestLogItem[]; total: number }
  setRecentLogs(logResult.logs.map((log) => ({ ...log, _key: log.request_id })))
  setLogTotal(logResult.total)
  setLogPage(1)
} catch {
  // logs load failure is non-critical
} finally {
  setLogLoading(false)
}
```

- [ ] **Step 3: Replace the columns definition**

Replace the existing `columns` array:

```typescript
const formatTime = (ts: number) => {
  const d = new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`
}

const columns = [
  { title: '时间', dataIndex: 'timestamp', key: 'timestamp', width: 160, render: (v: number) => formatTime(v) },
  { title: '供应商', dataIndex: 'provider', key: 'provider', width: 120 },
  { title: '计费模型', dataIndex: 'model', key: 'model', width: 160 },
  {
    title: '输入', dataIndex: 'prompt_tokens', key: 'prompt_tokens', width: 80,
    render: (v: number | undefined) => v?.toLocaleString() || '-',
  },
  {
    title: '输出', dataIndex: 'completion_tokens', key: 'completion_tokens', width: 80,
    render: (v: number | undefined) => v?.toLocaleString() || '-',
  },
  {
    title: '成本', dataIndex: 'cost', key: 'cost', width: 100,
    render: (v: number | undefined) => v !== undefined ? `$${v.toFixed(4)}` : '-',
  },
  {
    title: '用时', dataIndex: 'duration_ms', key: 'duration_ms', width: 100,
    render: (v: number) => `${v}ms`,
  },
  {
    title: '状态', dataIndex: 'status_code', key: 'status_code', width: 80,
    render: (v: number) => (
      <Tag color={v >= 200 && v < 300 ? 'green' : 'red'}>{v}</Tag>
    ),
  },
  {
    title: '来源', dataIndex: 'tenant_id', key: 'tenant_id', width: 120,
    render: (v: string | undefined) => v || '-',
  },
]
```

- [ ] **Step 4: Replace WebSocket message handler log creation**

Update the WebSocket handler's log creation (in `handleWebSocketMessage`):

```typescript
if (requestId) {
  if (seenRequestIds.current.has(requestId)) return
  seenRequestIds.current.add(requestId)
}
const log: EnhancedLog = {
  _key: requestId || Math.random().toString(36).substr(2, 9),
  request_id: requestId || '',
  timestamp: Date.now(),
  method: 'POST',
  path: '/v1/chat/completions',
  provider: (data.provider as string) || '',
  model: (data.model as string) || 'unknown',
  status_code: data.error ? 500 : 200,
  duration_ms: (data.duration_ms as number) || 0,
  prompt_tokens: (data.prompt_tokens as number) || 0,
  completion_tokens: (data.completion_tokens as number) || 0,
  total_tokens: (data.total_tokens as number) || 0,
  cost: (data.cost as number) || 0,
  tenant_id: (data.tenant_id as string) || '',
}
setRecentLogs((prev) => [log, ...prev.slice(0, 14)])
```

- [ ] **Step 5: Replace the table in the JSX**

Replace the `<Card title="最近请求">` block:

```typescript
<Card title="最近请求" style={{ marginTop: 16 }}>
  <Table
    columns={columns}
    dataSource={recentLogs}
    rowKey="_key"
    size="small"
    loading={logLoading}
    pagination={{
      current: logPage,
      pageSize: 15,
      total: logTotal,
      showSizeChanger: false,
      onChange: async (page) => {
        setLogPage(page)
        setLogLoading(true)
        const now = Date.now()
        const start = now - timeRange * 60 * 60 * 1000
        try {
          const result = await getRequestLogs({
            start,
            end: now,
            limit: 15,
            offset: (page - 1) * 15,
          }) as unknown as { logs: RequestLogItem[]; total: number }
          setRecentLogs(result.logs.map((log) => ({ ...log, _key: log.request_id })))
          setLogTotal(result.total)
        } catch {
          message.error('加载请求日志失败')
        } finally {
          setLogLoading(false)
        }
      },
    }}
    scroll={{ x: 1000 }}
  />
</Card>
```

- [ ] **Step 6: Run frontend build to verify no errors**

Run: `cd ai-gateway-admin && npx tsc --noEmit`
Expected: No TypeScript errors

- [ ] **Step 7: Commit**

```bash
git add ai-gateway-admin/src/pages/Dashboard/index.tsx
git commit -m "feat: enhance dashboard recent requests table with full columns, pagination, and historical loading"
```

---

### Task 8: Run full test suite and verify

**Files:**
- No file changes

- [ ] **Step 1: Run backend tests**

Run from project root: `npx jest --no-coverage`
Expected: All tests pass (including new pricing tests and existing metrics/cost tests)

- [ ] **Step 2: Run frontend tests**

Run: `cd ai-gateway-admin && npx vitest run --reporter=verbose`
Expected: All tests pass

- [ ] **Step 3: Run lint**

Run: `npm run lint`
Expected: No lint errors

- [ ] **Step 4: Run TypeScript check**

Run: `npx tsc --noEmit`
Expected: No type errors

- [ ] **Step 5: Commit any remaining fixes**

```bash
git add -A
git commit -m "chore: fix tests and lint after pricing service refactor"
```

---

## Task Dependency Graph

```
Task 1 (PricingService) ──► Task 3 (Admin API pricing)
                        ──► Task 2 (chat.ts update)
                        ──► Task 4 (config update)
                                │
Task 5 (Frontend types) ──► Task 6 (Frontend API) ──► Task 7 (Dashboard table)
                                                           │
Task 4 (config, enables logging) ──────────────────────────┘

Task 8 (Full test suite) - final verification
```

Tasks 1-4 are backend and can be done sequentially. Tasks 5-7 are frontend and depend on Task 4 (request_logging enabled). Task 8 is final verification.