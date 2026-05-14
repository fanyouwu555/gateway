import { useEffect, useState } from 'react'
import { Row, Col, Card, Table, Button, Tag } from 'antd'
import { ReloadOutlined } from '@ant-design/icons'
import StatsCard from '@/components/common/StatsCard'
import LineChart from '@/components/Charts/LineChart'
import PieChart from '@/components/Charts/PieChart'
import { getHealth, getCacheStats, getUsage } from '@/services/api'

interface RecentLog {
  id: string
  time: string
  model: string
  status: 'success' | 'error'
  latency: number
  tokens: number
}

const Dashboard: React.FC = () => {
  const [loading, setLoading] = useState(false)
  const [healthData, setHealthData] = useState<any>(null)
  const [cacheStats, setCacheStats] = useState<any>(null)
  const [usageData, setUsageData] = useState<any>(null)

  const fetchData = async () => {
    setLoading(true)
    try {
      const [health, cache, usage] = await Promise.all([getHealth(), getCacheStats(), getUsage()])
      setHealthData(health)
      setCacheStats(cache)
      setUsageData(usage)
    } catch (error) {
      console.error('Failed to fetch data:', error)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchData()
  }, [])

  // 模拟数据
  const requestTrendData = [
    { time: '00:00', value: 120 },
    { time: '04:00', value: 80 },
    { time: '08:00', value: 250 },
    { time: '12:00', value: 380 },
    { time: '16:00', value: 320 },
    { time: '20:00', value: 280 },
    { time: '24:00', value: 150 },
  ]

  const providerDistribution = [
    { name: 'OpenAI', value: 45 },
    { name: 'DeepSeek', value: 30 },
    { name: 'Anthropic', value: 25 },
  ]

  const recentLogs: RecentLog[] = [
    { id: '1', time: '10:32:15', model: 'gpt-4o', status: 'success', latency: 230, tokens: 1234 },
    { id: '2', time: '10:32:14', model: 'deepseek-chat', status: 'success', latency: 180, tokens: 856 },
    { id: '3', time: '10:32:13', model: 'claude-3.5-sonnet', status: 'success', latency: 450, tokens: 2100 },
    { id: '4', time: '10:32:11', model: 'gpt-4o-mini', status: 'error', latency: 1200, tokens: 0 },
    { id: '5', time: '10:32:10', model: 'deepseek-coder', status: 'success', latency: 200, tokens: 1560 },
  ]

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

  const statsData = [
    { title: '总请求数', value: usageData?.requests || '125,432', trend: 12.5 },
    { title: 'Token 消耗', value: '1.2M', trend: 8.3, suffix: '' },
    { title: '平均延迟', value: '245', trend: -5.2, suffix: 'ms' },
    { title: '错误率', value: '0.12', trend: -0.03, suffix: '%' },
  ]

  return (
    <div className="page-container">
      <div className="page-header">
        <h2>AI Gateway 仪表盘</h2>
        <Button icon={<ReloadOutlined />} onClick={fetchData} loading={loading}>
          刷新
        </Button>
      </div>

      {/* 统计卡片 */}
      <Row gutter={[16, 16]}>
        {statsData.map((item, index) => (
          <Col xs={24} sm={12} lg={6} key={index}>
            <StatsCard title={item.title} value={item.value} trend={item.trend} suffix={item.suffix} />
          </Col>
        ))}
      </Row>

      {/* 图表区域 */}
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
              <div>命中率: {cacheStats?.hit_rate || 0}%</div>
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
            </div>
          </Card>
        </Col>
      </Row>
    </div>
  )
}

export default Dashboard