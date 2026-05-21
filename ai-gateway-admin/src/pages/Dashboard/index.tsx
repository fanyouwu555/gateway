import { useEffect, useState, useCallback } from 'react'
import { Row, Col, Card, Table, Button, Tag, Select, Badge } from 'antd'
import { ReloadOutlined, ClockCircleOutlined } from '@ant-design/icons'
import StatsCard from '@/components/common/StatsCard'
import LineChart from '@/components/Charts/LineChart'
import PieChart from '@/components/Charts/PieChart'
import BarChart from '@/components/Charts/BarChart'
import {
  getHealth,
  getCacheStats,
  getDashboardOverview,
  getTimeSeriesMetrics,
  getProviderStats,
  getStatusCodeStats,
} from '@/services/api'
import { wsService } from '@/services/websocket'
import type { DashboardOverview, TimeSeriesPoint, ProviderStats } from '@/types'

interface RecentLog {
  id: string
  time: string
  model: string
  status: 'success' | 'error'
  latency: number
  tokens: number
}

const TIME_RANGES = [
  { label: '最近 1 小时', value: 1 },
  { label: '最近 6 小时', value: 6 },
  { label: '最近 24 小时', value: 24 },
  { label: '最近 7 天', value: 24 * 7 },
  { label: '最近 30 天', value: 24 * 30 },
]

const Dashboard: React.FC = () => {
  const [loading, setLoading] = useState(false)
  const [timeRange, setTimeRange] = useState(24) // 默认 24 小时
  const [healthData, setHealthData] = useState<any>(null)
  const [cacheStats, setCacheStats] = useState<any>(null)
  const [overviewData, setOverviewData] = useState<DashboardOverview | null>(null)
  const [timeSeriesData, setTimeSeriesData] = useState<TimeSeriesPoint[]>([])
  const [providerStatsData, setProviderStatsData] = useState<ProviderStats[]>([])
  const [statusCodeData, setStatusCodeData] = useState<Record<string, number>>({})
  const [wsConnected, setWsConnected] = useState(false)
  const [recentLogs, setRecentLogs] = useState<RecentLog[]>([])

  const fetchData = async () => {
    setLoading(true)
    const now = Date.now()
    const start = now - timeRange * 60 * 60 * 1000

    try {
      const [health, cache, overview, timeSeries, providerStats, statusCode] = await Promise.all([
        getHealth(),
        getCacheStats(),
        getDashboardOverview(start, now),
        getTimeSeriesMetrics(timeRange <= 24 ? 'hour' : 'day', start, now),
        getProviderStats(start, now),
        getStatusCodeStats(start, now),
      ])

      setHealthData(health)
      setCacheStats(cache)
      setOverviewData(overview as unknown as DashboardOverview)
      setTimeSeriesData(timeSeries as unknown as TimeSeriesPoint[])
      setProviderStatsData(providerStats as unknown as ProviderStats[])
      setStatusCodeData(statusCode as unknown as Record<string, number>)
    } catch (error) {
      console.error('Failed to fetch data:', error)
    } finally {
      setLoading(false)
    }
  }

  const handleWebSocketMessage = useCallback((data: any) => {
    if (data.type === 'metrics_update' || data.event === 'metrics_update') {
      setOverviewData((prev) => ({
        ...prev,
        total_requests: data.total_requests ?? prev?.total_requests ?? 0,
        total_tokens: data.total_tokens ?? prev?.total_tokens ?? 0,
        total_cost: data.total_cost ?? prev?.total_cost ?? 0,
        avg_duration_ms: data.avg_duration_ms ?? prev?.avg_duration_ms ?? 0,
        success_rate: data.success_rate ?? prev?.success_rate ?? 0,
        error_rate: data.error_rate ?? prev?.error_rate ?? 0,
        total_providers: data.total_providers ?? prev?.total_providers ?? 0,
        total_models: data.total_models ?? prev?.total_models ?? 0,
        total_tenants: data.total_tenants ?? prev?.total_tenants ?? 0,
      }))
    } else if (data.type === 'chat.completion.chunk' || data.event === 'request_complete') {
      const log: RecentLog = {
        id: data.request_id || Math.random().toString(36).substr(2, 9),
        time: new Date().toLocaleTimeString(),
        model: data.model || 'unknown',
        status: data.error ? 'error' : 'success',
        latency: data.duration_ms || 0,
        tokens: data.total_tokens || 0,
      }
      setRecentLogs((prev) => [log, ...prev.slice(0, 9)])
    }
  }, [])

  // 数据获取 effect - 当 timeRange 改变时重新获取数据
  useEffect(() => {
    fetchData()
  }, [timeRange])

  // WebSocket 连接 effect - 只在组件挂载时连接
  useEffect(() => {
    wsService.connect('admin', {
      onOpen: () => setWsConnected(true),
      onClose: () => setWsConnected(false),
      onMessage: handleWebSocketMessage,
    })

    return () => {
      wsService.disconnect()
    }
  }, [handleWebSocketMessage])

  // 准备请求趋势图数据
  const requestTrendData = timeSeriesData.map((item) => ({
    time: item.time_label,
    value: item.total_requests,
  }))

  // 准备 Token 趋势图数据
  const tokenTrendData = timeSeriesData.map((item) => ({
    time: item.time_label,
    value: item.total_tokens,
  }))

  // 准备 Provider 分布数据
  const providerDistribution = providerStatsData.map((p) => ({
    name: p.provider,
    value: p.total_requests,
  }))

  // 准备状态码统计数据
  const statusCodeChartData = Object.entries(statusCodeData).map(([code, count]) => ({
    name: code,
    value: count,
  }))

  const columns = [
    { title: '时间', dataIndex: 'time', key: 'time', width: 100 },
    { title: '模型', dataIndex: 'model', key: 'model', width: 180 },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      width: 80,
      render: (status: string) => (
        <Tag color={status === 'success' ? 'green' : 'red'}>{status === 'success' ? '成功' : '失败'}</Tag>
      ),
    },
    { title: '延迟', dataIndex: 'latency', key: 'latency', width: 100, render: (v: number) => `${v}ms` },
    { title: 'Token', dataIndex: 'tokens', key: 'tokens', width: 100, render: (v: number) => v.toLocaleString() },
  ]

  // 统计卡片数据
  const statsData = [
    {
      title: '总请求数',
      value: overviewData?.total_requests?.toLocaleString() || '0',
      suffix: '',
      description: `${overviewData?.total_providers || 0} 个 Provider`,
    },
    {
      title: 'Token 消耗',
      value: formatTokens(overviewData?.total_tokens || 0),
      suffix: '',
      description: `${overviewData?.total_models || 0} 个模型`,
    },
    {
      title: '平均延迟',
      value: overviewData?.avg_duration_ms?.toString() || '0',
      suffix: 'ms',
      description: '',
    },
    {
      title: '成功率',
      value: ((overviewData?.success_rate || 0) * 100).toFixed(2),
      suffix: '%',
      description: `错误率: ${((overviewData?.error_rate || 0) * 100).toFixed(2)}%`,
    },
  ]

  function formatTokens(tokens: number): string {
    if (tokens >= 1000000) return `${(tokens / 1000000).toFixed(2)}M`
    if (tokens >= 1000) return `${(tokens / 1000).toFixed(2)}K`
    return tokens.toString()
  }

  return (
    <div className="page-container">
      <div className="page-header">
        <h2>AI Gateway 仪表盘</h2>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          <Badge status={wsConnected ? 'success' : 'error'} text={wsConnected ? '实时连接' : '已断开'} />
          <Select
            style={{ width: 160 }}
            value={timeRange}
            onChange={setTimeRange}
            options={TIME_RANGES}
            suffixIcon={<ClockCircleOutlined />}
          />
          <Button icon={<ReloadOutlined />} onClick={fetchData} loading={loading}>
            刷新
          </Button>
        </div>
      </div>

      {/* 统计卡片 */}
      <Row gutter={[16, 16]}>
        {statsData.map((item, index) => (
          <Col xs={24} sm={12} lg={6} key={index}>
            <StatsCard
              title={item.title}
              value={item.value}
              suffix={item.suffix}
              description={item.description}
            />
          </Col>
        ))}
      </Row>

      {/* 图表区域 - 第一行 */}
      <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
        <Col xs={24} lg={16}>
          <Card title="请求量趋势">
            <LineChart data={requestTrendData} yAxisLabel="请求数" />
          </Card>
        </Col>
        <Col xs={24} lg={8}>
          <Card title="Provider 分布">
            <PieChart data={providerDistribution} height={260} />
          </Card>
        </Col>
      </Row>

      {/* 图表区域 - 第二行 */}
      <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
        <Col xs={24} lg={12}>
          <Card title="Token 消耗趋势">
            <LineChart data={tokenTrendData} yAxisLabel="Token 数" />
          </Card>
        </Col>
        <Col xs={24} lg={12}>
          <Card title="状态码分布">
            <BarChart data={statusCodeChartData} />
          </Card>
        </Col>
      </Row>

      {/* 最近请求 */}
      <Card title="最近请求" style={{ marginTop: 16 }}>
        <Table
          columns={columns}
          dataSource={recentLogs}
          rowKey="id"
          pagination={false}
          size="small"
        />
      </Card>

      {/* 服务状态 */}
      <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
        <Col xs={24} md={8}>
          <Card title="缓存统计">
            <div style={{ padding: '8px 0' }}>
              <div>缓存大小: {cacheStats?.size || 0}</div>
              <div>命中率: {((cacheStats?.hit_rate || 0) * 100).toFixed(2)}%</div>
            </div>
          </Card>
        </Col>
        <Col xs={24} md={8}>
          <Card title="Provider 状态">
            <div style={{ padding: '8px 0' }}>
              {healthData?.services?.providers?.map((p: any) => (
                <div key={p.name}>
                  {p.name}: <Tag color="green">{p.status}</Tag>
                </div>
              )) || '加载中...'}
            </div>
          </Card>
        </Col>
        <Col xs={24} md={8}>
          <Card title="系统信息">
            <div style={{ padding: '8px 0' }}>
              <div>版本: {healthData?.version || '1.0.0'}</div>
              <div>运行时间: {Math.floor((healthData?.uptime || 0) / 3600)}h</div>
              <div>活跃租户: {overviewData?.total_tenants || 0} 个</div>
            </div>
          </Card>
        </Col>
      </Row>
    </div>
  )
}

export default Dashboard