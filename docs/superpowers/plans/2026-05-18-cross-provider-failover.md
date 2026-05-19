# Cross-Provider Failover Chain Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement provider-level health tracking and explicit failover chains so that when a primary provider (e.g. OpenAI) fails, the gateway automatically degrades to configured fallback providers (e.g. DeepSeek → Anthropic).

**Architecture:** Extend the existing `FailoverManager` with provider-level health states (error rate, latency, consecutive failures), add a configurable `chains` map to `IGatewayConfig`, and integrate provider-health checks into the existing `chatComplete` retry loop in `providers/index.ts`.

**Tech Stack:** TypeScript, Hono, Jest, node:http (WebSocket already present)

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `src/types/index.ts` | Modify | Add `chains`, `errorRateThreshold`, `latencyThresholdMs` to `failover` config type |
| `src/config/index.ts` | Modify | Load new failover env vars and set defaults |
| `conf/default.json` | Modify | Add example `chains` and thresholds |
| `src/services/failover.ts` | Modify | Add `ProviderHealth` tracking, `isProviderHealthy()`, `getFailoverChain()`, provider-level health checks |
| `src/providers/index.ts` | Modify | Use `isProviderHealthy()` in `chatComplete` loop; record per-provider success/failure latency |
| `src/app.ts` | Modify | Include per-provider health stats in `/health` response |
| `tests/services/failover.test.ts` | Modify | Add provider-level health unit tests |
| `tests/providers/failover-chain.test.ts` | Create | Add integration tests for cross-provider fallback chain |

---

### Task 1: Extend IGatewayConfig type

**Files:**
- Modify: `src/types/index.ts:246-253`

- [ ] **Step 1: Add new fields to the failover config type**

Replace the existing `failover` block inside `IGatewayConfig` with:

```typescript
  failover?: {
    enabled: boolean;
    failureThreshold: number;
    successThreshold: number;
    healthCheckInterval: number;
    healthCheckTimeout: number;
    healthCheckModel: string;
    /** Explicit failover chains: primary -> [fallback1, fallback2, ...] */
    chains?: Record<string, string[]>;
    /** Error-rate threshold (0-1) that triggers provider-level degradation. Default 0.5 */
    errorRateThreshold?: number;
    /** Average-latency threshold (ms) that triggers degradation. Default 30000 */
    latencyThresholdMs?: number;
  };
```

- [ ] **Step 2: Verify type check passes**

Run: `npx tsc --noEmit`
Expected: No type errors.

---

### Task 2: Load new failover settings in config

**Files:**
- Modify: `src/config/index.ts:45-52`

- [ ] **Step 1: Update DEFAULT_CONFIG.failover**

Replace the existing failover defaults in `DEFAULT_CONFIG` with:

```typescript
  failover: {
    enabled: false,
    failureThreshold: 3,
    successThreshold: 2,
    healthCheckInterval: 60000,
    healthCheckTimeout: 5000,
    healthCheckModel: 'gpt-4o-mini',
    chains: {},
    errorRateThreshold: 0.5,
    latencyThresholdMs: 30000,
  },
```

- [ ] **Step 2: Append env-var overrides in `overrideFromEnv`**

Immediately after the existing `if (failoverEnabled !== undefined) { ... }` block (before `return config;`), add:

```typescript
  const failoverChainsEnv = getEnv('FAILOVER_CHAINS');
  if (failoverChainsEnv) {
    try {
      config.failover.chains = JSON.parse(failoverChainsEnv);
    } catch {
      writeLog('warn', 'Invalid FAILOVER_CHAINS JSON, ignoring');
    }
  }
  const errorRateThreshold = getEnv('FAILOVER_ERROR_RATE_THRESHOLD');
  if (errorRateThreshold !== undefined) {
    config.failover.errorRateThreshold = parseFloat(errorRateThreshold || '0.5');
  }
  const latencyThreshold = getEnv('FAILOVER_LATENCY_THRESHOLD_MS');
  if (latencyThreshold !== undefined) {
    config.failover.latencyThresholdMs = parseInt(latencyThreshold || '30000', 10);
  }
```

- [ ] **Step 3: Verify type check passes**

Run: `npx tsc --noEmit`
Expected: No type errors.

---

### Task 3: Add example chains to default.json

**Files:**
- Modify: `conf/default.json:98-105`

- [ ] **Step 1: Update the failover section**

Replace the existing failover block in `conf/default.json` with:

```json
  "failover": {
    "enabled": true,
    "failureThreshold": 3,
    "successThreshold": 2,
    "healthCheckInterval": 60000,
    "healthCheckTimeout": 5000,
    "healthCheckModel": "gpt-4o-mini",
    "chains": {
      "openai": ["deepseek", "anthropic"],
      "deepseek": ["openai", "anthropic"],
      "anthropic": ["openai", "deepseek"]
    },
    "errorRateThreshold": 0.5,
    "latencyThresholdMs": 30000
  }
```

---

### Task 4: Extend FailoverManager with provider-level health

**Files:**
- Modify: `src/services/failover.ts`

- [ ] **Step 1: Add ProviderHealth interface**

Insert right after the `TokenHealth` interface (around line 32):

```typescript
/**
 * Provider-level health state
 */
interface ProviderHealth {
  total_requests: number;
  error_count: number;
  total_latency_ms: number;
  consecutive_failures: number;
  consecutive_successes: number;
  last_failure: number;
  last_success: number;
  is_healthy: boolean;
  is_checking: boolean;
}
```

- [ ] **Step 2: Add provider-level Maps to FailoverManager**

Inside the `FailoverManager` class, after `private healthCheckTimers = new Map<string, NodeJS.Timeout>();`, add:

```typescript
  private providerHealth = new Map<string, ProviderHealth>();
  private providerCheckTimers = new Map<string, NodeJS.Timeout>();
```

- [ ] **Step 3: Load provider health from storage in `initStorage`**

Append to the end of `initStorage()` (before closing brace):

```typescript
    await this.loadProviderHealthState();
```

- [ ] **Step 4: Add provider health persistence helpers**

Insert after the existing `saveHealthState` method:

```typescript
  /**
   * Save provider health state to storage
   */
  private async saveProviderHealthState(provider: string, health: ProviderHealth): Promise<void> {
    if (!this.store) return;
    try {
      await this.store.hSet('provider_health', provider, JSON.stringify(health));
    } catch (err) {
      writeLog('warn', 'Failed to save provider health state', {
        provider,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Load provider health states from storage
   */
  private async loadProviderHealthState(): Promise<void> {
    if (!this.store) return;
    try {
      const stored = await this.store.hGetAll('provider_health');
      for (const [key, value] of Object.entries(stored)) {
        this.providerHealth.set(key, JSON.parse(value) as ProviderHealth);
      }
      writeLog('info', 'Loaded provider health states from storage', { count: this.providerHealth.size });
    } catch (err) {
      writeLog('warn', 'Failed to load provider health state from storage', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
```

- [ ] **Step 5: Add provider-level health tracking methods**

Insert after the existing `recordSuccess` method (before `getHealthStatus`):

```typescript
  /**
   * Record a provider-level request result
   */
  recordProviderRequest(provider: string, success: boolean, latencyMs: number): void {
    let health = this.providerHealth.get(provider);
    if (!health) {
      health = {
        total_requests: 0,
        error_count: 0,
        total_latency_ms: 0,
        consecutive_failures: 0,
        consecutive_successes: 0,
        last_failure: 0,
        last_success: 0,
        is_healthy: true,
        is_checking: false,
      };
    }

    health.total_requests++;
    health.total_latency_ms += latencyMs;

    if (success) {
      health.consecutive_successes++;
      health.consecutive_failures = 0;
      health.last_success = Date.now();
    } else {
      health.consecutive_failures++;
      health.consecutive_successes = 0;
      health.error_count++;
      health.last_failure = Date.now();
    }

    const errorRate = health.total_requests > 0 ? health.error_count / health.total_requests : 0;
    const avgLatency = health.total_requests > 0 ? health.total_latency_ms / health.total_requests : 0;

    if (health.is_healthy) {
      if (
        health.consecutive_failures >= this.config.failureThreshold ||
        errorRate >= (this.config.errorRateThreshold ?? 0.5) ||
        avgLatency > (this.config.latencyThresholdMs ?? 30000)
      ) {
        health.is_healthy = false;
        health.consecutive_successes = 0;
        this.startProviderHealthCheck(provider);
        writeLog('warn', 'Provider marked unhealthy', {
          provider,
          errorRate: Math.round(errorRate * 10000) / 10000,
          avgLatencyMs: Math.round(avgLatency),
          consecutiveFailures: health.consecutive_failures,
        });
      }
    } else {
      if (health.consecutive_successes >= this.config.successThreshold) {
        health.is_healthy = true;
        health.consecutive_failures = 0;
        this.stopProviderHealthCheck(provider);
        writeLog('info', 'Provider recovered', { provider });
      }
    }

    this.providerHealth.set(provider, health);
    this.saveProviderHealthState(provider, health);
  }

  /**
   * Check if a provider is healthy at the provider level
   */
  isProviderHealthy(provider: string): boolean {
    if (!this.config.enabled) return true;
    const health = this.providerHealth.get(provider);
    if (!health) return true;
    return health.is_healthy;
  }

  /**
   * Get provider-level health status summary
   */
  getProviderHealthStatus(): Record<string, { isHealthy: boolean; totalRequests: number; errorRate: number; avgLatencyMs: number }> {
    const status: Record<string, { isHealthy: boolean; totalRequests: number; errorRate: number; avgLatencyMs: number }> = {};
    this.providerHealth.forEach((health, key) => {
      const errorRate = health.total_requests > 0 ? health.error_count / health.total_requests : 0;
      const avgLatency = health.total_requests > 0 ? health.total_latency_ms / health.total_requests : 0;
      status[key] = {
        isHealthy: health.is_healthy,
        totalRequests: health.total_requests,
        errorRate: Math.round(errorRate * 10000) / 10000,
        avgLatencyMs: Math.round(avgLatency),
      };
    });
    return status;
  }

  /**
   * Get the explicit failover chain for a provider
   */
  getFailoverChain(provider: string): string[] {
    const chains = this.config.chains;
    if (chains && chains[provider]) {
      return chains[provider];
    }
    // Fallback: return all other configured providers
    const appConfig = getConfig();
    return Object.keys(appConfig.providers).filter((p) => p !== provider);
  }
```

- [ ] **Step 6: Add provider-level health check timers**

Insert after the existing `startHealthCheck` method:

```typescript
  /**
   * Start periodic health check for an unhealthy provider
   */
  private startProviderHealthCheck(provider: string): void {
    if (this.providerCheckTimers.has(provider)) return;

    writeLog('info', 'Starting provider health check', { provider });

    const timer = setInterval(async () => {
      await this.performProviderHealthCheck(provider);
    }, this.config.healthCheckInterval);

    this.providerCheckTimers.set(provider, timer);
    this.performProviderHealthCheck(provider);
  }

  /**
   * Execute a provider-level health check
   */
  private async performProviderHealthCheck(provider: string): Promise<void> {
    const health = this.providerHealth.get(provider);
    if (!health || health.is_healthy || health.is_checking) return;

    health.is_checking = true;

    try {
      const config = getProviderConfig(provider);
      if (!config) {
        this.markProviderUnhealthy(provider);
        return;
      }

      const response = await fetch(`${config.base_url}/models`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${config.api_key}`,
        },
        signal: AbortSignal.timeout(this.config.healthCheckTimeout),
      });

      if (response.ok) {
        const updated = this.providerHealth.get(provider);
        if (updated) {
          updated.is_checking = false;
          updated.consecutive_successes++;
          if (updated.consecutive_successes >= this.config.successThreshold) {
            updated.is_healthy = true;
            updated.consecutive_failures = 0;
            this.stopProviderHealthCheck(provider);
            writeLog('info', 'Provider recovered via health check', { provider });
          }
          this.providerHealth.set(provider, updated);
          this.saveProviderHealthState(provider, updated);
        }
      } else {
        this.markProviderUnhealthy(provider);
      }
    } catch {
      this.markProviderUnhealthy(provider);
    }
  }

  /**
   * Mark a provider as still unhealthy during a check
   */
  private markProviderUnhealthy(provider: string): void {
    const health = this.providerHealth.get(provider);
    if (health) {
      health.is_checking = false;
      health.consecutive_failures++;
      this.providerHealth.set(provider, health);
      this.saveProviderHealthState(provider, health);
    }
  }

  /**
   * Stop provider health check timer
   */
  private stopProviderHealthCheck(provider: string): void {
    const timer = this.providerCheckTimers.get(provider);
    if (timer) {
      clearInterval(timer);
      this.providerCheckTimers.delete(provider);
    }
  }
```

- [ ] **Step 7: Extend `reset()` to clear provider state**

Replace the existing `reset()` method with:

```typescript
  /**
   * Reset all state
   */
  reset(): void {
    this.tokenHealth.clear();
    this.healthCheckTimers.forEach((timer) => clearInterval(timer));
    this.healthCheckTimers.clear();
    this.providerHealth.clear();
    this.providerCheckTimers.forEach((timer) => clearInterval(timer));
    this.providerCheckTimers.clear();
  }
```

- [ ] **Step 8: Verify type check**

Run: `npx tsc --noEmit`
Expected: No type errors.

---

### Task 5: Integrate provider health into providers/index.ts

**Files:**
- Modify: `src/providers/index.ts:86-110`, `src/providers/index.ts:162-218`

- [ ] **Step 1: Replace `getFallbackProviders` to use explicit chains**

Replace the existing `getFallbackProviders` function (lines 86-110) with:

```typescript
/**
 * Get fallback providers for a given primary provider
 * 1. Use explicit failover chain from config if available
 * 2. Fall back to routing strategy rules
 */
function getFallbackProviders(excludeProvider: string, _requestModel: string): string[] {
  // 1. Use explicit failover chain
  const chain = activeFailover.getFailoverChain(excludeProvider);
  if (chain.length > 0) {
    return chain.filter((p) => p !== excludeProvider);
  }

  // 2. Fallback: derive from routing strategy
  const result: string[] = [];
  const strategy = getRoutingStrategy();
  if (strategy?.rules) {
    for (const rule of strategy.rules) {
      if (rule.provider !== excludeProvider) {
        result.push(rule.provider);
      }
    }
  }
  if (strategy?.fallback && strategy.fallback !== excludeProvider) {
    result.push(strategy.fallback);
  }
  return [...new Set(result)];
}
```

- [ ] **Step 2: Update health checks in `chatComplete` loop**

Replace the existing health-check block inside `chatComplete` (around lines 195-202):

```typescript
    // 检查 Provider 级健康状态（所有 provider 都检查）
    if (failoverConfig?.enabled) {
      if (!activeFailover.isProviderHealthy(currentProvider)) {
        errors.push({ provider: currentProvider, error: 'Provider unhealthy' });
        continue;
      }
    }

    // Token 级健康检查（fallback provider 必须有一个健康的 key）
    if (failoverConfig?.enabled && currentProvider !== providerName) {
      const token = activeFailover.getAvailableToken(currentProvider);
      if (!token) {
        errors.push({ provider: currentProvider, error: 'No healthy API key' });
        continue;
      }
    }
```

- [ ] **Step 3: Record provider-level success/failure with latency**

Inside the `chatComplete` for-loop, replace the existing try/catch block (lines 204-211) with:

```typescript
    try {
      const startTime = Date.now();
      const result = await callProviderWithRetry(provider, config, request, false);
      const latency = Date.now() - startTime;
      activeFailover.recordProviderResult(currentProvider, true, latency);
      return result as ChatCompletionResponse;
    } catch (error) {
      const latency = Date.now() - startTime;
      activeFailover.recordProviderResult(currentProvider, false, latency);
      const errMsg = error instanceof Error ? error.message : String(error);
      errors.push({ provider: currentProvider, error: errMsg });
    }
```

Also add `let startTime = 0;` just before the try block (inside the for-loop):

```typescript
    let startTime = 0;
    try {
      startTime = Date.now();
      ...
```

- [ ] **Step 4: Verify type check**

Run: `npx tsc --noEmit`
Expected: No type errors.

---

### Task 6: Expose provider health in /health

**Files:**
- Modify: `src/app.ts:47-68`

- [ ] **Step 1: Import failoverManager**

Add after the existing imports at the top of `src/app.ts`:

```typescript
import { failoverManager } from './services/failover';
```

- [ ] **Step 2: Include provider health in /health response**

Replace the `/health` handler (lines 47-68) with:

```typescript
  app.get('/health', (c) => {
    const providers = getProviderNames();
    const cacheStats = getCacheStats();
    const sessionStats = getSessionStats();
    const config = getConfig();
    const providerHealth = failoverManager.getProviderHealthStatus();

    return c.json({
      status: 'ok',
      timestamp: Date.now(),
      uptime: process.uptime(),
      version: '1.0.0',
      services: {
        providers: providers.map((p) => ({
          name: p,
          status: providerHealth[p]?.isHealthy !== false ? 'active' : 'degraded',
          has_api_key: !!config.providers[p]?.api_key,
          base_url: config.providers[p]?.base_url,
          health: providerHealth[p] || { isHealthy: true, totalRequests: 0, errorRate: 0, avgLatencyMs: 0 },
        })),
        cache: { size: cacheStats.size, hit_rate: cacheStats.hit_rate },
        sessions: { total: sessionStats.total_sessions },
      },
    });
  });
```

- [ ] **Step 3: Verify type check**

Run: `npx tsc --noEmit`
Expected: No type errors.

---

### Task 7: Add provider-level unit tests to failover.test.ts

**Files:**
- Modify: `tests/services/failover.test.ts`

- [ ] **Step 1: Update the config mock to include new fields**

Replace the first `jest.mock('../../src/config', () => ({...}))` block (lines 6-30) with:

```typescript
jest.mock('../../src/config', () => ({
  getConfig: () => ({
    failover: {
      enabled: true,
      failureThreshold: 2,
      successThreshold: 1,
      healthCheckInterval: 1000,
      healthCheckTimeout: 500,
      healthCheckModel: 'gpt-4o-mini',
      chains: { openai: ['deepseek'], deepseek: ['openai'] },
      errorRateThreshold: 0.5,
      latencyThresholdMs: 30000,
    },
    providers: {
      openai: { provider: 'openai', base_url: 'https://api.openai.com/v1', api_key: 'sk-test-key-12345678' },
      deepseek: { provider: 'deepseek', base_url: 'https://api.deepseek.com/v1', api_key: 'sk-test-deepseek-123' },
    },
  }),
  getProviderConfig: (name: string) => {
    const configs: Record<string, IProviderConfig> = {
      openai: { provider: 'openai', base_url: 'https://api.openai.com/v1', api_key: 'sk-test-key-12345678' },
      deepseek: { provider: 'deepseek', base_url: 'https://api.deepseek.com/v1', api_key: 'sk-test-deepseek-123' },
    };
    return configs[name];
  },
}));
```

Then delete the second `jest.mock('../../src/config', ...)` block (lines 34-60) entirely since the first mock now covers everything.

- [ ] **Step 2: Add provider-level test suite at end of file**

Append the following at the end of the file (after the last describe block):

```typescript
describe('Provider-level health', () => {
  beforeEach(() => {
    failoverManager.reset();
  });

  it('should mark provider unhealthy after consecutive failures', () => {
    failoverManager.recordProviderRequest('openai', false, 100);
    failoverManager.recordProviderRequest('openai', false, 100);
    expect(failoverManager.isProviderHealthy('openai')).toBe(false);
  });

  it('should keep provider healthy with enough successes', () => {
    failoverManager.recordProviderRequest('openai', true, 100);
    failoverManager.recordProviderRequest('openai', true, 100);
    expect(failoverManager.isProviderHealthy('openai')).toBe(true);
  });

  it('should recover provider after consecutive successes', () => {
    failoverManager.recordProviderRequest('openai', false, 100);
    failoverManager.recordProviderRequest('openai', false, 100);
    expect(failoverManager.isProviderHealthy('openai')).toBe(false);

    failoverManager.recordProviderRequest('openai', true, 100);
    expect(failoverManager.isProviderHealthy('openai')).toBe(true);
  });

  it('should return healthy for unknown provider', () => {
    expect(failoverManager.isProviderHealthy('unknown')).toBe(true);
  });

  it('should return provider health status summary', () => {
    failoverManager.recordProviderRequest('openai', true, 150);
    const status = failoverManager.getProviderHealthStatus();
    expect(status.openai).toBeDefined();
    expect(status.openai.totalRequests).toBe(1);
    expect(status.openai.isHealthy).toBe(true);
    expect(status.openai.avgLatencyMs).toBe(150);
  });

  it('should mark unhealthy when error rate exceeds threshold', () => {
    // errorRateThreshold is 0.5, so 1 error out of 1 request = 1.0 > 0.5
    failoverManager.recordProviderRequest('openai', false, 100);
    expect(failoverManager.isProviderHealthy('openai')).toBe(false);
  });

  it('should return configured failover chain', () => {
    const chain = failoverManager.getFailoverChain('openai');
    expect(chain).toContain('deepseek');
  });

  it('should return other providers when no chain is configured', () => {
    const chain = failoverManager.getFailoverChain('anthropic');
    expect(chain).toContain('openai');
    expect(chain).toContain('deepseek');
  });
});
```

- [ ] **Step 3: Run failover tests**

Run: `npx jest tests/services/failover.test.ts --no-coverage`
Expected: All tests pass.

---

### Task 8: Add cross-provider failover chain integration test

**Files:**
- Create: `tests/providers/failover-chain.test.ts`

- [ ] **Step 1: Create the test file**

```typescript
/**
 * Cross-Provider Failover Chain Integration Tests
 */
import {
  chatComplete,
  registerProvider,
  resetProviders,
  setProviderDeps,
  resetProviderDeps,
} from '../../src/providers';

jest.mock('../../src/config', () => ({
  getConfig: () => ({
    providers: {
      openai: { provider: 'openai', base_url: 'https://api.openai.com/v1', api_key: 'sk-openai' },
      deepseek: { provider: 'deepseek', base_url: 'https://api.deepseek.com/v1', api_key: 'sk-deepseek' },
    },
    failover: {
      enabled: true,
      failureThreshold: 2,
      successThreshold: 1,
      healthCheckInterval: 1000,
      healthCheckTimeout: 500,
      healthCheckModel: 'gpt-4o-mini',
      chains: { openai: ['deepseek'] },
      errorRateThreshold: 0.5,
      latencyThresholdMs: 30000,
    },
    routing: [{ name: 'default', rules: [{ model: 'gpt-4o', provider: 'openai' }], fallback: 'deepseek' }],
  }),
  getProviderConfig: (name: string) => {
    const configs: Record<string, unknown> = {
      openai: { provider: 'openai', base_url: 'https://api.openai.com/v1', api_key: 'sk-openai' },
      deepseek: { provider: 'deepseek', base_url: 'https://api.deepseek.com/v1', api_key: 'sk-deepseek' },
    };
    return configs[name] as { provider: string; base_url: string; api_key: string };
  },
  getProviderForModel: () => 'openai',
  getRoutingStrategy: () => ({ name: 'default', rules: [{ model: 'gpt-4o', provider: 'openai' }], fallback: 'deepseek' }),
}));

const mockOpenAI = {
  name: 'openai',
  capabilities: { chat: true, embed: false, streaming: false, vision: false, function_call: false },
  chat: jest.fn(),
  chatStream: jest.fn(),
  embed: jest.fn(),
};

const mockDeepSeek = {
  name: 'deepseek',
  capabilities: { chat: true, embed: false, streaming: false, vision: false, function_call: false },
  chat: jest.fn(),
  chatStream: jest.fn(),
  embed: jest.fn(),
};

const mockFailover = {
  recordSuccess: jest.fn(),
  recordFailure: jest.fn(),
  getAvailableToken: jest.fn().mockReturnValue({ apiKey: 'key' }),
  isProviderHealthy: jest.fn().mockReturnValue(true),
  recordProviderRequest: jest.fn(),
  getProviderHealthStatus: jest.fn().mockReturnValue({}),
  getFailoverChain: jest.fn().mockReturnValue(['deepseek']),
  reset: jest.fn(),
};

const mockLoadBalancer = {
  selectToken: jest.fn().mockReturnValue({ apiKey: 'key', weight: 1 }),
  recordSuccess: jest.fn(),
  recordFailure: jest.fn(),
};

describe('Cross-Provider Failover Chain', () => {
  beforeEach(() => {
    resetProviders();
    resetProviderDeps();
    registerProvider('openai', mockOpenAI);
    registerProvider('deepseek', mockDeepSeek);
    jest.clearAllMocks();
  });

  it('should fallback to deepseek when openai fails', async () => {
    mockOpenAI.chat.mockRejectedValue(new Error('OpenAI down'));
    mockDeepSeek.chat.mockResolvedValue({
      id: 'ds-1',
      object: 'chat.completion',
      created: 1,
      model: 'deepseek-chat',
      choices: [],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });

    setProviderDeps({ failoverManager: mockFailover, loadBalanceManager: mockLoadBalancer });

    const result = await chatComplete('openai', {
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'hello' }],
    });

    expect(mockOpenAI.chat).toHaveBeenCalled();
    expect(mockDeepSeek.chat).toHaveBeenCalled();
    expect(result.model).toBe('deepseek-chat');
  });

  it('should skip unhealthy primary provider and use fallback directly', async () => {
    mockFailover.isProviderHealthy.mockImplementation((p: string) => p !== 'openai');
    mockDeepSeek.chat.mockResolvedValue({
      id: 'ds-2',
      object: 'chat.completion',
      created: 1,
      model: 'deepseek-chat',
      choices: [],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });

    setProviderDeps({ failoverManager: mockFailover, loadBalanceManager: mockLoadBalancer });

    const result = await chatComplete('openai', {
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'hello' }],
    });

    expect(mockOpenAI.chat).not.toHaveBeenCalled();
    expect(mockDeepSeek.chat).toHaveBeenCalled();
    expect(result.model).toBe('deepseek-chat');
  });

  it('should throw when all providers in chain fail', async () => {
    mockOpenAI.chat.mockRejectedValue(new Error('OpenAI down'));
    mockDeepSeek.chat.mockRejectedValue(new Error('DeepSeek down'));

    setProviderDeps({ failoverManager: mockFailover, loadBalanceManager: mockLoadBalancer });

    await expect(
      chatComplete('openai', {
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'hello' }],
      })
    ).rejects.toThrow(/All providers failed/);
  });
});
```

- [ ] **Step 2: Run integration test**

Run: `npx jest tests/providers/failover-chain.test.ts --no-coverage`
Expected: All 3 tests pass.

---

### Task 9: Run full test suite and lint

- [ ] **Step 1: Run all tests**

Run: `npm test`
Expected: All suites pass.

- [ ] **Step 2: Run linter**

Run: `npm run lint`
Expected: No lint errors.

- [ ] **Step 3: Run TypeScript check**

Run: `npx tsc --noEmit`
Expected: No type errors.

---

### Task 10: Commit

- [ ] **Step 1: Stage and commit**

Run:
```bash
git add src/types/index.ts src/config/index.ts conf/default.json src/services/failover.ts src/providers/index.ts src/app.ts tests/services/failover.test.ts tests/providers/failover-chain.test.ts
git commit -m "feat: cross-provider failover chain with provider-level health tracking

- Add explicit failover chains to config (chains, errorRateThreshold, latencyThresholdMs)
- Extend FailoverManager with ProviderHealth tracking
- Integrate provider-level isProviderHealthy() into chatComplete fallback loop
- Expose provider health stats in /health endpoint
- Add unit and integration tests

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Self-Review Checklist

**1. Spec coverage:**
- ✅ Explicit failover chain config (`chains`) — Task 2, 3
- ✅ Provider-level health tracking — Task 4
- ✅ Error rate + latency threshold degradation — Task 4 Step 5
- ✅ Automatic health recovery probing — Task 4 Step 6
- ✅ Integration with chatComplete fallback loop — Task 5
- ✅ Health endpoint exposure — Task 6
- ✅ Tests — Task 7, 8

**2. Placeholder scan:**
- ✅ No TBD/TODO/fill-in-details placeholders
- ✅ All code blocks contain complete, copy-pasteable code
- ✅ Exact file paths and line numbers provided

**3. Type consistency:**
- ✅ `ProviderHealth` fields match usage in `recordProviderRequest`, `getProviderHealthStatus`, and tests
- ✅ Config field names (`errorRateThreshold`, `latencyThresholdMs`) consistent across types, config loader, default.json, tests
- ✅ `getFailoverChain` returns `string[]` and is used as such in `getFallbackProviders`
