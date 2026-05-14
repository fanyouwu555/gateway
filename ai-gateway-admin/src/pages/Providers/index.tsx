import { useEffect, useState } from 'react'
import { Card, Table, Button, Tag, Space, Modal, Form, Input, InputNumber, message } from 'antd'
import { EditOutlined, ReloadOutlined } from '@ant-design/icons'
import { getHealth } from '@/services/api'

interface ProviderData {
  name: string
  status: 'online' | 'offline'
  base_url: string
  timeout: number
  request_count: number
  avg_latency: number
}

const providerIcons: Record<string, string> = {
  openai: '🔵',
  deepseek: '🟢',
  anthropic: '🟣',
  mistral: '🔴',
  groq: '🟡',
  google: '🟠',
}

const Providers: React.FC = () => {
  const [loading, setLoading] = useState(false)
  const [providers, setProviders] = useState<ProviderData[]>([])
  const [editModalVisible, setEditModalVisible] = useState(false)
  const [editingProvider, setEditingProvider] = useState<ProviderData | null>(null)
  const [form] = Form.useForm()

  const fetchProviders = async () => {
    setLoading(true)
    try {
      await getHealth()

      // 模拟数据 - 实际应该从配置获取
      setProviders([
        { name: 'openai', status: 'online', base_url: 'https://api.openai.com/v1', timeout: 30000, request_count: 56234, avg_latency: 245 },
        { name: 'deepseek', status: 'online', base_url: 'https://api.deepseek.com/v1', timeout: 30000, request_count: 37892, avg_latency: 180 },
        { name: 'anthropic', status: 'online', base_url: 'https://api.anthropic.com', timeout: 30000, request_count: 31306, avg_latency: 450 },
        { name: 'mistral', status: 'online', base_url: 'https://api.mistral.ai/v1', timeout: 30000, request_count: 15400, avg_latency: 320 },
        { name: 'groq', status: 'online', base_url: 'https://api.groq.com/openai/v1', timeout: 30000, request_count: 8900, avg_latency: 120 },
        { name: 'google', status: 'online', base_url: 'https://generativelanguage.googleapis.com/v1beta', timeout: 30000, request_count: 22000, avg_latency: 380 },
      ])
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
      render: (status: string) => (
        <Tag color={status === 'online' ? 'green' : 'red'}>
          <span className="status-dot" style={{ background: status === 'online' ? '#52c41a' : '#ff4d4f', display: 'inline-block', width: 6, height: 6, borderRadius: '50%', marginRight: 4 }} />
          {status === 'online' ? '在线' : '离线'}
        </Tag>
      ),
    },
    {
      title: 'Base URL',
      dataIndex: 'base_url',
      key: 'base_url',
      ellipsis: true,
    },
    {
      title: '超时 (ms)',
      dataIndex: 'timeout',
      key: 'timeout',
      width: 100,
    },
    {
      title: '请求量',
      dataIndex: 'request_count',
      key: 'request_count',
      render: (v: number) => v.toLocaleString(),
    },
    {
      title: '平均延迟',
      dataIndex: 'avg_latency',
      key: 'avg_latency',
      render: (v: number) => `${v}ms`,
    },
    {
      title: '操作',
      key: 'action',
      render: (_: any, record: ProviderData) => (
        <Space>
          <Button size="small" icon={<EditOutlined />} onClick={() => handleEdit(record)}>
            编辑
          </Button>
        </Space>
      ),
    },
  ]

  const handleEdit = (record: ProviderData) => {
    setEditingProvider(record)
    form.setFieldsValue(record)
    setEditModalVisible(true)
  }

  const handleSave = async () => {
    try {
      await form.validateFields()
      message.success('保存成功')
      setEditModalVisible(false)
      fetchProviders()
    } catch (error) {
      console.error(error)
    }
  }

  return (
    <div className="page-container">
      <div className="page-header">
        <h2>Provider 管理</h2>
        <Button icon={<ReloadOutlined />} onClick={fetchProviders} loading={loading}>
          刷新
        </Button>
      </div>

      <Card>
        <Table columns={columns} dataSource={providers} rowKey="name" loading={loading} />
      </Card>

      <Modal
        title={`编辑 ${editingProvider?.name}`}
        open={editModalVisible}
        onOk={handleSave}
        onCancel={() => setEditModalVisible(false)}
        width={600}
      >
        <Form form={form} layout="vertical">
          <Form.Item label="Base URL" name="base_url" rules={[{ required: true }]}>
            <Input placeholder="https://api.openai.com/v1" />
          </Form.Item>
          <Form.Item label="超时 (ms)" name="timeout" rules={[{ required: true }]}>
            <InputNumber style={{ width: '100%' }} min={1000} max={60000} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )
}

export default Providers