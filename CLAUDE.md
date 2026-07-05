# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

AI Gateway - Multi-Provider LLM Routing. A TypeScript/Hono-based gateway that unifies access to multiple LLM providers (OpenAI, DeepSeek, Anthropic, Mistral, Groq, Google, Moonshot, Volcano Engine, Kimi Code) with smart routing, load balancing, rate limiting, caching, failover, session management, prompt templates, model aliases, alert engine, and a plugin system.

## Commands

```bash
npm run dev       # tsx watch src/index.ts (hot reload on port 3000)
npm run build     # tsc → dist/
npm start         # tsx dist/index.js
npm test          # jest (38 suites, 395 tests, ts-jest ESM preset)
npm run lint      # eslint src/
npm run format    # prettier --write src/
```

Run a single test file: `npx jest path/to/test.test.ts --no-coverage`

**Pre-commit order** (will fail CI if not done): `lint → tsc --noEmit → jest`

## Architecture

```
src/app.ts          Hono app factory (middleware + routes, no server lifecycle)
src/index.ts        HTTP server start + init (node:http, graceful shutdown)
src/routes/         API route handlers (chat, embed, model, admin)
src/middleware/     Middleware chain: cors → logger → metrics → tracing → auth → virtualKey → rateLimit
src/providers/      AI provider adapters + registry + call orchestration
src/services/       Business logic: router, metrics, cache, quota, failover, loadbalancer, tenant, alert, prompt, chat-pipeline, semantic-cache, token-ratelimit, token-counter, conversation-log, request-log, pricing, embedding
src/plugins/        Plugin system: guardrail, request/response interceptors + VM sandbox loader
src/stores/         Storage abstraction: interface → MemoryKVStore / RedisKVStore, vector memory, ratelimit store, factory pattern
src/config/         Config loader (env vars + conf/default.json), model alias resolution
src/types/          Shared type definitions (no business logic imports allowed)
src/utils/          Pure utilities: logger (standalone), hashing, helpers
src/validation/     Zod schemas for request validation
tests/              Test suites (colocated tests also in src/)
conf/               Config files (mounted readonly in Docker)
ai-gateway-admin/   React admin dashboard (Vite + Ant Design + Zustand + ECharts)
```

### Request Lifecycle (POST /v1/chat/completions)

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

### Middleware Scoping Pattern

The app uses Hono's sub-app pattern for middleware scoping:
- `app` (global): cors, logger, metrics, tracing, public routes (/health, /, /metrics) + WS auth endpoint
- `protectedApi` (sub-app): auth, virtualKey, rateLimit, all business routes
- Admin routes have additional `requireAdmin` middleware

## Key Modules

### Providers

- **OpenAI-compatible** (openai, deepseek, groq, mistral, moonshot, volcano, kimi-code, cohere, together, xai, azure-openai): extend `OpenAICompatibleProvider` (~15 lines each, no HTTP boilerplate)
- **Non-OpenAI** (anthropic, google): extend `BaseProvider` directly with custom format conversion
- **DynamicProvider**: config-driven in `conf/default.json` under `dynamicProviders`, no code changes needed
- **Registry**: `src/providers/registry.ts` — call `registerProvider(name, instance)` to add

### Storage Switching

Each module checks its own env var. Default is `memory`. Set to `redis` for production:

```
STORAGE_TYPE=memory           # global default (all services share this)
CACHE_STORAGE=memory          # response cache (uses global STORAGE_TYPE)
METRICS_STORAGE=memory        # usage metrics
RATE_LIMIT_STORAGE=memory     # sliding window counter
FAILOVER_STORAGE=memory       # health state persistence
ALERT_STORAGE=memory          # alert rule state
TENANT_STORAGE=memory         # tenant data
QUOTA_STORAGE=memory          # quota state
WALLET_STORAGE=memory         # wallet balances
BILLING_STORAGE=memory        # key-level monthly cost tracking
```

Redis config: `REDIS_URL`, or `REDIS_HOST/PORT/PASSWORD/DB`.

### API Key Security

- All stored keys use scrypt hashing (`$scrypt$salt:hash` format)
- `hashApiKey()` is non-deterministic (random salt). Use `verifyApiKey(plaintext, hashed)` for comparison
- Config keys: `API_KEYS` env var or `auth.api_keys` in conf/default.json (auto-hashed at startup)
- Tenant keys: created via Admin API, hashed before storage, plaintext returned only at creation
- Auth middleware checks BOTH config keys and tenant keys
- **Never log or commit plaintext API keys**

### Config Priority

Environment variable > `conf/default.json` > hardcoded defaults in `src/config/index.ts`.

Config path override: `CONFIG_PATH` env var.

### Model Aliases

Configured in `conf/default.json` under `model_aliases` (e.g., `{ "gpt-4": "gpt-4o" }`). The `resolveModelAlias()` function in `src/config/index.ts` resolves aliases at request time. Managed at runtime via Admin API `PUT /v1/config/aliases`. Aliases allow clients to reference models by simplified names or migrate traffic without client-side changes.

### Alert Engine

Defined in `src/services/alert.ts`. A rule-based alert system that periodically evaluates metrics (`error_rate`, `avg_latency_ms`, `total_requests`) against thresholds and sends webhook notifications. Rules are managed via Admin API (`/v1/alerts/*`) and the engine runs on a configurable interval (default 60s).

### Prompt Templates

Defined in `src/services/prompt.ts`. Built-in template store with support for `{{var}}` variable substitution. Includes 4 preset templates (translate, summarize, code-review, qa). Templates can be rendered at request time via the `template_id` field in chat completion requests, or managed via Admin API (`/v1/prompts/*`).

## Routes

| Method | Path | Description | Auth |
|--------|------|-------------|------|
| GET | `/health` | Health check | Public |
| GET | `/metrics` | Prometheus metrics | Public |
| GET | `/` | Root info | Public |
| POST | `/v1/chat/completions` | Chat completions (streaming supported) | API Key |
| POST | `/v1/embeddings` | Embeddings | API Key |
| GET | `/v1/models` | List models | API Key |
| ALL | `/v1/tenants/*` | Tenant management | Admin Key |
| ALL | `/v1/config/*` | Runtime config | Admin Key |
| ALL | `/v1/plugins/*` | Plugin management | Admin Key |
| ALL | `/v1/usage/*` | Usage analytics | Admin Key |
| ALL | `/v1/quota/*` | Quota management | Admin Key |
| ALL | `/v1/cache/*` | Cache management | Admin Key |
| ALL | `/v1/prompts/*` | Prompt template CRUD + render | Admin Key |
| ALL | `/v1/alerts/*` | Alert rule management | Admin Key |
| GET | `/v1/router/status` | Router status | Admin Key |
| ALL | `/v1/conversations/*` | Conversation log management | Admin Key |
| GET | `/v1/conversations/:session_id/stats` | Session stats | Admin Key |
| GET | `/v1/request-logs` | Request/response logs | Admin Key |
| ALL | `/v1/pricing/*` | Model pricing management | Admin Key |
| GET | `/v1/sessions` | Session stats | Admin Key |
| POST | `/v1/sessions/clean` | Clean expired sessions | Admin Key |
| GET | `/v1/admin/discover-models` | Discover models from provider | Admin Key |
| GET | `/v1/auth/verify` | Verify admin auth key | Admin Key |
| WS | `/v1/ws/*` | WebSocket streaming + real-time metrics | API Key |

## Type System

All shared types live in `src/types/index.ts`. This file MUST NOT import any business logic modules to avoid circular dependencies.

Key types: `IProvider`, `IGatewayConfig`, `ChatCompletionRequest`, `ChatCompletionResponse`, `IApiKeyMeta`, `IRequestLog`.

## Error Handling

Use `GatewayError` from `src/middleware/error.ts` for all known error conditions. The global error handler in `app.ts` catches and formats them consistently.

Error types: `invalid_request_error`, `authentication_error`, `rate_limit_error`, `provider_error`, `internal_error`.

## Testing

- Jest with `ts-jest` ESM preset. Module name mapper strips `.js` extensions.
- Coverage threshold: branches/functions/lines/statements ≥ 60%.
- Tests live in both `tests/` and `src/` (colocated with source).
- **Important**: `RetryService` tests use `jest.useFakeTimers` — may interfere with other tests when run with coverage. Use `--no-coverage` for single test runs.
- `tests/setup.ts`: global afterEach with `jest.clearAllMocks()`

## Admin Frontend (ai-gateway-admin/)

React 18 + Vite + Ant Design 5 + Zustand 4 + ECharts 5 + React Router 6. Package manager: **pnpm only**.

```bash
pnpm install      # install dependencies (pnpm only — do NOT use npm)
pnpm dev          # port 3001, proxies /api → localhost:3000
pnpm build        # tsc --noEmit && vite build
pnpm lint         # eslint src/ --ext ts,tsx --max-warnings 0
pnpm test         # vitest
```

Directory structure (locked, do not refactor):
- `components/` — reusable (Charts/, common/, Layout/)
- `pages/` — business pages (Dashboard/, Providers/, Tenants/, Metrics/, Settings/, Alerts/, Cache/, Conversations/, Login/, Plugins/, Prompts/, Router/, Sessions/)
- `services/` — Axios API layer ONLY
- `stores/` — Zustand global state
- `types/` — TypeScript definitions

Key rules:
- Separate server state from UI state. Don't put API data in global Store unless truly shared.
- No HTTP calls in Store — call `services/` layer functions.
- All operations (delete, enable/disable) need `Modal.confirm` + `message.success/error`.
- Tables must handle loading, empty, and error states.
- No `any`, no `var`, no `==`, no emoji in UI.
- Pre-commit: `pnpm lint → pnpm tsc --noEmit`.

## Lint & Type Constraints (Will Fail CI)

- `any`, `as any`, `@ts-ignore`, `@ts-expect-error` → lint error
- `noUnusedLocals: true`, `noUnusedParameters: true` → tsc error
- `catch(e) {}` without handling → lint error
- `noImplicitReturns: true` — every code path must return
- `noFallthroughCasesInSwitch: true` — switch fallthrough is an error

## Docker

```bash
docker compose up -d        # builds + starts on :3000
docker compose build --no-cache  # rebuild
```

Dockerfile: `node:20-alpine`, `npm ci --only=production`, runs `dist/index.js`. Config from `conf/:ro` volume mount. Healthcheck at `/health`.

## Common Development Tasks

**Add a new provider**:
1. If OpenAI-compatible: extend `OpenAICompatibleProvider` in `src/providers/[name]/index.ts`
2. If non-standard (Anthropic-style): extend `BaseProvider` with custom chat/chatStream/embed
3. Register in `src/providers/registry.ts`
4. Add config env var parsing in `src/config/index.ts`

**Add a new route**:
1. Add to existing router in `src/routes/` or create new
2. Register in `app.ts` under `protectedApi` (or `app` if public)

**Add a plugin**:
1. Implement `IPlugin` interface from `src/plugins/index.ts`
2. Register via `registerPlugin()` at startup or via Admin API

**Add a storage support**:

1. Implement `IKVStore` interface from `src/stores/interface.ts`
2. Add factory case in `src/stores/factory.ts`
3. Add env var support

**HTTP connection pool**: Configured via `HTTP_POOL_SIZE` (default 100), `HTTP_KEEP_ALIVE` (default true), `HTTP_KEEP_ALIVE_TIMEOUT` (default 60000ms) env vars. Uses undici `Agent` with shared connection pool in `src/utils/http-client.ts`.

**Plugin sandbox**: External plugin code is loaded via Node.js `vm` module in `src/plugins/loader.ts` with a restricted sandbox (no `require`, no `process`, no filesystem access).

Behavioral guidelines to reduce common LLM coding mistakes. Merge with project-specific instructions as needed.

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

---

**These guidelines are working if:** fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.
