import { useEffect, useState } from 'react'
import { Card, Row, Col, Statistic, Table, Button, Modal, message, Empty } from 'antd'
import { ReloadOutlined, DeleteOutlined, TeamOutlined, MessageOutlined } from '@ant-design/icons'
import { getSessions, cleanSessions } from '@/services/api'

interface SessionStatsData {
  total_sessions: number
  total_messages: number
  by_tenant?: Record<string, number>
}

interface SessionEntry {
  tenant_id: string
  session_count: number
}

const Sessions: React.FC = () => {
  const [loading, setLoading] = useState(false)
  const [cleaning, setCleaning] = useState(false)
  const [stats, setStats] = useState<SessionStatsData | null>(null)

  const fetchStats = async () => {
    setLoading(true)
    try {
      const data = await getSessions() as unknown as SessionStatsData
      setStats(data)
    } catch {
      message.error('获取会话统计失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchStats()
  }, [])

  const handleClean = () => {
    Modal.confirm({
      title: '确认清理',
      content: '将清除所有历史会话记录，此操作不可撤销。',
      onOk: async () => {
        setCleaning(true)
        try {
          await cleanSessions()
          message.success('会话已清理')
          fetchStats()
        } catch {
          message.error('清理失败')
        } finally {
          setCleaning(false)
        }
      },
    })
  }

  const tenantEntries: SessionEntry[] = stats?.by_tenant
    ? Object.entries(stats.by_tenant).map(([tenant_id, session_count]) => ({ tenant_id, session_count }))
    : []

  return (
    <div className="page-container">
      <div className="page-header">
        <h2>会话管理</h2>
        <Button icon={<ReloadOutlined />} onClick={fetchStats} loading={loading}>刷新</Button>
      </div>

      <Row gutter={[16, 16]}>
        <Col xs={24} sm={12} lg={8}>
          <Card>
            <Statistic title="总会话数" value={stats?.total_sessions ?? 0} prefix={<TeamOutlined />} />
          </Card>
        </Col>
        <Col xs={24} sm={12} lg={8}>
          <Card>
            <Statistic title="总消息数" value={stats?.total_messages ?? 0} prefix={<MessageOutlined />} />
          </Card>
        </Col>
        <Col xs={24} sm={12} lg={8}>
          <Card title="操作">
            <Button type="primary" danger icon={<DeleteOutlined />} onClick={handleClean} loading={cleaning}>
              清理所有会话
            </Button>
          </Card>
        </Col>
      </Row>

      <Card title="按租户分布" style={{ marginTop: 16 }}>
        {tenantEntries.length > 0 ? (
          <Table
            dataSource={tenantEntries}
            rowKey="tenant_id"
            pagination={false}
            size="small"
            columns={[
              { title: '租户 ID', dataIndex: 'tenant_id', key: 'tenant_id' },
              { title: '会话数', dataIndex: 'session_count', key: 'session_count' },
            ]}
          />
        ) : (
          <Empty description="暂无会话数据" />
        )}
      </Card>
    </div>
  )
}

export default Sessions