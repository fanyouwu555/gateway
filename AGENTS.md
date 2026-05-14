# AGENTS.md – AI Gateway

## Commands

```bash
npm run dev       # tsx watch src/index.ts (hot reload)
npm run build     # tsc → dist/
npm start         # tsx dist/index.js
npm test          # jest (uses ts-jest ESM preset)
npm run lint      # eslint src/
npm run format    # prettier --write src/
```

Run a single test file: `npx jest path/to/test.test.ts --no-coverage`

Commands **must** be run in this order before committing: `lint → tsc --noEmit → jest`.

## Architecture

```
src/app.ts          Hono app factory (middleware + routes, no server lifecycle)
src/index.ts        HTTP server start + init (node:http, graceful shutdown)
src/routes/         API route handlers (chat, embed, model, admin)
src/middleware/     Middleware chain: cors → logger → metrics → auth → ratelimit
src/providers/      AI provider adapters + registry + call orchestration
src/services/       Business logic: router, metrics, cache, quota, failover, loadbalancer, tenant
src/plugins/        Plugin system: guardrail, request/response interceptors
src/stores/         Storage abstraction: interface → MemoryKVStore / RedisKVStore
src/config/         Config loader (env vars + conf/default.json)
src/types/          Shared type definitions (no business logic imports allowed)
src/utils/          Pure utilities: logger (standalone), hashing, helpers
src/validation/     Zod schemas for request validation
tests/              Test suites (colocated tests also in src/)
conf/               Config files (mounted readonly in Docker)
```

### Request lifecycle (POST /v1/chat/completions)

```
1. Zod validation (validation/index.ts)
2. Guardrail plugins (plugins/index.ts)
3. Request plugins (transform/enhance payload)
4. SmartRouter decision (services/router.ts) — header x-routing-strategy: cost|latency|quality|balance
5. Provider call (providers/index.ts):
   a. LoadBalancer selects API key (services/loadbalancer.ts) — supports api_keys[]
   b. withRetry for 5xx/network errors (services/retry.ts)
   c. Failover: try backup providers on failure (services/failover.ts)
6. Response plugins (transform/enhance result)
7. Structured JSON log
8. Unified error format: { error: { message, type, code, param } }
```

## Storage switching

Each module checks its own env var. Default is `memory`. Set to `redis` for production:

```
STORAGE_TYPE=memory          # global default
CACHE_STORAGE=memory         # response cache
HISTORY_STORAGE=memory       # session history
METRICS_STORAGE=memory       # usage metrics
RATE_LIMIT_STORAGE=memory    # sliding window counter
FAILOVER_STORAGE=memory      # health state persistence
```

Redis config from env: `REDIS_URL`, or `REDIS_HOST/PORT/PASSWORD/DB`.

## Provider system

- **OpenAI-compatible providers** (openai, deepseek, groq, mistral, moonshot): use `OpenAICompatibleProvider` base class (`src/providers/openai-compatible.ts`). Each is ~15 lines of config, not 100+ lines of HTTP boilerplate.
- **Non-OpenAI providers** (anthropic, google): extend `BaseProvider` directly with custom format conversion.
- **DynamicProvider**: config-driven, no code changes needed. Declare in `conf/default.json` under `dynamicProviders`.
- To add a new provider: create a config object (for OpenAI-compatible) or extend BaseProvider, register in `registry.ts`.

## API Key handling

- All stored keys use scrypt hashing (`$scrypt$salt:hash` format).
- `hashApiKey()` is non-deterministic (random salt). Use `verifyApiKey(plaintext, hashed)` for comparison.
- Config-based keys: set via `API_KEYS` env var or `auth.api_keys` in conf/default.json (auto-hashed).
- Tenant-managed keys: created via Admin API, hashed before storage, plaintext returned only at creation.
- Auth middleware checks BOTH config keys and tenant keys.
- Never log or commit plaintext API keys.

## Config priority

Environment variable > conf/default.json > hardcoded defaults in `src/config/index.ts`.

Config file path: `CONFIG_PATH` env var, default `./conf/default.json`.

## Tests

- 263 tests, 23 suites (as of May 2026).
- Jest uses `ts-jest` with ESM preset. Module name mapper strips `.js` extensions.
- Tests live in both `tests/` and `src/` (colocated with source).
- Coverage threshold: branches/functions/lines/statements ≥ 60%.
- **Heads-up**: the `RetryService` tests (`src/services/retry.test.ts`) use `jest.useFakeTimers` — these may interfere with other tests if run together without `--no-coverage`.

## Docker

```bash
docker compose up -d        # builds + starts on :3000
docker compose build --no-cache  # rebuild
```

Dockerfile: `node:20-alpine`, `npm ci --only=production`, runs `dist/index.js`. Config from `conf/:ro` volume mount. Healthcheck at `/health`.

## Constraints (will fail CI)

- `any`, `as any`, `@ts-ignore`, `@ts-expect-error` → lint error
- `noUnusedLocals: true`, `noUnusedParameters: true` → tsc error
- `catch(e) {}` without handling → lint error
- Tests use `jest.clearAllMocks()` in `afterEach` (setup in `tests/setup.ts`)
- `noImplicitReturns: true` — every code path must return
