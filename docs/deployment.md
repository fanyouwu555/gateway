# AI Gateway 部署指南

> 支持 Docker、Kubernetes 原生和 Helm 三种部署方式。

---

## 1. 快速开始（Docker）

### 1.1 前置条件

- Docker Engine >= 24.0
- Docker Compose >= 2.20
- （可选）Redis 6.0+ — 生产环境强烈建议

### 1.2 最小配置

```bash
# 复制环境变量模板
cp .env.example .env

# 编辑 .env，至少配置以下项：
#   - OPENAI_API_KEY 或你需要的 Provider API Key
#   - API_KEYS（网关认证 Key）
#   - API_ADMIN_KEYS（管理后台 Key）
```

### 1.3 启动

```bash
docker compose up -d
```

服务将在 `http://localhost:3000` 启动。

### 1.4 验证

```bash
curl http://localhost:3000/health
```

### 1.5 构建（无缓存）

```bash
docker compose build --no-cache
docker compose up -d
```

---

## 2. Kubernetes 原生部署

### 2.1 前置条件

- Kubernetes >= 1.25
- kubectl 已配置集群访问
- （可选）Metrics Server — HPA 需要

### 2.2 配置 Secret

```bash
# 复制示例 Secret
cp k8s/secret.example.yaml k8s/secret.yaml

# 编辑 k8s/secret.yaml，填入 base64 编码的 API Keys
echo -n 'sk-gateway-key-1' | base64
# 将输出填入 secret.yaml 对应字段
```

### 2.3 一键部署

```bash
kubectl apply -f k8s/
```

包含的资源：
- `Namespace` — `ai-gateway`
- `ConfigMap` — 网关运行时配置
- `Secret` — 敏感凭据
- `Deployment` — 3 副本，滚动更新
- `Service` — ClusterIP + NodePort
- `HPA` — CPU > 70% 自动扩容（2–10 副本）

### 2.4 查看状态

```bash
kubectl get pods -n ai-gateway
kubectl get svc -n ai-gateway
kubectl get hpa -n ai-gateway
```

### 2.5 清理

```bash
kubectl delete -f k8s/
```

---

## 3. Helm 部署（推荐生产环境）

### 3.1 前置条件

- Helm >= 3.12

### 3.2 安装

```bash
# 使用默认 values
helm install ai-gateway ./helm/ai-gateway

# 或指定自定义 values
helm install ai-gateway ./helm/ai-gateway -f my-values.yaml
```

### 3.3 升级

```bash
helm upgrade ai-gateway ./helm/ai-gateway
```

### 3.4 卸载

```bash
helm uninstall ai-gateway
```

### 3.5 常用 values 覆盖

```yaml
# my-values.yaml
replicaCount: 5

image:
  tag: "latest"

env:
  OPENAI_API_KEY: "sk-xxx"
  API_KEYS: "sk-gateway-1,sk-gateway-2"
  STORAGE_TYPE: "redis"
  REDIS_URL: "redis://redis:6379/0"

hpa:
  enabled: true
  minReplicas: 5
  maxReplicas: 20
  targetCPUUtilizationPercentage: 70

ingress:
  enabled: true
  host: "gateway.example.com"
```

---

## 4. 环境变量速查表

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PORT` | `3000` | 服务端口 |
| `NODE_ENV` | `development` | 运行环境 |
| `LOG_LEVEL` | `info` | 日志级别 |
| `STORAGE_TYPE` | `memory` | 全局存储: `memory` \| `redis` |
| `REDIS_URL` | — | Redis 连接 URL |
| `API_KEYS` | — | 客户端 API Key（逗号分隔） |
| `API_ADMIN_KEYS` | — | 管理员 API Key（逗号分隔） |
| `HTTP_POOL_SIZE` | `100` | HTTP 连接池大小 |
| `HTTP_KEEP_ALIVE` | `true` | 连接保活 |
| `HTTP_KEEP_ALIVE_TIMEOUT` | `60000` | 保活超时(ms) |
| `CORS_ORIGIN` | `*` | CORS 来源 |

完整列表见 [.env.example](../.env.example)。

---

## 5. 生产检查清单

- [ ] Redis 已配置且可连接（`STORAGE_TYPE=redis`）
- [ ] 至少配置了 2 个 Provider API Key（failover 需要）
- [ ] 管理员 Key 与管理后台 Key 分离
- [ ] 日志目录已挂载持久卷（或 forwarded 到日志采集）
- [ ] HPA / 副本数 >= 2（高可用）
- [ ] 健康检查端点 `/health` 已纳入监控
- [ ] `NODE_ENV=production`
