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

## [0.9.0] - Earlier

- Initial beta release with core routing, caching, failover, and provider adapters.
