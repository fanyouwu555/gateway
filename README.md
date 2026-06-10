# AI Gateway

一个轻量级、高性能的多提供商 AI 网关，基于 Hono 框架构建，支持 OpenAI、Anthropic、DeepSeek、Mistral、Groq、Google 等主流大模型提供商。

## ✨ 特性

- 🚀 **多提供商统一接口** - 兼容 OpenAI API 协议，一次适配所有模型
- 🎯 **智能路由** - 支持成本优先、延迟优先、质量优先、综合平衡四种策略
- 🔄 **自动故障转移** - Provider 故障时自动切换到备用节点
- ⚖️ **负载均衡** - 支持轮询、随机、加权、最少请求等负载均衡策略
- 💾 **内置缓存** - LRU 内存缓存 + Redis 分布式缓存
- 📊 **实时指标** - Prometheus 格式指标，支持 Grafana 可视化
- 🛡️ **安全防护** - API Key 认证、租户隔离、速率限制
- 🚦 **插件系统** - Guardrail、请求处理、响应处理插件
- 📦 **对话日志** - 自动记录对话历史，支持查询和统计
- 📈 **用量统计** - 按租户、按 Provider、按模型的细粒度统计
- 🔍 **语义缓存** - LSH 相似度匹配，提升重复查询性能
- 🧮 **Token 限流** - 基于 Token 消耗的精细化速率限制
- 🏷️ **模型池** - 多模型组合路由策略
- 🔐 **虚拟 Key** - 独立配额和限制的 API Key 策略
- 📡 **分布式追踪** - OpenTelemetry 追踪支持
- 🛡️ **内容安全** - PII 检测、Prompt Injection 防护、敏感词过滤
- 🔌 **WebSocket 支持** - 实时流式通信
- 📝 **提示词模板** - 支持 `{{var}}` 变量替换，预设常用模板
- 🚨 **告警引擎** - 基于阈值的自动告警，支持 Webhook 通知
- 🔗 **模型别名** - 自定义模型名映射，简化调用
- ⚡ **连接池优化** - HTTP Keep-Alive + 连接池，提升吞吐量

## 🏗️ 架构概览

```
┌─────────────────────────────────────────────────────────┐
│                      HTTP Client                        │
└────────────────────────────┬────────────────────────────┘
                             │
┌────────────────────────────▼────────────────────────────┐
│                    Hono Web Server                       │
├──────────────────────────────────────────────────────────┤
│  CORS  │  Logger  │  Metrics  │  Auth  │  Rate Limit    │
└────────────────────────────┬────────────────────────────┘
                             │
┌────────────────────────────▼────────────────────────────┐
│                    Request Pipeline                      │
├─────────────┬──────────────┬──────────────┬─────────────┤
│  Validation │  Guardrails  │  Routing     │  Plugins    │
└─────────────┴──────────────┴──────────────┴─────────────┘
                             │
          ┌──────────────────┼──────────────────┐
          ▼                  ▼                  ▼
┌─────────────┐    ┌─────────────┐    ┌─────────────┐
│   OpenAI    │    │  Anthropic  │    │  DeepSeek   │
└─────────────┘    └─────────────┘    └─────────────┘
         │                │                 │
         └────────────────┴─────────────────┘
                          │
┌─────────────────────────▼───────────────────────────────┐
│  Cache Layer  │  Session Store  │  Metrics Collector   │
└─────────────────────────────────────────────────────────┘
```

## 🚀 快速开始

### 环境要求

- Node.js >= 20
- Redis (可选，用于分布式缓存和状态持久化)

### 安装

```bash
# 克隆项目
git clone <repository-url>
cd GateWay

# 安装依赖
npm install
```

### 配置

复制并编辑配置文件：

```bash
# 使用默认配置即可启动
# 编辑 conf/default.json 添加你的 API Key
```

配置示例：

```json
{
  "port": 3000,
  "host": "0.0.0.0",
  "providers": {
    "openai": {
      "provider": "openai",
      "base_url": "https://api.openai.com/v1",
      "api_key": "your-openai-key",
      "timeout": 30000
    }
  }
}
```

### 启动

```bash
# 开发模式（热重载）
npm run dev

# 构建
npm run build

# 生产模式
npm start
```

### 验证

```bash
# 健康检查
curl http://localhost:3000/health

# 测试聊天
curl -X POST http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer gateway-test-key-123" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o","messages":[{"role":"user","content":"Hello!"}]}'
```

## 📚 文档

- [API 文档](docs/api.md) - 完整的 API 端点参考
- [管理 UI 设计](docs/AI-Gateway-UI-Design.md) - 管理后台界面设计

## 🧪 测试

```bash
# 运行所有测试
npm test

# 运行测试并生成覆盖率报告
npm test -- --coverage

# TypeScript 类型检查
npx tsc --noEmit

# ESLint 检查
npm run lint
```

## 🏭 CI/CD

项目已配置 GitHub Actions CI，每次推送和 PR 都会自动运行：

- ESLint 代码检查
- TypeScript 类型检查
- 完整测试套件（含 Redis 集成测试）
- 项目构建验证

## 🤝 支持的提供商

| Provider | 状态 | Chat | Embedding | Streaming | Function Call | Vision |
|---|---|---|---|---|---|---|
| OpenAI | ✅ 完整 | ✅ | ✅ | ✅ | ✅ | ✅ |
| Anthropic | ✅ 完整 | ✅ | ❌ | ✅ | ✅ | ✅ |
| DeepSeek | ✅ 完整 | ✅ | ❌ | ✅ | ✅ | ❌ |
| Mistral | ✅ 完整 | ✅ | ✅ | ✅ | ✅ | ❌ |
| Groq | ✅ 完整 | ✅ | ❌ | ✅ | ✅ | ❌ |
| Google | ✅ 完整 | ✅ | ❌ | ✅ | ✅ | ✅ |
| Moonshot | ✅ 完整 | ✅ | ❌ | ✅ | ✅ | ❌ |
| Volcano | ✅ 完整 | ✅ | ❌ | ✅ | ✅ | ❌ |
| Kimi Code | ✅ 完整 | ✅ | ❌ | ✅ | ✅ | ❌ |
| Cohere | ✅ 完整 | ✅ | ✅ | ✅ | ✅ | ❌ |
| Together AI | ✅ 完整 | ✅ | ❌ | ✅ | ✅ | ❌ |
| xAI (Grok) | ✅ 完整 | ✅ | ❌ | ✅ | ✅ | ❌ |
| Azure OpenAI | ✅ 完整 | ✅ | ✅ | ✅ | ✅ | ✅ |

## 🎯 智能路由策略

### 1. 成本优先 (`cost`)
选择调用成本最低的 Provider，适合对成本敏感的场景。

### 2. 延迟优先 (`latency`)
选择响应速度最快的 Provider，适合实时交互场景。

### 3. 质量优先 (`quality`)
选择模型质量最高的 Provider，适合对输出质量要求高的场景。

### 4. 综合平衡 (`balance`)
综合考虑成本、延迟和质量，找到最佳平衡点。

**使用方式：**

```bash
curl -X POST http://localhost:3000/v1/chat/completions \
  -H "X-Routing-Strategy: cost" \
  -H "Authorization: Bearer gateway-test-key-123" \
  ...
```

## 🔧 配置选项

### 完整配置项

| 配置项 | 默认值 | 描述 |
|---|---|---|
| `port` | 3000 | 服务端口 |
| `host` | `0.0.0.0` | 监听地址 |
| `log_level` | `info` | 日志级别 |
| `auth.enabled` | `true` | 是否启用认证 |
| `rate_limit.enabled` | `true` | 是否启用限流 |
| `rate_limit.qps` | 10 | 每秒请求数限制 |
| `rate_limit.burst` | 20 | 突发请求限制 |
| `cache.enabled` | `true` | 是否启用缓存 |
| `cache.ttl` | 3600000 | 缓存 TTL (毫秒) |
| `failover.enabled` | `false` | 是否启用故障转移 |
| `model_aliases` | `{}` | 模型别名映射 |

### 环境变量

| 变量 | 默认值 | 描述 |
|---|---|---|
| `STORAGE_TYPE` | `memory` | 全局存储类型 (memory / redis) |
| `CACHE_STORAGE` | `memory` | 缓存存储类型 |
| `METRICS_STORAGE` | `memory` | 指标存储类型 |
| `RATE_LIMIT_STORAGE` | `memory` | 限流存储类型 |
| `HTTP_POOL_SIZE` | `100` | 每个目标地址最大连接数 |
| `HTTP_KEEP_ALIVE` | `true` | 是否启用 HTTP Keep-Alive |
| `HTTP_KEEP_ALIVE_TIMEOUT` | `60000` | Keep-Alive 超时 (毫秒) |

## 📊 监控指标

网关暴露 Prometheus 格式指标：

```bash
curl http://localhost:3000/metrics
```

包含指标：
- 请求计数（按端点、状态码、Provider）
- 请求延迟直方图
- 缓存命中率
- 活跃会话数
- 限流触发计数

## 🛡️ 安全特性

1. **API Key 认证** - 所有受保护端点需要 Bearer Token
2. **租户隔离** - 每个租户有独立的配额和统计
3. **速率限制** - 防止滥用的 QPS 限制
4. **请求验证** - Zod Schema 运行时验证
5. **无密钥日志** - Provider API Key 不会出现在日志中

## 🔌 插件系统

网关支持三种类型的插件：

1. **Guardrail 插件** - 请求前内容安全检查
2. **Request 插件** - 转换和增强请求
3. **Response 插件** - 处理和转换响应

## 🤝 贡献

欢迎提交 Issue 和 Pull Request！

## 📄 许可证

MIT License
