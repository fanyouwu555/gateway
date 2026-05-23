import { useEffect, useState } from 'react'
import { Card, Table, Button, Tag, Space, message } from 'antd'
import { ReloadOutlined } from '@ant-design/icons'
import { getHealth, getProviderStats } from '@/services/api'
import type { ProviderStats } from '@/types'

interface ProviderData {
  name: string
  status: 'active' | 'inactive' | 'degraded'
  has_api_key?: boolean
  base_url?: string
  total_requests: number
  avg_duration_ms: number
  success_rate: number
}

const providerIcons: Record<string, string> = {
  openai: '🔵',
  deepseek: '🟢',
  anthropic: '🟣',
  mistral: '🔴',
  groq: '🟡',
  google: '🟠',
  moonshot: '🌙',
  volcano: '🌋',
  'kimi-code': '🌙',
  cohere: '⚫',
  together: '🔷',
}

const Providers: React.FC = () => {
  const [loading, setLoading] = useState(false)
  const [providers, setProviders] = useState<ProviderData[]>([])

  const fetchProviders = async () => {
    setLoading(true)
    try {
      const [health, stats] = await Promise.all([
        getHealth(),
        getProviderStats(),
      ])

      const healthData = health as unknown as { services?: { providers?: Array<{ name: string; status: string; has_api_key?: boolean; base_url?: string }> } }
      const statsData = stats as unknown as ProviderStats[]

      const providerMap = new Map<string, ProviderStats>()
      statsData.forEach((s) => providerMap.set(s.provider, s))

      const providerList: ProviderData[] = (healthData?.services?.providers || []).map((p) => {
        const stat = providerMap.get(p.name)
        const s = p.status || 'inactive'
        return {
          name: p.name,
          status: s as 'active' | 'inactive' | 'degraded',
          has_api_key: p.has_api_key,
          base_url: p.base_url,
          total_requests: stat?.total_requests || 0,
          avg_duration_ms: stat?.avg_duration_ms || 0,
          success_rate: stat?.success_rate || 0,
        }
      })

      setProviders(providerList)
    } catch (error) {
      message.error('获取 Provider 失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchProviders()
  }, [])

  const columns = [
    {
      title: '提供商',
      dataIndex: 'name',
      key: 'name',
      render: (name: string) => (
        <Space>
          <span>{providerIcons[name] || '⚪'}</span>
          <span style={{ textTransform: 'uppercase' }}>{name}</span>
        </Space>
      ),
    },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      render: (status: string, record: ProviderData) => {
        const isConfigured = record.has_api_key && status !== 'inactive'
        if (!isConfigured) {
          return <Tag><span className="status-dot" style={{ background: '#d9d9d9', display: 'inline-block', width: 6, height: 6, borderRadius: '50%', marginRight: 4 }} />未配置</Tag>
        }
        if (status === 'degraded') {
          return <Tag color="red"><span className="status-dot" style={{ background: '#ff4d4f', display: 'inline-block', width: 6, height: 6, borderRadius: '50%', marginRight: 4 }} />离线</Tag>
        }
        return <Tag color="green"><span className="status-dot" style={{ background: '#52c41a', display: 'inline-block', width: 6, height: 6, borderRadius: '50%', marginRight: 4 }} />在线</Tag>
      },
    },
    {
      title: 'Base URL',
      dataIndex: 'base_url',
      key: 'base_url',
      render: (v: string) => v || '-',
    },
    {
      title: '请求量',
      dataIndex: 'total_requests',
      key: 'total_requests',
      render: (v: number) => v.toLocaleString(),
    },
    {
      title: '平均延迟',
      dataIndex: 'avg_duration_ms',
      key: 'avg_duration_ms',
      render: (v: number) => `${v}ms`,
    },
    {
      title: '成功率',
      dataIndex: 'success_rate',
      key: 'success_rate',
      render: (v: number) => `${(v * 100).toFixed(2)}%`,
    },
  ]

  return (
    <div className="page-container">
      <div className="page-header">
        <h2>Provider 管理</h2>
        <Button icon={<ReloadOutlined />} onClick={fetchProviders} loading={loading}>
          刷新
        </Button>
      </div>

      <Card>
        <Table columns={columns} dataSource={providers} rowKey="name" loading={loading} scroll={{ x: 'max-content' }} />
      </Card>
    </div>
  )
}

export default Providers