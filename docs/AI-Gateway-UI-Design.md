# AI Gateway 管理后台 - UI 设计文档

> 版本: 1.0
> 日期: 2026-05-12
> 状态: 已批准

---

## 1. 技术选型

| 技术 | 选择 | 版本 |
|------|------|------|
| 框架 | React | 18.2.0 |
| UI 库 | Ant Design | 5.x |
| 构建工具 | Vite | 5.x |
| 图表库 | ECharts | 5.x |
| 状态管理 | Zustand | 4.x |
| 路由 | React Router | 6.x |
| HTTP 客户端 | Axios | 1.x |
| 工具库 | Day.js | 1.x |

---

## 2. 项目结构

```
ai-gateway-admin/
├── public/
│   └── favicon.svg
├── src/
│   ├── assets/                 # 静态资源
│   │   └── logo.svg
│   ├── components/             # 公共组件
│   │   ├── Layout/
│   │   │   ├── index.tsx       # 主布局
│   │   │   └── Sidebar.tsx     # 侧边栏
│   │   ├── Charts/
│   │   │   ├── LineChart.tsx   # 折线图
│   │   │   ├── PieChart.tsx    # 饼图
│   │   │   └── BarChart.tsx    # 柱状图
│   │   └── common/
│   │       ├── StatsCard.tsx   # 统计卡片
│   │       └── StatusTag.tsx   # 状态标签
│   ├── pages/                  # 页面
│   │   ├── Dashboard/
│   │   │   └── index.tsx       # 首页
│   │   ├── Providers/
│   │   │   └── index.tsx       # Provider管理
│   │   ├── Tenants/
│   │   │   └── index.tsx       # 租户管理
│   │   ├── Metrics/
│   │   │   └── index.tsx       # 用量统计
│   │   └── Settings/
│   │       └── index.tsx       # 系统设置
│   ├── hooks/                  # 自定义 Hooks
│   │   ├── useDashboard.ts
│   │   ├── useProviders.ts
│   │   ├── useTenants.ts
│   │   └── useConfig.ts
│   ├── services/               # API 服务
│   │   └── api.ts              # API 客户端
│   ├── stores/                 # 状态管理
│   │   └── useStore.ts         # Zustand store
│   ├── types/                  # 类型定义
│   │   └── index.ts
│   ├── utils/                  # 工具函数
│   │   └── format.ts           # 格式化工具
│   ├── App.tsx                 # 应用入口
│   ├── main.tsx                # 入口文件
│   └── index.css               # 全局样式
├── index.html
├── package.json
├── tsconfig.json
├── vite.config.ts
└── README.md
```

---

## 3. 页面设计

### 3.1 主布局

```
┌────────────────────────────────────────────────────────────────┐
│ Header (64px)                                    [用户] [设置] │
├────────────┬───────────────────────────────────────────────────┤
│            │                                                    │
│  Sidebar   │              Main Content                          │
│  (220px)   │              (padding: 24px)                       │
│            │                                                    │
│  Dashboard │                                                    │
│  Providers │                                                    │
│  Tenants   │                                                    │
│  Metrics   │                                                    │
│  Settings  │                                                    │
│            │                                                    │
└────────────┴───────────────────────────────────────────────────┘
```

**颜色方案**:
- 主色: #1890ff (Ant Design Blue)
- 背景: #ffffff
- 侧边栏背景: #001529 (深色)
- 侧边栏文字: #ffffff
- 边框: #f0f0f0

### 3.2 Dashboard 页面

**路径**: `/dashboard`

**功能**:
1. 统计卡片 (4个)
   - 总请求数
   - Token 消耗
   - 平均延迟
   - 错误率
2. 趋势图
   - 请求量趋势 (折线图)
   - Token 消耗趋势 (柱状图)
3. Provider 分布饼图
4. 最近请求日志表格

**组件结构**:
```tsx
<PageContainer>
  <Row gutter={[16, 16]}>
    <Col span={6}><StatsCard title="总请求数" value={125432} trend="+12.5%" /></Col>
    <Col span={6}><StatsCard title="Token 消耗" value="1.2M" trend="+8.3%" /></Col>
    <Col span={6}><StatsCard title="平均延迟" value="245ms" trend="-5.2%" /></Col>
    <Col span={6}><StatsCard title="错误率" value="0.12%" trend="-0.03%" /></Col>
  </Row>

  <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
    <Col span={16}><LineChart data={...} /></Col>
    <Col span={8}><PieChart data={...} /></Col>
  </Row>

  <Card style={{ marginTop: 16 }}>
    <Table columns={columns} dataSource={recentLogs} />
  </Card>
</PageContainer>
```

### 3.3 Provider 管理页面

**路径**: `/providers`

**功能**:
1. Provider 列表表格
2. 添加 Provider 弹窗
3. 编辑 Provider 抽屉

**表格列**:
| 列名 | 宽度 | 渲染 |
|------|------|------|
| 提供商 | 120px | 图标 + 名称 |
| 状态 | 80px | StatusTag (在线/离线) |
| 模型数 | 100px | 数字 |
| 请求量 | 120px | 数字 + 格式化 |
| 延迟 | 100px | 数字 + 单位 |
| 操作 | 150px | 编辑按钮 |

### 3.4 租户管理页面

**路径**: `/tenants`

**功能**:
1. 租户列表表格
2. 创建租户弹窗
3. 租户详情抽屉

**表格列**:
| 列名 | 宽度 | 渲染 |
|------|------|------|
| 名称 | 150px | 文本 |
| ID | 200px | 文本 |
| 计划 | 100px | Tag (Free/Pro/Enterprise) |
| 状态 | 100px | Tag (活跃/暂停/试用) |
| API Keys | 100px | 数字 |
| 操作 | 150px | 详情按钮 |

### 3.5 用量统计页面

**路径**: `/metrics`

**功能**:
1. 时间范围选择 (日/周/月)
2. 统计卡片
   - 输入 Token
   - 输出 Token
   - 总成本
3. Token 趋势柱状图
4. 模型使用明细表格

### 3.6 系统设置页面

**路径**: `/settings`

**功能**:
1. 基本设置 (端口、日志级别)
2. 限流设置 (QPS、突发容量)
3. 认证设置 (启用状态)
4. Failover 设置 (启用状态、阈值)
5. 保存/重置按钮

**表单字段**:
| 字段 | 类型 | 默认值 |
|------|------|--------|
| 端口 | InputNumber | 3000 |
| 日志级别 | Select | info |
| 限流启用 | Switch | true |
| QPS | InputNumber | 10 |
| 突发容量 | InputNumber | 20 |
| 认证启用 | Switch | true |
| Failover 启用 | Switch | false |
| 失败阈值 | InputNumber | 3 |

---

## 4. 组件设计

### 4.1 StatsCard 统计卡片

```typescript
interface StatsCardProps {
  title: string;           // 标题
  value: string | number; // 数值
  trend?: string;         // 变化趋势 (+12.5%)
  trendType?: 'up' | 'down' | 'neutral';
  prefix?: ReactNode;     // 图标前缀
  suffix?: string;        // 后缀 (如 ms, M)
}
```

**样式**:
- 背景: #ffffff
- 边框: 1px solid #f0f0f0
- 圆角: 8px
- 内边距: 24px
- 标题颜色: #8c8c8c
- 数值颜色: #262626
- 趋势颜色: up=#52c41a, down=#ff4d4f

### 4.2 LineChart 折线图

**配置**:
```typescript
interface LineChartProps {
  data: { time: string; value: number }[];
  height?: number;        // 默认 300
  color?: string;        // 默认 #1890ff
  showArea?: boolean;    // 默认 true (填充区域)
  showTooltip?: boolean; // 默认 true
  yAxisLabel?: string;   // Y轴单位
}
```

### 4.3 PieChart 饼图

**配置**:
```typescript
interface PieChartProps {
  data: { name: string; value: number }[];
  height?: number;       // 默认 300
  colors?: string[];     // 默认 ['#1890ff', '#52c41a', '#faad14', '#f5222d']
  showLegend?: boolean;  // 默认 true
  showTooltip?: boolean;// 默认 true
}
```

---

## 5. API 对接

### 5.1 现有 Gateway API

基于 `src/index.ts` 中暴露的管理接口:

```typescript
// 统计
GET  /stats              // 全局统计
GET  /metrics            // 用量统计

// 租户
GET  /tenants            // 租户列表
POST /tenants            // 创建租户
GET  /tenants/:id        // 租户详情
PUT  /tenants/:id        // 更新租户
DELETE /tenants/:id      // 删除租户

// API Keys
GET  /tenants/:id/keys  // 租户 API Keys
POST /tenants/:id/keys  // 创建 API Key
DELETE /keys/:keyId     // 删除 API Key

// 配置
GET  /config            // 获取配置
PUT  /config            // 更新配置

// Provider
GET  /providers         // Provider 列表
GET  /providers/:name   // Provider 详情

// 缓存
GET  /cache/stats       // 缓存统计
POST /cache/clean       // 清理缓存
```

### 5.2 API 客户端封装

```typescript
// services/api.ts
import axios from 'axios';

const api = axios.create({
  baseURL: import.meta.env.VITE_API_BASE_URL || 'http://localhost:3000',
  timeout: 10000,
});

// 添加请求拦截器 (如认证 token)
api.interceptors.request.use((config) => {
  const token = localStorage.getItem('api_token');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

export default api;
```

---

## 6. 状态管理

### 6.1 Zustand Store

```typescript
// stores/useStore.ts
import { create } from 'zustand';

interface AppState {
  // 统计数据
  stats: DashboardStats | null;
  setStats: (stats: DashboardStats) => void;

  // 租户列表
  tenants: Tenant[];
  setTenants: (tenants: Tenant[]) => void;

  // Provider 列表
  providers: Provider[];
  setProviders: (providers: Provider[]) => void;

  // 配置
  config: GatewayConfig | null;
  setConfig: (config: GatewayConfig) => void;

  // 加载状态
  loading: boolean;
  setLoading: (loading: boolean) => void;
}

export const useStore = create<AppState>((set) => ({
  stats: null,
  tenants: [],
  providers: [],
  config: null,
  loading: false,
  setStats: (stats) => set({ stats }),
  setTenants: (tenants) => set({ tenants }),
  setProviders: (providers) => set({ providers }),
  setConfig: (config) => set({ config }),
  setLoading: (loading) => set({ loading }),
}));
```

---

## 7. 样式规范

### 7.1 CSS 变量

```css
:root {
  /* 主色 */
  --color-primary: #1890ff;
  --color-primary-hover: #40a9ff;

  /* 背景 */
  --bg-layout: #ffffff;
  --bg-sidebar: #001529;

  /* 文字 */
  --color-text: #262626;
  --color-text-secondary: #8c8c8c;

  /* 边框 */
  --border-color: #f0f0f0;

  /* 间距 */
  --spacing-xs: 8px;
  --spacing-sm: 12px;
  --spacing-md: 16px;
  --spacing-lg: 24px;
}
```

### 7.2 响应式断点

| 断点 | 宽度 | 布局 |
|------|------|------|
| xs | < 576px | 单列 |
| sm | ≥ 576px | 单列 |
| md | ≥ 768px | 双列 |
| lg | ≥ 992px | 三列 |
| xl | ≥ 1200px | 四列 |

---

## 8. 验收标准

### 8.1 功能验收

- [ ] Dashboard 页面显示统计卡片和图表
- [ ] Provider 管理页面可增删改查
- [ ] 租户管理页面可增删改查
- [ ] 用量统计页面显示趋势图
- [ ] 系统设置页面可保存配置

### 8.2 视觉验收

- [ ] 与 Ant Design 风格一致
- [ ] 图表配色统一
- [ ] 响应式布局正常
- [ ] 加载状态显示正确

### 8.3 交互验收

- [ ] 表格排序/分页正常
- [ ] 表单验证正常
- [ ] 弹窗/抽屉交互正常
- [ ] 暂无数据状态正常

---

## 9. 后续扩展

- [ ] API Keys 管理页面
- [ ] 路由配置页面
- [ ] 缓存管理页面
- [ ] 请求日志查看器
- [ ] 实时 WebSocket 监控
- [ ] 暗黑模式支持