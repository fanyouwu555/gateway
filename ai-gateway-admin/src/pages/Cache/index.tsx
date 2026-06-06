import { useEffect, useState } from 'react'
import { Card, Row, Col, Statistic, Button, Modal, message, Progress } from 'antd'
import { ReloadOutlined, DeleteOutlined, DatabaseOutlined, CheckCircleOutlined } from '@ant-design/icons'
import { getCacheStats, cleanCache } from '@/services/api'
import type { CacheStats } from '@/types'

const CacheManagement: React.FC = () => {
  const [loading, setLoading] = useState(false)
  const [cleaning, setCleaning] = useState(false)
  const [stats, setStats] = useState<CacheStats | null>(null)

  const fetchStats = async () => {
    setLoading(true)
    try {
      const data = await getCacheStats()
      setStats(data)
    } catch {
      message.error('获取缓存统计失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchStats()
  }, [])

  const handleClean = () => {
    Modal.confirm({
      title: '确认清理缓存',
      content: '将清除所有缓存的响应数据，此操作不可撤销。',
      onOk: async () => {
        setCleaning(true)
        try {
          await cleanCache()
          message.success('缓存已清理')
          fetchStats()
        } catch {
          message.error('清理缓存失败')
        } finally {
          setCleaning(false)
        }
      },
    })
  }

  return (
    <div className="page-container">
      <div className="page-header">
        <h2>缓存管理</h2>
        <Button icon={<ReloadOutlined />} onClick={fetchStats} loading={loading}>刷新</Button>
      </div>

      <Row gutter={[16, 16]}>
        <Col xs={24} sm={12} lg={6}>
          <Card>
            <Statistic
              title="缓存条目"
              value={stats?.size ?? 0}
              prefix={<DatabaseOutlined />}
              suffix="条"
            />
          </Card>
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <Card>
            <Statistic
              title="命中率"
              value={((stats?.hit_rate ?? 0) * 100).toFixed(2)}
              prefix={<CheckCircleOutlined />}
              suffix="%"
            />
          </Card>
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <Card>
            <Statistic
              title="命中次数"
              value={stats?.hits ?? 0}
            />
          </Card>
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <Card>
            <Statistic
              title="未命中次数"
              value={stats?.misses ?? 0}
            />
          </Card>
        </Col>
      </Row>

      <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
        <Col xs={24} sm={12} lg={8}>
          <Card title="缓存命中率">
            <Progress
              type="dashboard"
              percent={Math.round((stats?.hit_rate ?? 0) * 100)}
              strokeColor={(stats?.hit_rate ?? 0) > 0.5 ? '#52c41a' : '#faad14'}
            />
          </Card>
        </Col>
        <Col xs={24} sm={12} lg={16}>
          <Card title="操作">
            <p style={{ color: '#666', marginBottom: 16 }}>
              清理缓存将移除所有缓存的 AI 响应数据。下次相同请求将直接调用 Provider。
            </p>
            <Button
              type="primary"
              danger
              icon={<DeleteOutlined />}
              onClick={handleClean}
              loading={cleaning}
            >
              清理全部缓存
            </Button>
          </Card>
        </Col>
      </Row>
    </div>
  )
}

export default CacheManagement