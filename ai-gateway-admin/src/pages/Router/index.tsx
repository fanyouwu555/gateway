import { useEffect, useState } from 'react'
import { Card, Table, Tag, message, Empty } from 'antd'
import { getRouterStatus, getConfig } from '@/services/api'
import type { RouterStatusData } from '@/types'

interface RuleInfo {
  name: string
  model: string
  provider: string
  max_tokens?: number
}

const RouterStatus: React.FC = () => {
  const [loading, setLoading] = useState(false)
  const [statusData, setStatusData] = useState<RouterStatusData | null>(null)
  const [routingRules, setRoutingRules] = useState<RuleInfo[]>([])

  const fetchStatus = async () => {
    setLoading(true)
    try {
      const data = await getRouterStatus()
      setStatusData(data)
    } catch {
      message.error('获取路由状态失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchStatus()
  }, [])

  useEffect(() => {
    const fetchConfig = async () => {
      try {
        const config = await getConfig()
        if (config?.routing) {
          const rules: RuleInfo[] = []
          for (const group of config.routing) {
            if (group.rules) {
              for (const rule of group.rules) {
                rules.push({ ...rule, name: group.name })
              }
            }
          }
          setRoutingRules(rules)
        }
      } catch {
        // Silently fail, routing rules will show empty
      }
    }
    fetchConfig()
  }, [])

  const providerEntries = statusData?.providers
    ? Object.entries(statusData.providers)
    : []

  return (
    <div className="page-container">
      <div className="page-header">
        <h2>路由状态</h2>
      </div>

      <Card title="路由规则" style={{ marginBottom: 16 }}>
        {routingRules.length > 0 ? (
          <Table
            dataSource={routingRules}
            rowKey={(r) => `${r.name}-${r.model}`}
            pagination={false}
            size="small"
            columns={[
              { title: '规则组', dataIndex: 'name', key: 'name', width: 100 },
              { title: '模型', dataIndex: 'model', key: 'model', width: 200 },
              { title: '目标 Provider', dataIndex: 'provider', key: 'provider', width: 150 },
              {
                title: 'Max Tokens', dataIndex: 'max_tokens', key: 'max_tokens', width: 120,
                render: (v: number | undefined) => v?.toLocaleString() || '-',
              },
            ]}
          />
        ) : (
          <Empty description="暂无路由规则" />
        )}
      </Card>

      <Card title="Provider 健康状态">
        {providerEntries.length > 0 ? (
          <Table
            dataSource={providerEntries.map(([name, info]) => ({ name, ...info }))}
            rowKey="name"
            pagination={false}
            loading={loading}
            columns={[
              {
                title: 'Provider', dataIndex: 'name', key: 'name', width: 150,
                render: (name: string) => <Tag>{name}</Tag>,
              },
              {
                title: '健康状态', dataIndex: 'isHealthy', key: 'isHealthy', width: 100,
                render: (v: boolean | undefined) => (
                  <Tag color={v !== false ? 'green' : 'red'}>
                    {v !== false ? '健康' : '异常'}
                  </Tag>
                ),
              },
              {
                title: '总请求', dataIndex: 'totalRequests', key: 'totalRequests', width: 100,
                render: (v: number | undefined) => v?.toLocaleString() || '0',
              },
              {
                title: '错误率', dataIndex: 'errorRate', key: 'errorRate', width: 100,
                render: (v: number | undefined) => v ? `${(v * 100).toFixed(2)}%` : '0%',
              },
              {
                title: '平均延迟', dataIndex: 'avgLatencyMs', key: 'avgLatencyMs', width: 120,
                render: (v: number | undefined) => v ? `${v.toFixed(0)}ms` : '-',
              },
            ]}
          />
        ) : (
          <Empty description="暂无 Provider 健康数据" />
        )}
      </Card>
    </div>
  )
}

export default RouterStatus
