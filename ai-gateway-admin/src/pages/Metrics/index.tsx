import { useEffect, useState } from 'react'
import { Card, Row, Col, Segmented, Table, Button, Space, message } from 'antd'
import { ReloadOutlined, DownloadOutlined } from '@ant-design/icons'
import StatsCard from '@/components/common/StatsCard'
import LineChart from '@/components/Charts/LineChart'
import BarChart from '@/components/Charts/BarChart'
import { getUsage } from '@/services/api'

interface ModelUsage {
  model: string
  input_tokens: number
  output_tokens: number
  total_tokens: number
  cost: number
  requests: number
  percentage: number
}

const Metrics: React.FC = () => {
  const [loading, setLoading] = useState(false)
  const [timeRange, setTimeRange] = useState<string>('day')

  const fetchUsage = async () => {
    setLoading(true)
    try {
      await getUsage()
    } catch (error) {
      message.error('获取用量失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchUsage()
  }, [timeRange])

  // 模拟数据
  const tokenTrendData = [
    { time: '01日', value: 45000 },
    { time: '02日', value: 52000 },
    { time: '03日', value: 48000 },
    { time: '04日', value: 61000 },
    { time: '05日', value: 55000 },
    { time: '06日', value: 67000 },
    { time: '07日', value: 72000 },
  ]

  const modelUsage: ModelUsage[] = [
    { model: 'gpt-4o', input_tokens: 450000, output_tokens: 230000, total_tokens: 680000, cost: 65.0, requests: 12500, percentage: 52 },
    { model: 'deepseek-chat', input_tokens: 250000, output_tokens: 120000, total_tokens: 370000, cost: 35.0, requests: 8500, percentage: 28 },
    { model: 'claude-3.5-sonnet', input_tokens: 123456, output_tokens: 62108, total_tokens: 185564, cost: 23.45, requests: 3200, percentage: 20 },
  ]

  const columns = [
    { title: '模型', dataIndex: 'model', key: 'model' },
    { title: '输入 Token', dataIndex: 'input_tokens', key: 'input_tokens', render: (v: number) => v.toLocaleString() },
    { title: '输出 Token', dataIndex: 'output_tokens', key: 'output_tokens', render: (v: number) => v.toLocaleString() },
    { title: '总 Token', dataIndex: 'total_tokens', key: 'total_tokens', render: (v: number) => v.toLocaleString() },
    { title: '成本 ($)', dataIndex: 'cost', key: 'cost', render: (v: number) => `$${v.toFixed(2)}` },
    { title: '请求数', dataIndex: 'requests', key: 'requests', render: (v: number) => v.toLocaleString() },
    { title: '占比', dataIndex: 'percentage', key: 'percentage', render: (v: number) => `${v}%` },
  ]

  const statsData = [
    { title: '输入 Token', value: '823,456', suffix: '' },
    { title: '输出 Token', value: '412,108', suffix: '' },
    { title: '总成本', value: '123.45', prefix: '$' },
    { title: '总请求', value: '24,200', suffix: '' },
  ]

  return (
    <div className="page-container">
      <div className="page-header">
        <h2>用量统计</h2>
        <Space>
          <Segmented
            options={[
              { label: '日', value: 'day' },
              { label: '周', value: 'week' },
              { label: '月', value: 'month' },
            ]}
            value={timeRange}
            onChange={(v) => setTimeRange(v as string)}
          />
          <Button icon={<DownloadOutlined />}>导出 CSV</Button>
          <Button icon={<ReloadOutlined />} onClick={fetchUsage} loading={loading}>
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
        <Col xs={24} lg={16}>
          <Card title="Token 趋势">
            <LineChart data={tokenTrendData} yAxisLabel="Token" />
          </Card>
        </Col>
        <Col xs={24} lg={8}>
          <Card title="模型使用分布">
            <BarChart
              data={modelUsage.map((m) => ({ name: m.model, value: m.total_tokens }))}
              height={260}
              color="#52c41a"
            />
          </Card>
        </Col>
      </Row>

      {/* 模型详情 */}
      <Card title="模型使用详情" style={{ marginTop: 16 }}>
        <Table columns={columns} dataSource={modelUsage} rowKey="model" pagination={false} loading={loading} />
      </Card>
    </div>
  )
}

export default Metrics