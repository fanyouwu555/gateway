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

获取可用模型列表。

**响应示例：**

```json
{
  "object": "list",
  "data": [
    {
      "id": "gpt-4o",
      "object": "model",
      "owned_by": "openai"
    },
    {
      "id": "claude-3-5-sonnet-20241022",
      "object": "model",
      "owned_by": "anthropic"
    }
  ]
}
```

---

## 管理 API

所有管理 API 需要管理员 API Key。

### 用量统计

#### GET /v1/usage

获取租户用量统计。

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

**连接参数：**

| 参数 | 描述 |
|---|---|
| `api_key` | API Key |
| `tenant_id` | 租户 ID |

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
