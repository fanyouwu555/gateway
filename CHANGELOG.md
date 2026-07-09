# Changelog

All notable changes to this project will be documented in this file.

## [1.0.0] - 2026-07-09

### Added

- **Alerting Rule Engine** — Threshold-based alerting with Webhook notifications.
- **Prompt Template Variable System** — `{{var}}` syntax with Admin API CRUD.
- **Model Alias System** — `model_aliases` config + runtime Admin API.
- **HTTP Agent Connection Pool + Keep-Alive** — undici-based pooling via `HTTP_POOL_SIZE` / `HTTP_KEEP_ALIVE` / `HTTP_KEEP_ALIVE_TIMEOUT` env vars.
- **Plugin VM Sandbox** — Dynamic JS plugin loading with `node:vm` sandbox.
- **Log Persistence** — Daily log rotation with 7-day retention.
- **K8s + Helm Deployment** — Production-ready manifests and Helm chart.
- **Semantic Cache** — LSH-based cosine-similarity caching.
- **Token Rate Limiting** — Per-request token bucket rate limiting.
- **Conversation Logging** — Session-based persistent conversation history.
- **Request Logging** — Structured request/response logging.
- **Pricing Service** — Per-model cost tracking.
- **Billing Mode Refactor** — Unified prepaid/subscription billing with `checkRequestBilling`.
- **Deployment Documentation** — `docs/deployment.md` covering Docker, K8s, Helm, and env vars.

### Changed

- **Redis Cache `get()`** — Async refactor for unified Memory/Redis behavior.
- **Kimi Code Provider** — Switched to `OpenAICompatibleProvider` to fix 403 errors.
- **Auth Middleware** — Prefix-index lookup eliminates O(n) scrypt verification.
- **Stream/Post Processor Extraction** — `src/services/stream-processor.ts` + `post-processor.ts` reduce `chat.ts` complexity.
- **Embed Failover Chain** — Embedding requests now use provider failover.
- **Hardcoded Values** — Extracted `DAY_MS`, `HOUR_MS`, `round3`, `round4` helpers across codebase.
- **WS Timeouts** — Heartbeat/metrics/idle intervals now configurable via env vars.

### Fixed

- Docker build failing due to husky prepare script in Alpine.
- Admin route test auth failures due to scrypt hashing mismatches in mocks.
- Type errors in route params (`c.req.param('id')` returning `undefined`).
- Failover 4xx cascade — Only retry on 5xx/network/429, stop on 4xx.
- Billing error semantics — Returns `billing_error` (402) instead of `rate_limit_error`/`authentication_error`.

## [1.1.0] - 2026-06-09

### Added

- **Semantic Cache** — LSH-based semantic caching with cosine similarity matching for repeated/similar queries.
- **Token Rate Limiting** — Per-request token-based rate limiting in addition to QPS-based limits.
- **Model Pools** — Group multiple models into pools for advanced routing strategies.
- **Model Equivalents** — Configure model fallback chains for automatic model substitution.
- **Conditional Routing** — Route requests based on request metadata and conditional rules.
- **Virtual Key Policies** — Per-key rate limits, budgets, and model allowlists via `src/middleware/virtual-key.ts`.
- **OpenTelemetry Tracing** — Distributed tracing support via OTLP exporter (`src/utils/tracing.ts`).
- **Conversation Logging** — Persistent conversation history with `src/services/conversation-log.ts`.
- **Request Logging** — Structured request/response logging with `src/services/request-log.ts`.
- **Pricing Service** — Per-model cost tracking and billing (`src/services/pricing.ts`).
- **Embedding Service** — Unified embedding endpoint with provider abstraction (`src/services/embedding.ts`).
- **PII Guardrail** — Detect and mask personally identifiable information in requests (`src/plugins/guardrails/pii.ts`).
- **Prompt Injection Guardrail** — Detect and block prompt injection attacks (`src/plugins/guardrails/prompt-injection.ts`).
- **Sensitive Word Filter** — Configurable sensitive word filtering via inline plugin.
- **New Providers** — Added Cohere, Together AI, xAI (Grok), and Azure OpenAI providers.
- **Admin Frontend Pages** — Added Alerts, Cache, Conversations, Login, Plugins, Prompts, Router, Sessions pages.
- **Chat Pipeline Service** — Extracted chat routing logic into dedicated `src/services/chat-pipeline.ts`.

### Changed

- **Kimi Code Provider** — Now extends `OpenAICompatibleProvider` (was custom Anthropic protocol).
- **Admin Routes** — Split monolithic `admin.ts` into domain-specific sub-routers under `src/routes/admin/`.
- **Rate Limit Store** — Extracted ratelimit implementations into `src/stores/ratelimit.ts`.
- **Metrics Registry** — Replaced custom Prometheus registry with `prom-client`.
- **WebSocket Uptime** — Fixed hardcoded `uptime: 0` to track actual manager start time.

## [0.9.0] - Earlier

- Initial beta release with core routing, caching, failover, and provider adapters.
