# AI Gateway 测试指南

## 📋 目录

1. [单元测试](#单元测试)
2. [API 集成测试](#api-集成测试)
3. [WebSocket 实时测试](#websocket-实时测试)
4. [前端 E2E 测试](#前端-e2e-测试)
5. [一键启动测试环境](#一键启动测试环境)

---

## 🧪 单元测试

### 运行所有测试

```bash
cd d:\AGateWay\GateWay
npm test
```

### 运行特定模块测试

```bash
# 指标服务测试
npm test -- --testPathPattern="metrics"

# WebSocket 测试
npm test -- --testPathPattern="websocket"

# 中间件测试
npm test -- --testPathPattern="middleware"

# 路由测试
npm test -- --testPathPattern="routes"

# Provider 测试
npm test -- --testPathPattern="providers"
```

### 带覆盖率报告

```bash
npm test -- --coverage
```

---

## 🔗 API 集成测试

### 前置条件

1. 后端服务已启动 (`npm run dev`)
2. 端口 3000 可访问

### 运行测试

```powershell
# PowerShell
.\tests\e2e-api-test.ps1
```

### 测试内容

| 测试项 | 端点 | 说明 |
|--------|------|------|
| 健康检查 | `GET /health` | 公共 API |
| 根路径信息 | `GET /` | 公共 API |
| Dashboard 概览 | `GET /v1/usage/overview` | 管理 API |
| 时间序列数据 | `GET /v1/usage/timeseries` | 管理 API |
| Provider 统计 | `GET /v1/usage/providers` | 管理 API |
| 租户统计 | `GET /v1/usage/tenants` | 管理 API |
| 状态码统计 | `GET /v1/usage/status-codes` | 管理 API |
| 缓存统计 | `GET /v1/cache` | 管理 API |
| 清理缓存 | `POST /v1/cache/clean` | 管理 API |
| 会话列表 | `GET /v1/sessions` | 管理 API |
| 清理会话 | `POST /v1/sessions/clean` | 管理 API |
| 租户列表 | `GET /v1/tenants` | 管理 API |
| 创建租户 | `POST /v1/tenants` | 管理 API |
| WebSocket 连接 | `ws:///v1/ws/admin` | 实时连接 |

---

## 🔌 WebSocket 实时测试

### 前置条件

1. 后端服务已启动
2. 已安装 Node.js
3. 已安装 ws 包（如需）: `npm install -g ws`

### 运行测试

```bash
node tests/websocket-realtime-test.mjs
```

### 测试流程

1. 建立 WebSocket 连接到 `ws://localhost:3000/v1/ws/admin`
2. 发送 2 个测试聊天请求
3. 监听实时推送事件
4. 验证是否收到 `request_complete` 事件

### 预期输出

```
========================================
  WebSocket 实时推送测试
========================================

[1/3] 正在连接 WebSocket...
  ✓ WebSocket 已连接

[2/3] 发送测试聊天请求...
  已发送请求 #1: deepseek-chat
  已发送请求 #2: gpt-4o-mini

[3/3] 等待接收实时事件...
  ✓ 收到实时事件 #1: request_complete
     Provider: deepseek, Model: deepseek-chat
     延迟: 45ms, Token: 12

========================================
  测试总结
========================================
  发送请求: 2
  收到事件: 2

  ✅ WebSocket 实时推送功能正常!
```

---

## 🚀 一键启动测试环境

### 快速启动前后端

```powershell
.\tests\start-test-env.ps1
```

### 功能

- 自动启动后端服务 (端口 3000)
- 自动启动前端服务 (端口 3001)
- 健康检查等待服务就绪
- 显示服务访问地址和后续测试命令

### 停止服务

```powershell
Stop-Job -Name AI-Gateway-Backend
Stop-Job -Name AI-Gateway-Frontend
```

---

## 🎨 前端 E2E 测试

### 手动测试清单

访问 `http://localhost:3001`，按以下步骤测试：

#### 1. Dashboard 页面
- [ ] 页面正常加载，无控制台错误
- [ ] 统计卡片显示正确数据
- [ ] 图表正确渲染（请求趋势、饼图、柱状图）
- [ ] WebSocket 连接状态显示绿色"实时连接"
- [ ] 发送 API 请求后，实时日志表格自动新增一行

#### 2. Metrics 页面
- [ ] 时间范围选择器工作正常
- [ ] Provider 统计表格有数据
- [ ] 切换到租户统计 Tab 正常显示
- [ ] 图表数据正确更新

#### 3. Tenants 页面
- [ ] 租户列表正常显示
- [ ] 点击"创建租户"弹窗正常
- [ ] 查看租户详情抽屉正常
- [ ] 删除功能正常（带确认弹窗）

#### 4. Providers 页面
- [ ] Provider 列表正常显示
- [ ] 状态指示器（在线/离线）正确
- [ ] 请求量、延迟、成功率数据展示

#### 5. Settings 页面
- [ ] 基本设置表单可编辑
- [ ] 限流设置可调整
- [ ] 故障转移设置正常
- [ ] 保存配置生效

---

## 📊 测试结果模板

```
========================================
           测试报告汇总
========================================

✅ 单元测试: 283 passed
   - 测试覆盖率: 59.1% Statements

✅ API 集成测试: 12/12 passed
   - 公共 API: 2/2
   - 管理指标 API: 5/5
   - 缓存管理 API: 2/2
   - 租户管理 API: 2/2
   - WebSocket 连接: 1/1

✅ WebSocket 实时测试: 2/2 events received
   - 发送请求: 2
   - 接收事件: 2
   - 延迟: < 100ms

✅ 前端 E2E 测试: 15/15 passed
   - Dashboard: 5/5
   - Metrics: 3/3
   - Tenants: 4/4
   - Providers: 2/2
   - Settings: 1/1

========================================
  整体状态: ✅ 所有测试通过!
========================================
```

---

## 🔧 常见问题

### 1. WebSocket 连接失败

**问题**: 连接被拒绝或 401 未授权

**解决**:
- 检查后端服务是否正常运行
- 确认 `conf/default.json` 中配置了 admin API Key
- 测试使用的 Key: `test-admin-key`

### 2. 前端 API 请求 404

**问题**: 前端调用 `/api/*` 返回 404

**解决**:
- 检查 Vite 代理配置 (`ai-gateway-admin/vite.config.ts`)
- 确认后端在 3000 端口运行
- 检查 CORS 配置

### 3. Jest 测试后无法退出

**问题**: 测试结束后进程挂起

**解决**:
- 这是正常现象，由异步操作导致
- 使用 `--forceExit` 参数强制退出: `npm test -- --forceExit`

---

## 🎯 快速开始

```powershell
# 1. 一键启动测试环境
.\tests\start-test-env.ps1

# 2. 运行 API 集成测试
.\tests\e2e-api-test.ps1

# 3. 运行 WebSocket 实时测试
node tests\websocket-realtime-test.mjs

# 4. 手动浏览前端测试
# 打开浏览器访问: http://localhost:3001
```
