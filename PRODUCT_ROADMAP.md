# AI Gateway 产品优化方案

## 一、竞品对标分析

### 1.1 主流 AI 网关功能矩阵

| 功能维度 | LiteLLM | Portkey | Kong AI | Cloudflare AI | 本项目 |
|---------|---------|---------|---------|--------------|--------|
| 多 Provider 路由 | ✅ | ✅ | ✅ | ✅ | ✅ |
| 统一 API 格式 | ✅ 完整 | ✅ 完整 | ✅ | ✅ 基础 | ⚠️ 部分 |
| 虚拟 Key / 应用 Key | ✅ | ✅ | ✅ | ❌ | ❌ |
| 模型自动降级 | ✅ | ✅ | ✅ | ✅ | ⚠️ Provider级 |
| 请求重试 | ✅ 智能 | ✅ | ✅ | ✅ | ✅ 基础 |
| 缓存 | ✅ Redis | ✅ | ✅ | ✅ | ✅ 语义+精确 |
| 配额/预算管理 | ✅ 细粒度 | ✅ | ✅ | ❌ | ⚠️ 基础 |
| 实时成本追踪 | ✅ | ✅ | ✅ | ❌ | ❌ |
| A/B 测试 | ✅ | ✅ | ❌ | ❌ | ❌ |
| 反馈收集 | ❌ | ✅ | ❌ | ❌ | ❌ |
| PII/内容安全 | ✅ | ✅ | ✅ | ❌ | ⚠️ 敏感词 |
| 批处理 API | ✅ | ❌ | ❌ | ❌ | ❌ |
| 开发者门户 | ❌ | ✅ | ✅ | ❌ | ❌ |
| 请求日志审计 | ✅ | ✅ | ✅ | ✅ | ⚠️ 结构化日志 |
| 灰度/金丝雀 | ❌ | ✅ | ✅ | ❌ | ❌ |
| 自动模型选择 | ✅ | ✅ | ❌ | ❌ | ❌ |
| RBAC 权限 | ✅ | ✅ | ✅ | ❌ | ❌ |
| 数据驻留/区域路由 | ✅ | ✅ | ✅ | ✅ | ❌ |
| 请求签名(HMAC) | ❌ | ✅ | ✅ | ❌ | ❌ |
| Tool Call 统一 | ✅ | ✅ | ❌ | ❌ | ⚠️ 基础 |
| 多模态统一 | ✅ | ✅ | ❌ | ❌ | ⚠️ 基础 |
| 预填充(Prefill) | ✅ | ❌ | ❌ | ❌ | ❌ |
| Embedding 路由优化 | ✅ | ❌ | ❌ | ❌ | ⚠️ 基础 |
| 实时指标推送 | ❌ | ✅ | ❌ | ❌ | ⚠️ WS基础 |
| 按用量计费 | ✅ | ✅ | ✅ | ❌ | ❌ |

**结论**: 本项目在核心网关功能（路由、缓存、限流、故障转移）上已具备竞争力，但在**企业级功能**（虚拟Key、RBAC、成本追踪、A/B测试、开发者门户）和**高级路由策略**（模型降级、自动选择、灰度发布）上存在明显差距。

---

## 二、功能缺口与优化建议

### P0 — 核心体验（1-2 周）

#### 2.1 统一 API 格式完善
**现状**: OpenAI-compatible providers 已统一，但 Anthropic/Google/Kimi-Code 等非 OpenAI provider 的字段映射不完整。具体缺口：
- Anthropic Messages API 使用 `system` 作为顶层参数（非 message role），当前未正确处理
- Google Gemini 使用 `contents[].parts[]` 格式，与 OpenAI `messages` 不兼容
- `ChatMessage` 只有 `content: string`，不支持图片 URL / base64（vision/multimodal）
- `response_format`（JSON mode）、`seed`（可复现输出）、`logprobs` 未在 schema 中支持
- Tool call 的响应解析/执行框架缺失（只有 `finish_reason: 'tool_calls'` 标记）
**建议**:
- 重构 `anthropic.ts`/`google.ts` 为完整的请求/响应双向转换层
- 扩展 `ChatMessage` 类型支持多模态内容：`content: string | { type: 'image_url', image_url: { url: string } }[]`
- 在 `chatCompletionRequestSchema` 中添加 `response_format`、`seed`、`logprobs` 字段
- 增加 `tool_choice` 和 `tool` 响应的统一解析/再请求循环（类似 OpenAI function calling flow）

#### 2.2 API 覆盖扩展
**现状**: 只支持 chat completions、embeddings、models。缺少：
- **Audio**: Whisper（语音转文字）、TTS（文字转语音）
- **Images**: DALL-E 等文生图
- **Files**: 文件上传/管理（用于 fine-tuning）
- **Fine-tuning**: 微调作业管理
- **Assistants**: OpenAI Assistants API（threads、runs）
- **Moderations**: 内容审核 API
- **Batch**: 批量异步处理
**建议**:
- Phase 3 优先补齐 **Audio + Images**（市场需求最高）
- 利用现有 Provider 架构扩展：`BaseProvider` 增加 `transcribe`、`speak`、`generateImage` 方法
- `OpenAICompatibleProvider` 可直接支持（OpenAI/DALL-E/Moonshot 等都兼容）

#### 2.3 请求/响应日志审计
**现状**: 只有结构化 JSON 日志到控制台/文件，没有可查询的审计存储。具体问题：
- 日志中没有敏感字段脱敏（API key 可能在日志中泄露）
- 没有分布式追踪 ID（trace_id / correlation_id）
- 没有日志采样（高流量时日志量爆炸）
**建议**:
- 新增 `src/services/audit.ts` — 可选将完整请求/响应写入存储（SQLite/PostgreSQL/ClickHouse）
- Admin API: `GET /v1/audit/logs?tenant_id=xxx&start=...&end=...&model=...&status=...`
- 敏感字段自动脱敏：Authorization、api-key、x-api-key 等 header 值替换为 `[REDACTED]`
- 分布式追踪：`X-Trace-Id` header 透传，日志中统一记录 `trace_id`
- 日志采样：配置 `log_sample_rate`（默认 1.0，高流量可降至 0.1）

#### 2.4 实时成本追踪看板
**现状**: Metrics 页面只有历史聚合，没有实时成本。具体缺口：
- 没有按小时聚合的成本时间序列
- Dashboard 没有"今日已用成本"、"本月已用成本"卡片
- 没有预算预警视觉提示
**建议**:
- 后端：`recordUsage` 时同时写入时间序列数据（按小时聚合到 Redis/内存）
- 前端 Dashboard 增加"今日成本"、"本月成本"实时卡片（红色高亮当超过 80% 预算）
- 成本趋势图（按 provider / model / tenant 维度，ECharts 折线图）
- 预算预警：接近阈值时弹窗 + WebSocket 推送通知

#### 2.5 限流精细化
**现状**: 只有全局限流，没有租户级/模型级限流。具体缺口：
- 没有 per-tenant rate limits（所有租户共享同一个 bucket）
- 没有 per-model rate limits
- 没有 `Retry-After` header（客户端不知道何时重试）
- 没有自适应限流（根据 provider 错误率动态调整）
**建议**:
- 租户级限流：在 `TenantLimits` 中增加 `rate_limit_qps` 和 `rate_limit_burst`
- 模型级限流：配置 `model_rate_limits: { "gpt-4o": { qps: 5, burst: 10 } }`
- 429 响应增加 `Retry-After` header
- 自适应限流：当 provider 错误率 > threshold 时，自动降低该 provider 的 rate limit

### P1 — 企业功能（2-4 周）

#### 2.6 虚拟 Key / 应用级 Key 系统
**现状**: API Key 只有租户级别，一个租户的所有应用共享同一个 key，无法区分用量。没有 API key 轮换机制。
**建议**:
- 新增 `VirtualKey` 概念：一个租户可创建多个虚拟 key，每个绑定不同的限制（rate limit、budget、allowed models）
- 数据模型: `{ id, name, tenant_id, hashed_key, budget_limit, rate_limit, allowed_models, created_at }`
- 认证中间件：先验证虚拟 key，再映射到 tenant
- Admin API: CRUD 虚拟 key + 禁用/启用 + 用量查询
- 前端：Tenant 详情页增加"虚拟 Key 管理"标签（创建、查看用量、禁用、删除）
- API Key 轮换：支持创建新 key 后自动在 24h 后废弃旧 key

#### 2.7 模型自动降级（Model-level Fallback）
**现状**: Failover 是 provider 级别（openai down → deepseek），不是模型级别。流式请求明确不支持 Failover（`chatCompleteStream` 无 failover）。
**建议**:
- 配置中支持 `model_fallbacks`: `{ "gpt-4o": ["gpt-4o-mini", "deepseek-chat"], "claude-3-opus": ["claude-3-sonnet"] }`
- 当首选模型返回 429/503 或超时，自动尝试列表中的下一个模型
- 保留原始模型信息在响应 header 中（`X-Original-Model` / `X-Actual-Model`）
- **流式 Failover**：在 SSE 解析中检测错误，自动切换到 fallback provider 重新建立流

#### 2.8 灰度发布 / A-B 测试
**现状**: 没有按流量比例分配不同模型的能力。Prompt 模板也没有 A/B 测试。
**建议**:
- 新增 `experiments` 配置:
  ```json
  {
    "experiments": [{
      "id": "exp-001",
      "name": "GPT-4o vs Claude Sonnet",
      "model_a": "gpt-4o",
      "model_b": "claude-3-5-sonnet-20241022",
      "split": 0.5,
      "enabled": true
    }]
  }
  ```
- 按 `user_id` hash 或随机数分配流量
- 记录 experiment_id 到日志和 metrics
- Prompt 模板也支持实验：对比不同 prompt 的响应效果
- Admin 前端：实验管理页面 + 结果对比（成功率、延迟、成本、用户反馈）

#### 2.9 RBAC 权限控制 + 认证增强
**现状**: 只有 admin / non-admin 两级。没有 OAuth2/JWT、MFA、IP 白名单。
**建议**:
- 引入角色：super_admin（系统管理）、admin（租户管理）、developer（只读+调用）、viewer（只读）
- 权限矩阵：

  | 操作 | super_admin | admin | developer | viewer |
  |------|------------|-------|-----------|--------|
  | 修改系统配置 | ✅ | ❌ | ❌ | ❌ |
  | 管理所有租户 | ✅ | ❌ | ❌ | ❌ |
  | 管理自己租户 | ✅ | ✅ | ❌ | ❌ |
  | 创建 API Key | ✅ | ✅ | ✅ | ❌ |
  | 调用 Chat API | ✅ | ✅ | ✅ | ❌ |
  | 查看 Metrics | ✅ | ✅ | ✅ | ✅ |

- IP 白名单：租户可配置允许访问的 IP 范围
- 可选 JWT/OAuth2 支持（通过 `x-auth-provider` header）

#### 2.10 多租户资源隔离增强
**现状**: 所有租户共享同一个 provider 配置（base_url、api_key）。没有租户级别的 provider credentials。
**建议**:
- `TenantConfig` 增加 `provider_credentials`：每个租户可使用自己的 OpenAI/DeepSeek API key
- 路由时优先使用租户自己的 credentials，fallback 到全局配置
- 并发请求限制执行：当前 `concurrent_requests` 只在配置中有定义，实际未在 middleware 中限制
- 租户级 provider 白名单：限制租户只能使用指定的 provider 列表

### P2 — 高级能力（4-8 周）

#### 2.11 内容安全与 PII 检测
**现状**: 只有敏感词过滤（字符串匹配）。
**建议**:
- 集成轻量级 PII 检测（正则 + 简单 NER）：检测手机号、身份证号、邮箱、信用卡号
- 支持数据掩码（masking）而非阻断：将 PII 替换为 `[PHONE]`、`[EMAIL]` 后转发
- 可选集成第三方内容安全 API（如 Azure Content Safety）
- 配置化：不同租户可设置不同的安全级别

#### 2.12 开发者门户
**现状**: 没有面向开发者的 API 文档和工具。没有 OpenAPI/Swagger 规范。
**建议**:
- 新增 `/docs` 路由，提供交互式 API 文档（Swagger/OpenAPI）
- API Playground：在线测试接口（类似 OpenAI Playground）
- SDK 示例：curl / Python / Node.js / Go 代码片段
- 用量查询 API：开发者可查询自己的用量
- 自动生成 `openapi.yaml`：从 Zod schema + 路由定义生成

#### 2.13 批处理 API（Batch）
**现状**: 只能逐条发送请求。
**建议**:
- `POST /v1/batch` — 接受多条 chat completion 请求，异步执行
- 返回 `batch_id`，通过 `GET /v1/batch/{id}` 查询状态
- 完成后通过 Webhook 通知或轮询获取结果
- 适用于：大规模数据处理、夜间批量任务

#### 2.14 请求签名验证（HMAC）
**现状**: 只有 Bearer Token 认证。
**建议**:
- 支持 HMAC-SHA256 请求签名：`Authorization: HMAC-SHA256 key_id={id}, signature={sig}, timestamp={ts}`
- 防止请求重放（检查 timestamp 在 5 分钟内）
- 适合高安全场景（金融、医疗）

#### 2.15 数据驻留与区域路由
**现状**: 没有按地域选择 provider 的能力。
**建议**:
- 配置 `regions`: `{ "cn": ["volcano", "moonshot"], "global": ["openai", "anthropic"] }`
- 根据请求来源 IP 或 `x-region` header 路由到合规 provider
- 满足数据合规要求（中国数据不出境、GDPR 等）

#### 2.16 反馈收集与模型评分
**现状**: 没有收集用户对响应质量的机制。
**建议**:
- `POST /v1/feedback` — 对某次请求打分（thumbs up/down + 评论）
- 存储: `{ request_id, rating, comment, tags, created_at }`
- Admin 前端：模型评分排行榜、负面反馈分析
- 用于 A/B 测试评估和模型选型决策

#### 2.17 预填充（Prefill）支持
**现状**: 不支持强制模型以特定内容开头。
**建议**:
- 支持 `prefill` 参数：强制模型输出以指定字符串开头
- 对 Anthropic Claude 特别有用（Claude 原生支持 prefill）
- 对 OpenAI 可通过 `assistant` message 模拟

#### 2.18 插件系统增强
**现状**: 插件重启后丢失、沙箱不安全（VM `runInNewContext`）、只有 2 个内置插件、没有生命周期管理。
**建议**:
- **插件持久化**：启动时从 Redis/SQLite 加载已注册插件
- **安全沙箱升级**：可选 WASM 或独立 worker 进程（替代 VM）
- **生命周期 hooks**：`onInit`、`onDestroy`、`onConfigChange`
- **状态管理**：插件可维护跨请求的状态（通过受限的 storage API）
- **内置插件扩展**：PII 检测、请求签名验证、自动重试策略、缓存预热
- **插件市场**：预置常用插件模板，一键安装

#### 2.19 缓存系统升级
**现状**: 语义缓存使用 Jaccard 相似度（简单分词），不支持 embedding-based 相似度。没有缓存预热、按模型版本失效。
**建议**:
- **Embedding-based 语义缓存**：使用轻量级 embedding 模型（如 all-MiniLM）计算余弦相似度，替代 Jaccard
- **缓存预热**：系统启动时自动加载高频查询到缓存
- **缓存失效策略**：按 model 版本、provider 配置变更自动失效相关缓存
- **缓存穿透保护**：对相同请求的并发穿透进行合并（singleflight 模式）

#### 2.20 流式传输完善
**现状**: 
- `chatCompleteStream` 明确不支持 Failover
- WebSocket 中 `abortController.signal` 未传递给 provider（TODO at line 650）
- 没有流恢复机制（断线后从中断处继续）
**建议**:
- 流式 Failover：在 SSE 解析中检测错误，自动切换到 fallback provider 重新建立流
- 实现 AbortController 信号透传：provider 支持取消后，WebSocket 客户端可中断生成
- 流恢复：客户端发送 `resume` 消息时，从中断的 token 位置继续生成

---

## 三、前端产品体验优化

### 3.1 Dashboard 增强
- **实时流量监控**：WebSocket 推送实时 QPS、延迟热力图
- **成本预警卡片**：当用量接近预算阈值时变色 + 弹窗
- **Provider 健康状态矩阵**：所有 provider 的延迟、成功率、错误率一览
- **Top 10 模型/租户排行**：用量最高的模型和租户

### 3.2 新增页面
- **虚拟 Key 管理**：创建、编辑、禁用、查看用量
- **实验管理（A/B Test）**：创建实验、查看对比结果
- **审计日志**：可筛选、可导出的请求日志查询
- **开发者中心**：API 文档、Playground、SDK 示例
- **告警规则管理**：现有告警引擎的前端配置界面（目前只有后端 API）

### 3.3 交互优化
- **全局搜索**：快速跳转到租户、key、模型
- **操作确认强化**：删除租户/key 时要求输入名称确认
- **批量操作**：批量禁用/启用 provider、批量删除 key
- **暗黑模式**：Ant Design 内置支持，添加主题切换

---

## 四、技术架构建议

### 4.1 存储扩展
当前所有存储都是内存或 Redis 二选一。建议引入分层存储：
- **热数据**（最近 1 小时）：内存
- **温数据**（最近 7 天）：Redis
- **冷数据**（历史）：SQLite / PostgreSQL / ClickHouse（可选）

### 4.2 异步队列
批处理、日志写入、告警通知等重操作应放入异步队列：
- 方案 A：BullMQ（Redis-based，轻量）
- 方案 B：Node.js 原生 EventEmitter + 内存队列（更简单）

### 4.3 OpenAPI 规范
生成 `openapi.yaml`，自动生成：
- 前端 API client（Orval / OpenAPI Generator）
- 开发者门户文档（Swagger UI）
- SDK 类型定义

---

## 五、实施路线图

### Phase 3 — 核心完善（3 周）
| 周 | 任务 | 验收标准 |
|----|------|---------|
| 1 | 统一 API 格式完善（Anthropic/Google 转换 + vision + tool_calls + response_format/seed） | Anthropic Messages API 转换正确；图片 URL 可透传；tool call 可循环执行 |
| 1-2 | 审计日志存储 + 日志脱敏 + 分布式追踪 | `GET /v1/audit/logs` 可筛选查询；Authorization header 不脱敏即报错；`X-Trace-Id` 全链路透传 |
| 2 | 实时成本看板 + 限流精细化（per-tenant + per-model + Retry-After） | Dashboard 显示今日/本月成本红色预警；不同租户有独立限流 bucket；429 响应带 Retry-After |
| 2-3 | 虚拟 Key 系统 + 模型降级 + 流式 Failover | 可创建虚拟 Key 绑定独立预算；gpt-4o 超时自动 fallback；流式请求断线后可切换 provider |

### Phase 4 — 企业功能（4 周）
| 周 | 任务 | 验收标准 |
|----|------|---------|
| 1 | RBAC + 多租户资源隔离（tenant-specific provider credentials + 并发限制） | 不同角色看到不同菜单；租户可用自己的 OpenAI key；并发超限返回 429 |
| 1-2 | 灰度 A/B 测试 + 开发者门户 | 可配置 50/50 流量实验；`/docs` 有 Swagger UI + Playground |
| 2-3 | PII 检测 + 内容安全 + HMAC 签名 | 手机号自动掩码后转发；HMAC 签名验证通过 |
| 3 | 批处理 API + 数据驻留 | 可提交 100 条批量任务异步执行；中国 IP 自动路由到火山引擎 |
| 3-4 | 反馈收集 + 插件系统增强（持久化 + 生命周期） | 用户可对响应评分；插件重启后自动恢复；支持 onInit/onDestroy hooks |

### Phase 5 — 体验与性能优化（2 周）
| 周 | 任务 | 验收标准 |
|----|------|---------|
| 1 | 前端页面补齐（Prompt/Plugin/Alert/Provider/审计日志/虚拟 Key）+ 暗黑模式 | 所有 Admin API 都有对应前端页面；主题切换正常 |
| 1-2 | 缓存升级（embedding-based 语义相似度 + 缓存预热 + singleflight）+ OpenAPI 规范 | 语义缓存使用余弦相似度；相同请求并发合并为单次后端调用；`openapi.yaml` 自动生成 |

---

## 六、优先级决策建议

**如果资源有限（1 人，每周 10-15 小时）**：
1. **必做**：虚拟 Key 系统（最影响企业采用）+ 实时成本看板（最直观的产品价值）
2. **强烈建议**：模型降级 + 审计日志（提升可靠性）
3. **可选**：A/B 测试 + 开发者门户（差异化竞争力）

**如果要快速演示给投资人/客户**：
1. 实时成本看板（视觉效果强）
2. 虚拟 Key 管理（体现多租户能力）
3. 审计日志查询（体现企业级合规）
4. 开发者门户 + Playground（降低接入门槛）
