# AGENTS.md – AI 网关开发约束规则

> 本文件为 OpenCode 智能体定义不可逾越的行为边界。
> **核心原则**：先看见 → 再验证 → 后执行。所有操作必须经过规则检查与自我验证。

---

## 🧱 1. 架构与代码风格

### 1.1 技术栈与类型安全
- **语言**：TypeScript 严格模式（`strict: true`），禁止使用 `any`、`as any`、`@ts-ignore`。
- **模块系统**：ES Modules（`"type": "module"`）。
- **类型定义**：所有公共函数、类、接口必须有明确的类型声明。
- **异常处理**：禁止空 catch 块 `catch(e) {}`，必须记录或处理。

### 1.2 目录结构（强制）
```
src/
├── index.ts              # 入口文件
├── routes/               # API 路由定义
│   ├── chat.ts          # /v1/chat/completions
│   ├── embed.ts         # /v1/embeddings
│   └── model.ts         # /v1/models
├── middleware/          # 中间件
│   ├── auth.ts          # API Key 鉴权
│   ├── logger.ts        # 请求日志
│   └── ratelimit.ts     # 限流
├── providers/           # AI 供应商适配器（复用 Portkey 模式）
│   ├── openai/
│   ├── deepseek/
│   └── index.ts         # Provider 注册中心
├── services/            # 业务逻辑服务
│   ├── router.ts        # 路由策略
│   ├── token.ts         # Token 计算
│   └── metrics.ts       # 用量统计
├── config/              # 配置管理
│   └── index.ts         # 配置加载
├── types/               # 公共类型与常量
│   └── index.ts
└── utils/               # 纯函数工具库
    └── index.ts

tests/                   # 单元测试
conf/                    # 配置文件
```
- **禁止**在 `types/` 中导入业务层代码（gateways、middleware、services）。
- **禁止**单个文件超过 600 行（测试文件除外）。
- 超过 400 行考虑拆分。

### 1.3 命名规范
| 类型 | 规则 | 示例 |
|------|------|------|
| 文件名 | `kebab-case.ts` | `chat-completions.ts` |
| 类名 | `PascalCase` | `RouterService` |
| 函数/变量 | `camelCase` | `getApiKey()` |
| 常量 | `UPPER_SNAKE_CASE` | `DEFAULT_TIMEOUT` |
| 私有属性 | `_privateField` | `_cache` |
| 接口 | `PascalCase` + `I` 前缀 | `IProviderConfig` |
| 类型 | `PascalCase` | `ChatRequest` |

### 1.4 代码格式
- 遵循项目根目录的 `.eslintrc` 和 `.prettierrc` 规则。
- 如果无配置文件，默认：
  - 缩进：2 空格
  - 引号：单引号
  - 行尾分号：必须
  - 最大行长：100

### 1.5 文件组织
- **一个文件一个导出**：避免 barrel 文件（index.ts）过长
- **测试文件靠近源码**：`src/utils/index.ts` → `tests/utils/index.test.ts`
- **配置与代码分离**：业务配置放 `conf/`，不写死在代码里

---

## 🔒 2. 工作流与操作安全

### 2.1 文件操作铁律
- **修改文件前**：必须先读取原始内容（禁止直接覆盖）。
- **删除文件**：以下情况必须确认：
  - `.env`、`.env.example`、配置文件
  - 一次删除 5 个以上文件
  - 删除整个目录
- **同时修改超过 5 个文件**：建议拆分为多次 `git commit`，每次提交后运行 `npm run build`。
- **回滚操作**：`git revert` 比 `git reset` 更安全。

### 2.2 代码生成规则
- **禁止**：生成包含未实现的占位符函数（除了在本文档 Feature List 中列出的）。
- **允许**：合理的 TODO（如 "TODO: 支持 Anthropic Provider"），禁止 FIXME。
- **禁止**：直接复制粘贴第三方代码而不通过 `npm install` 管理依赖。
- **新增依赖**：必须在 `package.json` 中明确版本范围（如 `^4.0.0`），禁止 `latest`。

### 2.3 测试强制
- **核心功能**（路由、鉴权、限流、请求转发）：100% 覆盖
- **其他功能**：逐步提升，目标 70%
- **Phase 1 允许**：核心覆盖 > 60% 即可，但必须有人工测试
- 修改代码后：运行 `npm run test` 确保通过
- 集成测试：必须测试实际的 HTTP 请求（使用 `supertest` 或类似工具）

### 2.4 构建与部署
- `npm run build` 必须通过才能提交
- 禁止跳过 lint 检查
- 生产构建使用 `NODE_ENV=production`

---

## 🛡️ 3. 数据与合规审计

### 3.1 敏感信息保护
- **禁止**在代码、注释或日志中输出：
  - API Key / Secret（即使是测试 Key）
  - JWT Token
  - 用户密码
  - 内网 IP 或域名
  - 数据库连接字符串
- 强制使用环境变量（`process.env.XXX`），默认值必须为 `undefined`。
- 日志中必须对敏感字段（api_key、password、token）做脱敏处理。

### 3.2 日志与审计
- 每次 AI 模型调用必须记录：
  - 请求 ID（UUID）
  - 路由目标 Provider
  - 模型名称
  - 输入/输出 Token 数量
  - 延迟（毫秒）
  - 响应状态码
  - 租户/用户标识（脱敏后）
- **错误日志**：必须包含堆栈和请求上下文，**禁止**记录原始请求体（可能含敏感数据）。
- 日志级别：
  - `error`：系统错误
  - `warn`：可恢复异常
  - `info`：关键业务事件
  - `debug`：开发调试

### 3.3 限流与访问控制
- 所有入口必须有基于 IP 或 API Key 的限流（令牌桶或滑动窗口）。
- **默认配置**：QPS = 10，突发容量 = 20（可在配置中修改）。
- 限流触发时返回 `429 Too Many Requests`。

### 3.4 错误响应规范
```typescript
// 错误响应格式
{
  "error": {
    "message": "错误描述",
    "type": "invalid_request_error",
    "code": "invalid_api_key",
    "param": null
  }
}
```
- 禁止泄露内部实现细节（如数据库错误、堆栈信息给客户端）

---

## 🧭 4. 模型路由与成本控制

### 4.1 路由策略（可配置）
路由规则在 `conf/routing.json` 中配置，示例：
```json
{
  "strategies": [
    {
      "name": "default",
      "rules": [
        { "model": "gpt-4o-mini", "max_tokens": 4096 },
        { "model": "gpt-4-turbo", "max_tokens": 128000 }
      ]
    }
  ],
  "providers": {
    "openai": { "base_url": "https://api.openai.com/v1" },
    "deepseek": { "base_url": "https://api.deepseek.com/v1" }
  }
}
```
- **禁止**在代码中硬编码模型名称
- 允许通过 Header `x-model` 指定模型

### 4.2 超时与重试
| 配置 | 默认值 | 可配置 |
|------|--------|--------|
| 请求超时 | 30 秒 | 是 |
| 最大重试次数 | 3 次 | 是 |
| 重试退避 | 指数 (1s, 2s, 4s) | 是 |
- 重试仅对 `5xx` 或网络错误生效
- `4xx` 立即失败，不重试

### 4.3 成本控制
- **默认预算**：可在配置中设置（如 `$100/月`）
- 超预算处理：日志告警 + 可选阻断
- 单次请求费用超过阈值时输出 `warn` 日志

### 4.4 Provider 扩展
- 新增 Provider 只需在 `src/providers/` 添加配置
- Provider 必须实现标准接口：
  ```typescript
  interface IProvider {
    chat(request: ChatRequest): Promise<ChatResponse>;
    embed(request: EmbedRequest): Promise<EmbedResponse>;
  }
  ```

---

## ⚙️ 5. 配置管理

### 5.1 配置文件层级
```
conf/
├── default.json      # 默认配置（必选）
├── development.json  # 开发环境覆盖
├── production.json   # 生产环境覆盖
└── routing.json      # 路由规则
```
- 环境变量优先级 > 配置文件

### 5.2 配置验证
- 使用 `zod` 或 `joi` 验证配置格式
- 启动时检查必填字段

### 5.3 敏感配置
- API Keys、数据库密码等放环境变量，不放配置文件
- 配置文件示例 `conf/example.json` 不含真实密钥

---

## ✅ 6. 验证与执行流程

在执行任何代码编写、文件操作或模型调用前，**必须**完成以下自我检查：

### 6.1 操作前检查
1. **看见**：我已经完整阅读了 `AGENTS.md` 和当前任务相关的所有文件
2. **验证**：我计划的操作是否违反任一条规则？
   - 若违反 → 立即停止，向用户说明违反的规则编号及理由
   - 若不违反 → 列出操作步骤清单
3. **执行**：按步骤执行，每完成一步输出简要日志

### 6.2 提交前检查
- [ ] `npm run build` 通过
- [ ] `npm run test` 通过（允许跳过新增测试）
- [ ] 无新增 `any` 类型
- [ ] 无硬编码的敏感信息

---

## 🚫 7. 禁止行为清单（绝对红线）

| # | 禁止行为 | 违规后果 |
|---|----------|----------|
| 1 | 修改 `AGENTS.md` 本身（除非用户明确要求） | 立即停止 |
| 2 | 在 `main` 分支上直接 `git push`（必须通过 PR） | 代码回滚 |
| 3 | 删除 `.env` 或 `conf/` 下的任何文件 | 需确认 |
| 4 | 执行 `rm -rf`、`drop database` 等危险命令 | 需确认 |
| 5 | 在代码中嵌入硬编码的 fallback API Key | 代码删除 |
| 6 | 使用 `any` 类型绕过类型检查 | 需重构 |
| 7 | 空 catch 块 `catch(e) {}` | 需修复 |
| 8 | 在日志中打印原始请求体 | 需脱敏 |

---

## 📋 8. Feature List（待实现）

以下功能尚未实现，允许生成 TODO：

- [ ] 多 Provider 路由（OpenAI / DeepSeek / Anthropic）
- [ ] API Key 鉴权中间件
- [ ] 请求日志中间件
- [ ] 基于 Token 的限流
- [ ] 流式响应支持
- [ ] 用量统计
- [ ] Docker 部署支持

---

## 📖 9. 参考文档

- TypeScript 严格模式指南
- Portkey AI Gateway 架构
- OpenAI API 兼容性
- RESTful API 最佳实践

---

> **版本**：v1.0
> **更新**：2025-05-11
> **维护**：Sisyphus