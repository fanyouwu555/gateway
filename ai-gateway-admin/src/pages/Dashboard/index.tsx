import { useEffect, useState, useCallback, useRef } from 'react'
import { Row, Col, Card, Table, Button, Tag, Select, Badge, message } from 'antd'
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
  getRequestLogs,
} from '@/services/api'
import { wsService } from '@/services/websocket'
import type { DashboardOverview, TimeSeriesPoint, ProviderStats, RequestLogItem, HealthData, CacheStats } from '@/types'

interface EnhancedLog extends RequestLogItem {
  _key: string
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
  const [healthData, setHealthData] = useState<HealthData | null>(null)
  const [cacheStats, setCacheStats] = useState<CacheStats | null>(null)
  const [overviewData, setOverviewData] = useState<DashboardOverview | null>(null)
  const [timeSeriesData, setTimeSeriesData] = useState<TimeSeriesPoint[]>([])
  const [providerStatsData, setProviderStatsData] = useState<ProviderStats[]>([])
  const [statusCodeData, setStatusCodeData] = useState<Record<string, number>>({})
  const [wsConnected, setWsConnected] = useState(false)
  const [recentLogs, setRecentLogs] = useState<EnhancedLog[]>([])
  const [logTotal, setLogTotal] = useState(0)
  const [logPage, setLogPage] = useState(1)
  const [logLoading, setLogLoading] = useState(false)
  const seenRequestIds = useRef(new Set<string>())

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
      setOverviewData(overview)
      setTimeSeriesData(timeSeries)
      setProviderStatsData(providerStats)
      setStatusCodeData(statusCode)
    } catch (error) {
      message.error('加载数据失败，请检查网络连接')
      console.error('Failed to fetch data:', error)
    } finally {
      setLoading(false)
    }

    // Fetch recent request logs
    try {
      setLogLoading(true)
      const logResult = await getRequestLogs({
        start,
        end: now,
        limit: 15,
        offset: 0,
      })
      setRecentLogs(logResult.logs.map((log) => ({ ...log, _key: log.request_id })))
      setLogTotal(logResult.total)
      setLogPage(1)
    } catch (err) {
      console.error('Failed to fetch request logs:', err)
    } finally {
      setLogLoading(false)
    }
  }

  const handleWebSocketMessage = useCallback((raw: unknown) => {
    const data = raw as Record<string, unknown>
    // 注意：不处理 metrics_update 覆盖 overviewData，
    // 因为 WebSocket 推送的是最近 1 小时数据，而 Dashboard 可能显示 24h/7d，
    // 统计口径不一致会导致数据闪烁（如 1h 内无请求时全为 0）。
    // overviewData 只由 fetchData() 在 timeRange 切换或刷新时更新。
    if (data.type === 'chat.completion.chunk' || data.event === 'request_complete') {
      const requestId = (data.request_id as string)
      if (requestId) {
        if (seenRequestIds.current.has(requestId)) return
        seenRequestIds.current.add(requestId)
      }
      const log: EnhancedLog = {
        _key: requestId || Math.random().toString(36).substr(2, 9),
        request_id: requestId || '',
        timestamp: Date.now(),
        method: 'POST',
        path: '/v1/chat/completions',
        provider: (data.provider as string) || '',
        model: (data.model as string) || 'unknown',
        status_code: data.error ? 500 : 200,
        duration_ms: (data.duration_ms as number) || 0,
        prompt_tokens: (data.prompt_tokens as number) || 0,
        completion_tokens: (data.completion_tokens as number) || 0,
        total_tokens: (data.total_tokens as number) || 0,
        cost: (data.cost as number) || 0,
        tenant_id: (data.tenant_id as string) || '',
      }
      setRecentLogs((prev) => [log, ...prev.slice(0, 14)])
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

  const formatTime = (ts: number) => {
    const d = new Date(ts)
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`
  }

  const columns = [
    { title: '时间', dataIndex: 'timestamp', key: 'timestamp', width: 160, render: (v: number) => formatTime(v) },
    { title: '供应商', dataIndex: 'provider', key: 'provider', width: 120 },
    { title: '计费模型', dataIndex: 'model', key: 'model', width: 160 },
    {
      title: '输入', dataIndex: 'prompt_tokens', key: 'prompt_tokens', width: 80,
      render: (v: number | undefined) => v?.toLocaleString() || '-',
    },
    {
      title: '输出', dataIndex: 'completion_tokens', key: 'completion_tokens', width: 80,
      render: (v: number | undefined) => v?.toLocaleString() || '-',
    },
    {
      title: '成本', dataIndex: 'cost', key: 'cost', width: 100,
      render: (v: number | undefined) => v !== undefined ? `$${v.toFixed(4)}` : '-',
    },
    {
      title: '用时', dataIndex: 'duration_ms', key: 'duration_ms', width: 100,
      render: (v: number) => `${v}ms`,
    },
    {
      title: '状态', dataIndex: 'status_code', key: 'status_code', width: 80,
      render: (v: number) => (
        <Tag color={v >= 200 && v < 300 ? 'green' : 'red'}>{v}</Tag>
      ),
    },
    {
      title: '来源', dataIndex: 'tenant_id', key: 'tenant_id', width: 120,
      render: (v: string | undefined) => v || '-',
    },
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

  function formatUptime(seconds: number): string {
    if (seconds < 60) return '刚刚启动'
    if (seconds < 3600) return `${Math.ceil(seconds / 60)} 分钟`
    const hours = Math.floor(seconds / 3600)
    const mins = Math.ceil((seconds % 3600) / 60)
    return mins > 0 ? `${hours} 小时 ${mins} 分钟` : `${hours} 小时`
  }

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
        <Col xs={24} md={24} lg={16}>
          <Card title="请求量趋势">
            <LineChart data={requestTrendData} yAxisLabel="请求数" />
          </Card>
        </Col>
        <Col xs={24} md={24} lg={8}>
          <Card title="Provider 分布">
            <PieChart data={providerDistribution} height={260} />
          </Card>
        </Col>
      </Row>

      {/* 图表区域 - 第二行 */}
      <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
        <Col xs={24} md={12} lg={12}>
          <Card title="Token 消耗趋势">
            <LineChart data={tokenTrendData} yAxisLabel="Token 数" />
          </Card>
        </Col>
        <Col xs={24} md={12} lg={12}>
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
          rowKey="_key"
          size="small"
          loading={logLoading}
          pagination={{
            current: logPage,
            pageSize: 15,
            total: logTotal,
            showSizeChanger: false,
            onChange: async (page) => {
              setLogPage(page)
              setLogLoading(true)
              const now = Date.now()
              const start = now - timeRange * 60 * 60 * 1000
              try {
                const result = await getRequestLogs({
                  start,
                  end: now,
                  limit: 15,
                  offset: (page - 1) * 15,
                })
                setRecentLogs(result.logs.map((log) => ({ ...log, _key: log.request_id })))
                setLogTotal(result.total)
              } catch (err) {
                console.error('Failed to fetch request logs:', err)
                message.error('加载请求日志失败')
              } finally {
                setLogLoading(false)
              }
            },
          }}
          scroll={{ x: 1000 }}
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
              {(healthData?.services?.providers || []).map((p) => (
                <div key={p.name}>
                  {p.name}: <Tag color="green">{p.status}</Tag>
                </div>
              ))}
            </div>
          </Card>
        </Col>
        <Col xs={24} md={8}>
          <Card title="系统信息">
            <div style={{ padding: '8px 0' }}>
              <div>版本: {healthData?.version || '1.0.0'}</div>
              <div>运行时间: {formatUptime(healthData?.uptime || 0)}</div>
              <div>活跃租户: {overviewData?.total_tenants || 0} 个</div>
            </div>
          </Card>
        </Col>
      </Row>
    </div>
  )
}

export default Dashboard