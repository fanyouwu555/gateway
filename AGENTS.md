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
src/middleware/     Middleware chain: cors → logger → metrics → tracing → auth → virtualKey → ratelimit
src/providers/      AI provider adapters + registry + call orchestration
src/services/       Business logic: router, metrics, cache, quota, failover, loadbalancer, tenant, alert, prompt, chat-pipeline, semantic-cache, token-ratelimit, token-counter, conversation-log, request-log, pricing, embedding
src/plugins/        Plugin system: guardrail, request/response interceptors
src/stores/         Storage abstraction: interface → MemoryKVStore / RedisKVStore, vector memory, ratelimit store
src/config/         Config loader (env vars + conf/default.json)
src/types/          Shared type definitions (no business logic imports allowed)
src/utils/          Pure utilities: logger (standalone), hashing, helpers, audit, tracing, client-info
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
METRICS_STORAGE=memory       # usage metrics
RATE_LIMIT_STORAGE=memory    # sliding window counter
FAILOVER_STORAGE=memory      # health state persistence
```

Redis config from env: `REDIS_URL`, or `REDIS_HOST/PORT/PASSWORD/DB`.

## Provider system

- **OpenAI-compatible providers** (openai, deepseek, groq, mistral, moonshot, volcano, kimi-code, cohere, together, xai, azure-openai): use `OpenAICompatibleProvider` base class (`src/providers/openai-compatible.ts`). Each is ~15 lines of config, not 100+ lines of HTTP boilerplate.
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

- 900+ tests, 60+ suites (as of Jun 2026).
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

---

# AI 网关管理控制台 — 前端开发准则

## 角色与目标
`ai-gateway-admin/` 是一个生产级管理控制台，技术栈已锁定（Vite + React 18 + Ant Design 5 + Zustand 4 + ECharts 5 + React Router 6 + Axios + Day.js），禁止擅自更改。

## 命令

```bash
pnpm dev          # vite dev server (端口 3001, 自动代理 /api → localhost:3000)
pnpm build        # tsc --noEmit && vite build
pnpm preview      # vite preview
pnpm lint         # eslint src/ --ext ts,tsx --max-warnings 0
```

提交前必须按顺序执行：`lint → tsc --noEmit`。

> 注意：pnpm 是强制包管理器，保持依赖一致性。不要混用 npm/yarn。

## 项目架构与文件组织

目前已有目录结构（不允许随意重构）：

```
ai-gateway-admin/src/
  components/      通用组件（跨页面可复用）
    Charts/        ECharts 图表封装（LineChart, PieChart, BarChart）
    common/        通用业务组件（StatsCard 等）
    Layout/        主布局（侧边栏 + 顶栏 + 内容区）
  pages/           业务页面（按功能模块划分子目录）
    Alerts/        告警规则管理
    Cache/         缓存管理
    Conversations/ 对话日志管理
    Dashboard/     仪表盘
    Login/         登录页
    Metrics/       用量统计
    Plugins/       插件管理
    Prompts/       提示词模板管理
    Providers/     Provider 管理
    Router/        路由状态
    Sessions/      会话管理
    Settings/      系统设置
    Tenants/       租户管理
  services/        API 请求封装层（仅此目录调用 axios）
  stores/          Zustand Store
  types/           TypeScript 类型定义
```

**未来扩展目录**（有实际需求时再创建，不要提前建空目录）：
- `hooks/` — 自定义 Hook（数据获取、WebSocket 等）
- `routes/` — 路由配置 + 权限守卫
- `utils/` — 纯工具函数（不可访问 DOM 或 React 上下文）

**基本原则**：
- 禁止循环依赖，禁止跨层级直接引用（如组件直接调用 axios）
- 每个模块通过 `index.ts` 对外暴露公共 API

## 编码规范

- **命名**：组件用 PascalCase，函数/变量用 camelCase，常量用 UPPER_SNAKE_CASE，文件名用 kebab-case。
- **类型**：禁止使用 `any`。所有 Props、API 响应、Store 状态必须显式定义 interface/type。已有 `types/index.ts` 优先复用。
- **JSDoc**：每个公开组件必须包含 JSDoc，说明用途、参数及返回值。
- **CSS**：统一使用 Ant Design 的 `token`（`theme.useToken()`） + CSS classes 定义在 `index.css`。全局样式修改通过 `ConfigProvider` 主题定制。禁止内联样式泛滥。
- **格式化**：必须通过 ESLint 检查，提交前修复。

## 状态管理（Zustand）约束

- **分离服务端状态与客户端 UI 状态**：API 请求的数据不要全部塞进全局 Store，应在页面/组件内通过 `useState` + `useEffect` 管理。Store 只存放真正需要全局共享的状态（如当前用户信息、侧边栏折叠状态）。
- 禁止在 Store 中直接写 HTTP 请求。异步操作必须调用 `services/` 层的函数。
- 新 Store 需使用 `subscribeWithSelector` 中间件精确订阅，防止无意义渲染，并添加 `devtools` 中间件（仅开发环境）。
- **当前实践参考**：`stores/useStore.ts` 是单一全局 Store。后续可按领域拆分为多个 Store（如 `useAuthStore`, `useConfigStore`），每个 Store 对应一个明确领域。

## API 层（Axios）规则

- 实例创建于 `services/api.ts`，已配置拦截器。未来可增强：
  - 请求拦截器：自动注入 `Authorization` token + `X-Request-Id`
  - 响应拦截器：统一处理业务错误码，对 401 触发刷新 token 或跳转登录
- **错误处理**：所有 API 调用在 `catch` 处使用 `message.error()` 给用户友好提示，严禁静默失败。参考已有页面（`providers`、`tenants`）的 catch 模式。
- **取消请求**：页面卸载时取消未完成请求（使用 Axios `CancelToken` 或 `AbortController`）。
- **请求重试**：仅对 GET 请求在网络错误时自动重试 1 次（当前未实现，后续可加）。
- 敏感数据（密码、secret）不在 URL 查询参数中出现，使用 POST body。

## UI 组件使用规范

- **Ant Design**：按需引入（当前手动 import），禁止全量引入 `antd`。
- **操作确认**：所有用户操作（删除、启用/停止等）必须有确认弹窗（`Modal.confirm` / `Popconfirm`）和结果反馈（`message.success/error`）。参考 `Tenants/index.tsx` 的 `handleDelete` 模式。
- **表格/列表**：必须处理 **loading、empty、error** 三种状态。使用 Ant Design 的 `Spin`、`Empty` 或骨架屏。参考当前各页面已经统一使用了 `Table loading` 属性。
- **日期时间**：统一使用 Day.js，已通过 `ConfigProvider` 全局设置中文语言包。
- **ECharts 图表**：已封装为独立组件（`components/Charts/`），接收数据和配置。后续新图表必须遵循已有模式，并在 `useEffect` 返回函数中清理实例（现有的 `echarts-for-react` 已内部处理）。
- **Emoji 禁令**：UI 中禁止使用 emoji，使用 Ant Design 的 `@ant-design/icons` 图标替代。

## 路由与权限

- 当前路由配置集中在 `App.tsx` 中，使用 `React Router 6` 的嵌套路由模式。
- 后续扩展时：
  - 页面级组件必须使用 `React.lazy` + `Suspense` 懒加载，避免首屏过大（当前页面较少暂未做，超过 5 个页面时必须做）。
  - 实现 `RequireAuth` 组件，根据角色控制可访问路由（当前无认证系统，预留）。
  - 路由配置集中管理，从 `App.tsx` 抽取到 `routes/` 目录。

## 性能要求

- 列表渲染超过 50 条必须启用虚拟列表（Ant Design `Table` 的虚拟化）。
- 合理使用 `React.memo`、`useMemo`、`useCallback` 避免非必要渲染。
- 生产构建开启代码分割（Vite 默认已按路由拆包）。
- **当前注意点**：`Dashboard` 页面中 `fetchData` 用了 `Promise.all`，这是好的模式。但 `any` 类型用了多次，后续改为明确类型。

## 安全红线

- 禁止在前端代码中硬编码任何密钥、token。必须通过 `VITE_` 前缀环境变量暴露（当前已有 `VITE_API_BASE_URL` 模式可参考）。
- 所有用户输入在提交前做基本校验（使用 Ant Design Form 校验规则）。
- 渲染后端返回的 HTML/Markdown 时，必须使用 `DOMPurify` 进行清理。
- 禁止直接使用 `dangerouslySetInnerHTML`。

## 开发流程（AI 执行标准）

1. **类型先行**：实现新功能前，先更新 `types/index.ts` 定义接口和类型。
2. **组件自检**：每完成一个组件，检查是否覆盖了所有 Props 类型、是否处理了 `loading/empty/error` 状态。
3. **静态检查**：每次代码输出后，立即执行 `pnpm lint` 和 `pnpm tsc --noEmit`，自行修复错误。
4. **不再用的代码**：删除功能时同步移除相关类型定义、API 函数、Store 字段，不留死代码。

## 禁止事项清单

- 禁止使用 `var`、`==`（除非明确需要类型转换）。
- 禁止在 `useEffect` 中遗漏依赖项。必须正确声明依赖或使用 eslint-disable 注释并解释原因。
- 禁止直接操作 DOM（除非在 ECharts 初始化中，且包裹 ref）。
- 禁止引入未在 `package.json` 中声明的第三方库。如需新增依赖，先说明理由并等待批准。
- 禁止输出不完整的代码片段，所有代码必须是可直接运行的完整文件内容。
- 禁止使用 emoji 作为 UI 元素（参考 `Providers/index.tsx` 中 `providerIcons` 使用了 emoji — 这是当前遗留问题，新代码禁止）。

## 补充说明

- # AI网关的 Admin API 由后端 `src/routes/admin.ts`（或对应文件）提供。前端不直接调用底层 Provider API。
- 当前后端认证尚未接入，前端 `api.ts` 中的 `localStorage.getItem('api_token')` 为预留逻辑。认证接入后需替换为安全存储。
- 测试（Vitest + React Testing Library）为可选但推荐，关键工具函数和复杂业务 Hook 应包含单元测试。
