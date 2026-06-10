# Changelog

All notable changes to this project will be documented in this file.

## [1.0.0] - 2026-05-22

### Added

- **Alerting Rule Engine** - Threshold-based alerting with Webhook notifications. Monitor `error_rate`, `avg_latency_ms`, and `total_requests`. Supports cooldown periods and enable/disable rules.
- **Prompt Template Variable System** - Use `{{var}}` syntax in prompt templates. Templates can be managed via Admin API and referenced in chat requests using `template_id` and `template_variables`.
- **Model Alias System** - Configure friendly aliases (e.g., `fast` -> `gpt-4o-mini`) via `model_aliases` in config or Admin API.
- **HTTP Agent Connection Pool + Keep-Alive** - Explicit undici-based connection pooling for all provider HTTP requests. Configurable via `HTTP_POOL_SIZE`, `HTTP_KEEP_ALIVE`, and `HTTP_KEEP_ALIVE_TIMEOUT` environment variables.
- **Plugin VM Sandbox** - Dynamic JavaScript plugin loading with `node:vm` sandbox for safe execution.
- **Log Persistence** - Daily log rotation with 7-day retention.
- **K8s + Helm Deployment** - Production-ready Kubernetes manifests and Helm chart.
- **k6 Performance Benchmarks** - Load test scripts with SLA thresholds.

### Changed

- **Redis Cache `get()`** - Refactored to async for unified Memory/Redis behavior.
- **Kimi Code Provider** - Switched from custom Anthropic protocol to `OpenAICompatibleProvider` to fix 403 errors.
- **Admin API** - Added full CRUD endpoints for prompt templates, alert rules, and model aliases.

### Fixed

- Docker build failing due to husky prepare script in Alpine.
- Admin route test auth failures due to scrypt hashing mismatches in mocks.
- Type errors in route params (`c.req.param('id')` returning `undefined`).

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
