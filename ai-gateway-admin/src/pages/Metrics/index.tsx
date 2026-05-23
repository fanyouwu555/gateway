import { useEffect, useState } from 'react'
import { Card, Row, Col, Segmented, Table, Button, Space, message, Tabs } from 'antd'
import { ReloadOutlined, DownloadOutlined } from '@ant-design/icons'
import StatsCard from '@/components/common/StatsCard'
import LineChart from '@/components/Charts/LineChart'
import BarChart from '@/components/Charts/BarChart'
import {
  getDashboardOverview,
  getTimeSeriesMetrics,
  getProviderStats,
  getAllTenantsStats,
} from '@/services/api'
import type { DashboardOverview, TimeSeriesPoint, ProviderStats, TenantStatsDetail } from '@/types'

const TIME_RANGES = [
  { label: '最近 24 小时', value: 24, granularity: 'hour' as const },
  { label: '最近 7 天', value: 24 * 7, granularity: 'day' as const },
  { label: '最近 30 天', value: 24 * 30, granularity: 'day' as const },
]

const Metrics: React.FC = () => {
  const [loading, setLoading] = useState(false)
  const [timeRange, setTimeRange] = useState(24)
  const [activeTab, setActiveTab] = useState('provider')
  const [overviewData, setOverviewData] = useState<DashboardOverview | null>(null)
  const [timeSeriesData, setTimeSeriesData] = useState<TimeSeriesPoint[]>([])
  const [providerStatsData, setProviderStatsData] = useState<ProviderStats[]>([])
  const [tenantStatsData, setTenantStatsData] = useState<TenantStatsDetail[]>([])

  const fetchData = async () => {
    setLoading(true)
    const now = Date.now()
    const start = now - timeRange * 60 * 60 * 1000
    const granularity = TIME_RANGES.find((t) => t.value === timeRange)?.granularity || 'hour'

    try {
      const [overview, timeSeries, providerStats, tenantStats] = await Promise.all([
        getDashboardOverview(start, now),
        getTimeSeriesMetrics(granularity, start, now),
        getProviderStats(start, now),
        getAllTenantsStats(start, now),
      ])

      setOverviewData(overview as unknown as DashboardOverview)
      setTimeSeriesData(timeSeries as unknown as TimeSeriesPoint[])
      setProviderStatsData(providerStats as unknown as ProviderStats[])
      setTenantStatsData(tenantStats as unknown as TenantStatsDetail[])
    } catch (error) {
      message.error('获取统计数据失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchData()
  }, [timeRange])

  function formatTokens(tokens: number): string {
    if (tokens >= 1000000) return `${(tokens / 1000000).toFixed(2)}M`
    if (tokens >= 1000) return `${(tokens / 1000).toFixed(2)}K`
    return tokens.toLocaleString()
  }

  const handleExportCSV = () => {
    const lines: string[] = []
    lines.push('AI Gateway Metrics Export')
    lines.push(`Generated at: ${new Date().toLocaleString()}`)
    lines.push('')

    lines.push('Provider Statistics')
    lines.push('Provider,Requests,Tokens,Cost,Avg Latency,Success Rate')
    for (const p of providerStatsData) {
      lines.push(`${p.provider},${p.total_requests},${p.total_tokens},${p.total_cost?.toFixed(4) || 0},${p.avg_duration_ms}ms,${(p.success_rate * 100).toFixed(2)}%`)
    }
    lines.push('')

    lines.push('Tenant Statistics')
    lines.push('Tenant ID,Requests,Tokens,Cost,Avg Latency,Success Rate')
    for (const t of tenantStatsData) {
      lines.push(`${t.tenant_id},${t.total_requests},${t.total_tokens},${t.total_cost?.toFixed(4) || 0},${t.avg_duration_ms}ms,${(t.success_rate * 100).toFixed(2)}%`)
    }

    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `metrics-${new Date().toISOString().slice(0, 10)}.csv`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
    message.success('CSV 导出成功')
  }

  const tokenTrendData = timeSeriesData.map((item) => ({
    time: item.time_label,
    value: item.total_tokens,
  }))

  // Provider 表格列
  const providerColumns = [
    { title: 'Provider', dataIndex: 'provider', key: 'provider' },
    { title: '请求数', dataIndex: 'total_requests', key: 'total_requests', render: (v: number) => v.toLocaleString() },
    { title: 'Token', dataIndex: 'total_tokens', key: 'total_tokens', render: (v: number) => formatTokens(v) },
    { title: '成本 ($)', dataIndex: 'total_cost', key: 'total_cost', render: (v: number) => `$${v.toFixed(4)}` },
    { title: '平均延迟', dataIndex: 'avg_duration_ms', key: 'avg_duration_ms', render: (v: number) => `${v}ms` },
    { title: '成功率', dataIndex: 'success_rate', key: 'success_rate', render: (v: number) => `${(v * 100).toFixed(2)}%` },
  ]

  // Tenant 表格列
  const tenantColumns = [
    { title: '租户 ID', dataIndex: 'tenant_id', key: 'tenant_id' },
    { title: '请求数', dataIndex: 'total_requests', key: 'total_requests', render: (v: number) => v.toLocaleString() },
    { title: 'Token', dataIndex: 'total_tokens', key: 'total_tokens', render: (v: number) => formatTokens(v) },
    { title: '成本 ($)', dataIndex: 'total_cost', key: 'total_cost', render: (v: number) => `$${v.toFixed(4)}` },
    { title: '平均延迟', dataIndex: 'avg_duration_ms', key: 'avg_duration_ms', render: (v: number) => `${v}ms` },
    { title: '成功率', dataIndex: 'success_rate', key: 'success_rate', render: (v: number) => `${(v * 100).toFixed(2)}%` },
  ]

  const statsData = [
    { title: '总 Token', value: formatTokens(overviewData?.total_tokens || 0), suffix: '' },
    { title: '总成本', value: (overviewData?.total_cost || 0).toFixed(2), prefix: '$' },
    { title: '总请求', value: (overviewData?.total_requests || 0).toLocaleString(), suffix: '' },
    { title: '平均延迟', value: overviewData?.avg_duration_ms?.toString() || '0', suffix: 'ms' },
  ]

  return (
    <div className="page-container">
      <div className="page-header">
        <h2>用量统计</h2>
        <Space>
          <div onClick={(e) => e.stopPropagation()}>
            <Segmented
              options={TIME_RANGES.map((t) => ({ label: t.label, value: t.value }))}
              value={timeRange}
              onChange={(v) => setTimeRange(v as number)}
            />
          </div>
          <Button icon={<DownloadOutlined />} onClick={handleExportCSV}>导出 CSV</Button>
          <Button icon={<ReloadOutlined />} onClick={fetchData} loading={loading}>
            刷新
          </Button>
        </Space>
      </div>

      {/* 统计卡片 */}
      <Row gutter={[16, 16]}>
        {statsData.map((item, index) => (
          <Col xs={24} sm={12} lg={6} key={index}>
            <StatsCard title={item.title} value={item.value} suffix={item.suffix} prefix={item.prefix} />
          </Col>
        ))}
      </Row>

      {/* 图表 */}
      <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
        <Col xs={24} md={24} lg={16}>
          <Card title="Token 趋势">
            <LineChart data={tokenTrendData} yAxisLabel="Token" />
          </Card>
        </Col>
        <Col xs={24} md={24} lg={8}>
          <Card title="Provider 分布">
            <BarChart
              data={providerStatsData.map((p) => ({ name: p.provider, value: p.total_tokens }))}
              height={260}
              color="#52c41a"
            />
          </Card>
        </Col>
      </Row>

      {/* 详细数据 Tab */}
      <Card style={{ marginTop: 16 }}>
        <Tabs activeKey={activeTab} onChange={setActiveTab} items={[
          { key: 'provider', label: 'Provider 统计' },
          { key: 'tenant', label: '租户统计' },
        ]} />

        {activeTab === 'provider' && (
          <Table
            columns={providerColumns}
            dataSource={providerStatsData}
            rowKey="provider"
            pagination={false}
            loading={loading}
          />
        )}

        {activeTab === 'tenant' && (
          <Table
            columns={tenantColumns}
            dataSource={tenantStatsData}
            rowKey="tenant_id"
            pagination={false}
            loading={loading}
          />
        )}
      </Card>
    </div>
  )
}

export default Metrics
