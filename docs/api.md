# AI Gateway API 文档

## 目录

- [认证](#认证)
- [公共端点](#公共端点)
- [Chat Completions](#chat-completions)
- [Embeddings](#embeddings)
- [Models](#models)
- [管理 API](#管理-api)
- [错误处理](#错误处理)
- [智能路由](#智能路由)
- [WebSocket](#websocket)

---

## 认证

所有受保护的端点需要在请求头中携带 API Key：

```
Authorization: Bearer <your-api-key>
```

管理 API 需要使用管理员 API Key。

---

## 公共端点

### GET /health

健康检查端点，返回网关服务状态。

**响应示例：**

```json
{
  "status": "ok",
  "timestamp": 1735689600000,
  "uptime": 3600.5,
  "version": "1.0.0",
  "services": {
    "providers": [
      {
        "name": "openai",
        "status": "active",
        "has_api_key": true,
        "base_url": "https://api.openai.com/v1"
      }
    ],
    "cache": {
      "size": 42,
      "hit_rate": 0.85
    },
    "sessions": {
      "total": 128
    }
  }
}
```

### GET /metrics

Prometheus 格式的指标数据。

### GET /

根端点，返回可用端点列表。

**响应示例：**

```json
{
  "name": "AI Gateway",
  "version": "1.0.0",
  "endpoints": {
    "health": "/health",
    "chat": "/v1/chat/completions",
    "embed": "/v1/embeddings",
    "models": "/v1/models"
  }
}
```

---

## Chat Completions

### POST /v1/chat/completions

创建聊天补全，兼容 OpenAI API 格式。

**请求头：**

| 头 | 描述 | 示例 |
|---|---|---|
| `Authorization` | API Key | `Bearer gateway-test-key-123` |
| `X-Provider` | 强制指定 Provider | `openai` |
| `X-Routing-Strategy` | 路由策略 | `cost`, `latency`, `quality`, `balance` |
| `X-Session-Id` | 会话 ID，用于上下文管理 | `session-123` |
| `X-Tenant-Id` | 租户 ID | `default` |
| `Content-Type` | 必须是 | `application/json` |

**请求体：**

| 字段 | 类型 | 必填 | 描述 |
| --- | --- | --- | --- |
| `model` | string | ✅ | 模型 ID 或别名，如 `gpt-4o`, `fast` |
| `messages` | array | 条件 | 消息数组（与 `template_id` 二选一） |
| `messages[].role` | string | ✅ | `system`, `user`, `assistant` |
| `messages[].content` | string | ✅ | 消息内容 |
| `messages[].name` | string | - | 名称标识 |
| `template_id` | string | 条件 | 提示词模板 ID（与 `messages` 二选一） |
| `template_variables` | object | - | 模板变量键值对 |
| `temperature` | number | - | 采样温度 0-2，默认 1 |
| `top_p` | number | - | 核采样 0-1，默认 1 |
| `max_tokens` | number | - | 最大生成 token 数 |
| `stream` | boolean | - | 是否流式响应，默认 false |
| `stop` | string \| string[] | - | 停止序列 |
| `presence_penalty` | number | - | 存在惩罚 -2 到 2 |
| `frequency_penalty` | number | - | 频率惩罚 -2 到 2 |
| `user` | string | - | 终端用户标识 |
| `tools` | array | - | Function Calling 工具定义 |
| `tool_choice` | object | - | 工具选择策略 |

**请求示例（标准消息）：**

```json
{
  "model": "gpt-4o",
  "messages": [
    {
      "role": "system",
      "content": "You are a helpful assistant."
    },
    {
      "role": "user",
      "content": "Hello!"
    }
  ],
  "temperature": 0.7,
  "max_tokens": 500
}
```

**请求示例（使用模板）：**

```json
{
  "model": "gpt-4o",
  "template_id": "translate",
  "template_variables": {
    "target_language": "日文",
    "content": "Hello world"
  }
}
```

**标准响应（非流式）：**

```json
{
  "id": "chatcmpl-abc123",
  "object": "chat.completion",
  "created": 1735689600,
  "model": "gpt-4o",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "Hello! How can I help you today?"
      },
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 20,
    "completion_tokens": 10,
    "total_tokens": 30
  }
}
```

**流式响应（SSE）：**

当 `stream: true` 时，服务器以 Server-Sent Events 格式返回数据：

```
data: {"id":"chatcmpl-123","object":"chat.completion.chunk","created":1735689600,"model":"gpt-4o","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}

data: {"id":"chatcmpl-123","object":"chat.completion.chunk","created":1735689600,"model":"gpt-4o","choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}

data: [DONE]
```

---

## Embeddings

### POST /v1/embeddings

创建向量嵌入。

**请求体：**

| 字段 | 类型 | 必填 | 描述 |
| --- | --- | --- | --- |
| `model` | string | ✅ | 嵌入模型 ID |
| `input` | string \| string[] | ✅ | 输入文本或文本数组 |
| `encoding_format` | string | - | `float` 或 `base64` |
| `dimensions` | number | - | 输出向量维度 |

**请求示例：**

```json
{
  "model": "text-embedding-3-small",
  "input": "Hello world",
  "encoding_format": "float"
}
```

**响应示例：**

```json
{
  "object": "list",
  "data": [
    {
      "object": "embedding",
      "embedding": [0.001, 0.002, -0.003, ...],
      "index": 0
    }
  ],
  "model": "text-embedding-3-small",
  "usage": {
    "prompt_tokens": 2,
    "total_tokens": 2
  }
}
```

---

## Models

### GET /v1/models

获取可用模型列表。模型列表来自路由配置（`routing.rules`），并按当前 API Key 的 `allowed_models` 白名单过滤。

**响应字段说明：**

| 字段 | 类型 | 描述 |
| --- | --- | --- |
| `id` | string | 模型标识符 |
| `object` | string | 固定为 `"model"` |
| `owned_by` | string | 提供该模型的 Provider 名称 |
| `context_window` | number? | 上下文窗口大小（tokens），来自路由规则的 `max_tokens` |
| `pricing` | object? | 定价信息（每 1M tokens 美元），来自 `pricing` 配置 |
| `pricing.input` | number | 输入价格 |
| `pricing.output` | number | 输出价格 |
| `default_model` | string? | 当前 Key 的默认模型（仅当 Key 设置了 `default_model` 时出现） |

**响应示例：**

```json
{
  "object": "list",
  "data": [
    {
      "id": "ark-code-latest",
      "object": "model",
      "owned_by": "volcano",
      "context_window": 128000,
      "pricing": { "input": 0.5, "output": 2.0 }
    },
    {
      "id": "kimi-for-coding",
      "object": "model",
      "owned_by": "kimi-code",
      "context_window": 128000,
      "pricing": { "input": 0.5, "output": 2.0 }
    }
  ],
  "default_model": "ark-code-latest"
}
```

---

## 管理 API

所有管理 API 需要管理员 API Key。

### 认证验证

#### GET /v1/auth/verify

验证当前 API Key 是否有效，返回 Key 信息。

**响应示例：**

```json
{
  "valid": true,
  "is_admin": false,
  "tenant_id": "default"
}
```

### 用量统计

#### GET /v1/usage

获取租户用量统计。

**查询参数：**

| 参数 | 类型 | 描述 |
| --- | --- | --- |
| `tenant_id` | string | 租户 ID，默认 `default` |

**响应示例：**

```json
{
  "total_requests": 1000,
  "total_tokens": 50000,
  "total_cost": 25.50,
  "breakdown_by_provider": {
    "openai": { "requests": 800, "tokens": 40000, "cost": 20.00 },
    "anthropic": { "requests": 200, "tokens": 10000, "cost": 5.50 }
  }
}
```

#### GET /v1/usage/range

获取指定时间范围的用量统计。

**查询参数：**

| 参数 | 类型 | 描述 |
| --- | --- | --- |
| `start` | number | 起始时间戳（ms） |
| `end` | number | 结束时间戳（ms） |

#### GET /v1/usage/timeseries

获取时间序列用量数据。

**查询参数：**

| 参数 | 类型 | 描述 |
| --- | --- | --- |
| `granularity` | string | 聚合粒度：`hour`、`day`、`week`、`month` |
| `start` | number | 起始时间戳（ms） |
| `end` | number | 结束时间戳（ms） |

#### GET /v1/usage/overview

获取 Dashboard 概览数据。

**查询参数：**

| 参数 | 类型 | 描述 |
| --- | --- | --- |
| `start` | number | 起始时间戳（ms） |
| `end` | number | 结束时间戳（ms） |

**响应示例：**

```json
{
  "total_requests": 5000,
  "total_tokens": 250000,
  "total_cost": 125.00,
  "avg_latency_ms": 450,
  "success_rate": 0.98
}
```

#### GET /v1/usage/providers

获取按 Provider 分组的统计。

**查询参数：**

| 参数 | 类型 | 描述 |
| --- | --- | --- |
| `start` | number | 起始时间戳（ms） |
| `end` | number | 结束时间戳（ms） |

#### GET /v1/usage/tenants

获取所有租户的统计。

**查询参数：**

| 参数 | 类型 | 描述 |
| --- | --- | --- |
| `start` | number | 起始时间戳（ms） |
| `end` | number | 结束时间戳（ms） |

#### GET /v1/usage/status-codes

获取 HTTP 状态码分布。

**查询参数：**

| 参数 | 类型 | 描述 |
| --- | --- | --- |
| `start` | number | 起始时间戳（ms） |
| `end` | number | 结束时间戳（ms） |

### 配额状态

#### GET /v1/quota

获取租户配额状态。

**响应示例：**

```json
{
  "tenant_id": "default",
  "monthly_budget": 100,
  "current_usage": 25.50,
  "remaining": 74.50,
  "usage_percent": 0.255,
  "status": "ok"
}
```

### 缓存管理

#### GET /v1/cache

获取缓存统计。

**响应示例：**

```json
{
  "size": 42,
  "max_size": 1000,
  "hit_rate": 0.85,
  "hits": 170,
  "misses": 30
}
```

#### POST /v1/cache/clean

清空缓存。

**响应示例：**

```json
{
  "cleaned": true
}
```

### 会话管理

#### GET /v1/sessions

获取会话统计。

**响应示例：**

```json
{
  "total_sessions": 128,
  "active_sessions": 45
}
```

#### POST /v1/sessions/clean

清理过期会话。

**响应示例：**

```json
{
  "cleaned": 32
}
```

### 路由状态

#### GET /v1/router/status

获取智能路由状态。

**响应示例：**

```json
{
  "strategy": "roundRobin",
  "active_providers": ["openai", "anthropic", "deepseek"],
  "health_status": {
    "openai": "healthy",
    "anthropic": "healthy",
    "deepseek": "degraded"
  }
}
```

### 提示词模板

#### GET /v1/prompts

获取提示词模板列表。

**响应示例：**

```json
{
  "templates": [
    {
      "id": "translation",
      "name": "翻译助手",
      "description": "专业翻译模板"
    }
  ]
}
```

#### GET /v1/prompts/:id

获取指定模板详情。

#### POST /v1/prompts

创建新模板。

**请求体：**

```json
{
  "id": "translation",
  "name": "翻译助手",
  "description": "将文本翻译成指定语言",
  "template": "请将以下内容翻译成{{target_language}}：\n\n{{content}}",
  "variables": ["target_language", "content"],
  "default_values": {
    "target_language": "中文"
  }
}
```

#### PUT /v1/prompts/:id

更新模板。

#### DELETE /v1/prompts/:id

删除模板。

#### POST /v1/prompts/:id/render

渲染模板，返回替换变量后的文本。

**请求体：**

```json
{
  "variables": {
    "target_language": "日文",
    "content": "Hello world"
  }
}
```

**响应示例：**

```json
{
  "rendered": "请将以下内容翻译成日文：\n\nHello world"
}
```

### 告警规则

#### GET /v1/alerts

获取告警规则列表。

#### POST /v1/alerts

创建告警规则。

**请求体：**

```json
{
  "id": "error-rate-alert",
  "name": "Error Rate Alert",
  "metric": "error_rate",
  "threshold": 0.1,
  "condition": "gt",
  "webhook_url": "https://example.com/webhook",
  "enabled": true,
  "cooldown_seconds": 300
}
```

| 字段 | 类型 | 必填 | 描述 |
| --- | --- | --- | --- |
| `id` | string | 是 | 规则唯一标识 |
| `name` | string | 是 | 规则名称 |
| `metric` | string | 是 | 监控指标：`error_rate`、`avg_latency_ms`、`total_requests` |
| `threshold` | number | 是 | 阈值 |
| `condition` | string | - | 比较条件：`gt`（大于）或 `lt`（小于），默认 `gt` |
| `webhook_url` | string | 是 | Webhook 地址 |
| `enabled` | boolean | - | 是否启用，默认 `true` |
| `cooldown_seconds` | number | - | 冷却时间（秒），默认 `300` |

#### DELETE /v1/alerts/:id

删除告警规则。

#### POST /v1/alerts/:id/enable

启用告警规则。

#### POST /v1/alerts/:id/disable

禁用告警规则。

#### POST /v1/alerts/evaluate

手动触发一次告警评估。

### 模型别名

#### GET /v1/config/aliases

获取当前模型别名映射。

**响应示例：**

```json
{
  "aliases": {
    "fast": "gpt-4o-mini",
    "smart": "gpt-4o"
  }
}
```

#### PUT /v1/config/aliases

更新模型别名映射。

**请求体：**

```json
{
  "fast": "gpt-4o-mini",
  "smart": "gpt-4o"
}
```

### 租户管理

#### GET /v1/tenants

获取所有租户列表。

#### POST /v1/tenants

创建新租户。

**请求体：**

```json
{
  "name": "acme-corp",
  "status": "active",
  "plan": "pro",
  "settings": {
    "default_provider": "openai",
    "allowed_providers": ["openai", "anthropic"],
    "webhook_url": "https://example.com/webhook"
  },
  "limits": {
    "daily_requests": 10000,
    "daily_tokens": 1000000,
    "monthly_cost": 500,
    "max_api_keys": 10,
    "concurrent_requests": 100
  }
}
```

#### GET /v1/tenants/:id

获取指定租户信息。

#### GET /v1/tenants/:id/stats

获取指定租户统计。

#### PUT /v1/tenants/:id

更新租户配置。

#### DELETE /v1/tenants/:id

删除租户。

### API Key 管理

#### GET /v1/tenants/:id/keys

获取租户的 API Key 列表。

#### POST /v1/tenants/:id/keys

创建新的 API Key。

**请求体：**

```json
{
  "name": "production-key",
  "expires_at": 1767225600000
}
```

#### DELETE /v1/keys/:key

删除指定 API Key。

#### PUT /v1/tenants/:id/keys/:keyHash

更新 API Key 策略。

**请求体：**

```json
{
  "allowed_models": ["gpt-4o", "gpt-4o-mini"],
  "rate_limit_qps": 20,
  "rate_limit_burst": 40,
  "monthly_budget": 50,
  "max_tokens_per_request": 4096,
  "default_model": "gpt-4o-mini",
  "metadata": { "env": "production" }
}
```

#### GET /v1/tenants/:id/keys/:keyHash/usage

获取指定 API Key 的使用统计。

### 配置管理

#### GET /v1/config

获取网关配置（敏感信息已隐藏）。

**响应示例：**

```json
{
  "port": 3000,
  "host": "0.0.0.0",
  "log_level": "info",
  "routing": [...],
  "auth": {
    "enabled": true,
    "api_key_count": 1
  },
  "rate_limit": {
    "enabled": true,
    "qps": 10,
    "burst": 20
  },
  "providers": {
    "openai": {
      "provider": "openai",
      "base_url": "https://api.openai.com/v1",
      "timeout": 30000
    }
  }
}
```

#### PUT /v1/config

更新网关配置。

### WebSocket 管理

#### GET /v1/ws

获取 WebSocket 连接统计。

#### POST /v1/ws/clean

清理 WebSocket 连接。

### 插件管理

#### GET /v1/plugins

获取已注册插件列表。

#### POST /v1/plugins/register

注册新插件（在沙箱中执行插件代码）。

**请求体：**

```json
{
  "code": "module.exports = { name: 'my-plugin', type: 'request', priority: 10, onRequest: (c, data) => data };"
}
```

#### DELETE /v1/plugins/:id

卸载插件。

#### POST /v1/plugins/:id/enable

启用插件。

#### POST /v1/plugins/:id/disable

禁用插件。

### 模型定价

#### GET /v1/pricing

获取所有模型定价及覆盖。

**响应示例：**

```json
{
  "default": {
    "gpt-4o": { "input": 2.5, "output": 10.0 },
    "gpt-4o-mini": { "input": 0.15, "output": 0.6 }
  },
  "overrides": {}
}
```

#### PUT /v1/pricing/:model

设置模型定价覆盖。

**请求体：**

```json
{
  "input": 2.5,
  "output": 10.0
}
```

#### DELETE /v1/pricing/:model

删除模型定价覆盖，恢复默认定价。

### 请求日志

#### GET /v1/request-logs

查询请求日志，支持多种过滤和分页。

**查询参数：**

| 参数 | 类型 | 描述 |
| --- | --- | --- |
| `provider` | string | 按 Provider 过滤 |
| `model` | string | 按模型过滤 |
| `status_code` | number | 按 HTTP 状态码过滤 |
| `tenant_id` | string | 按租户过滤 |
| `start` | number | 起始时间戳（ms） |
| `end` | number | 结束时间戳（ms） |
| `limit` | number | 每页条数，默认 50 |
| `offset` | number | 偏移量，默认 0 |

**响应示例：**

```json
{
  "logs": [
    {
      "request_id": "req-abc123",
      "timestamp": 1735689600000,
      "provider": "openai",
      "model": "gpt-4o",
      "status_code": 200,
      "duration_ms": 450,
      "prompt_tokens": 20,
      "completion_tokens": 10,
      "total_tokens": 30,
      "cost": 0.00125
    }
  ],
  "total": 100,
  "limit": 50,
  "offset": 0
}
```

### 模型发现

#### GET /v1/admin/discover-models

查询各 Provider 支持的模型列表（管理员工具）。结果缓存 5 分钟。

**查询参数：**

| 参数 | 类型 | 描述 |
| --- | --- | --- |
| `provider` | string? | 指定 Provider 名称，不传则查询所有 Provider |

**查询单个 Provider 响应示例：**

```json
{
  "provider": "openai",
  "models": [
    {
      "id": "gpt-4o",
      "owned_by": "openai",
      "context_window": 128000,
      "created": 1706745938
    },
    {
      "id": "gpt-4o-mini",
      "owned_by": "openai",
      "context_window": 128000,
      "created": 1721172741
    }
  ]
}
```

**查询所有 Provider 响应示例：**

```json
{
  "openai": {
    "models": [
      { "id": "gpt-4o", "owned_by": "openai", "context_window": 128000 }
    ]
  },
  "anthropic": {
    "models": [
      { "id": "claude-3.5-sonnet-20241022", "owned_by": "anthropic", "context_window": 200000, "max_output_tokens": 8192 }
    ]
  },
  "volcano": {
    "error": "Discovery not supported"
  }
}
```

**错误码：**

| 状态码 | 错误码 | 描述 |
| --- | --- | --- |
| 404 | `provider_not_found` | Provider 未注册 |
| 404 | `provider_not_configured` | Provider 未配置（缺少 base_url / api_key） |
| 501 | `discovery_not_supported` | Provider 不支持模型发现 |
| 502 | `discovery_failed` | Provider API 调用失败 |

**Provider 发现能力支持情况：**

| Provider | 支持方式 | 备注 |
| --- | --- | --- |
| OpenAI / DeepSeek / Groq / Mistral / Moonshot / Cohere / Together / xAI / Azure OpenAI | `GET /v1/models` API | OpenAI-compatible 自动支持 |
| Google Gemini | `GET /v1/models` API | Gemini 格式自动转换 |
| Anthropic | 硬编码已知模型 | Anthropic 无公开模型列表 API |
| Volcano / Kimi-Code | 取决于 API | 可能不支持 |
| Dynamic Provider | `endpoints.models` 配置 | 需在配置中声明端点路径 |

### 会话日志

#### GET /v1/conversations

查询对话会话列表。

**查询参数：**

| 参数 | 类型 | 描述 |
| --- | --- | --- |
| `model` | string | 按模型过滤 |
| `tenant_id` | string | 按租户过滤 |
| `start` | number | 起始时间戳（ms） |
| `end` | number | 结束时间戳（ms） |
| `limit` | number | 每页条数 |
| `offset` | number | 偏移量 |

#### GET /v1/conversations/:session_id

获取会话详情，包含元数据和对话轮次。

#### GET /v1/conversations/:session_id/stats

获取会话统计信息。

#### DELETE /v1/conversations/:session_id

删除指定会话。

---

## 错误处理

所有错误响应遵循统一格式：

```json
{
  "error": {
    "message": "错误描述",
    "type": "错误类型",
    "code": "错误代码",
    "param": "相关参数（可选）"
  }
}
```

**常见错误码：**

| HTTP 状态码 | 类型 | 描述 |
|---|---|---|
| 400 | `invalid_request_error` | 请求格式错误 |
| 401 | `authentication_error` | 认证失败 |
| 403 | `permission_error` | 权限不足 |
| 404 | `invalid_request_error` | 路由未找到 |
| 429 | `rate_limit_error` | 限流触发 |
| 500 | `internal_error` | 服务器内部错误 |
| 502 | `provider_error` | Provider 请求失败 |

---

## 智能路由

通过 `X-Routing-Strategy` 头指定路由策略：

| 策略 | 描述 |
|---|---|
| `cost` | 成本优先，选择最便宜的 Provider |
| `latency` | 延迟优先，选择响应最快的 Provider |
| `quality` | 质量优先，选择模型质量最高的 |
| `balance` | 综合平衡，综合考虑成本和质量 |

**示例：**

```bash
curl -X POST http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer gateway-test-key-123" \
  -H "X-Routing-Strategy: cost" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o","messages":[{"role":"user","content":"hi"}]}'
```

---

## WebSocket

### GET /v1/ws/connect

建立 WebSocket 连接，用于实时流式通信。

**认证方式：**

API Key 通过 `Sec-WebSocket-Protocol` 头传递，格式为 `gateway-token-{api_key}`。

**连接参数：**

| 参数 | 描述 |
|---|---|
| `tenant_id` | 租户 ID（URL 查询参数） |

**示例：**

```javascript
const ws = new WebSocket(
  'ws://localhost:3000/v1/ws/connect?tenant_id=default',
  ['gateway-token-your-api-key']
);
```

**消息格式：**

```json
{
  "type": "chat.completion",
  "payload": {
    "model": "gpt-4o",
    "messages": [...]
  }
}
```

---

## cURL 示例

**Chat Completion：**

```bash
curl -X POST http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer gateway-test-key-123" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4o",
    "messages": [{"role": "user", "content": "Hello!"}],
    "temperature": 0.7
  }'
```

**流式 Chat：**

```bash
curl -X POST http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer gateway-test-key-123" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4o",
    "messages": [{"role": "user", "content": "Hello!"}],
    "stream": true
  }'
```

**Embedding：**

```bash
curl -X POST http://localhost:3000/v1/embeddings \
  -H "Authorization: Bearer gateway-test-key-123" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "text-embedding-3-small",
    "input": "Hello world"
  }'
```

**健康检查：**

```bash
curl http://localhost:3000/health
```
