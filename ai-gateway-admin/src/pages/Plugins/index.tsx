import { useEffect, useState } from 'react'
import { Card, Table, Tag, Button, Space, Switch, Modal, Input, message } from 'antd'
import { ReloadOutlined, PlusOutlined, DeleteOutlined, CodeOutlined } from '@ant-design/icons'
import { getPlugins } from '@/services/api'

interface PluginItem {
  id: string
  name: string
  type: 'request' | 'response' | 'transform' | 'guardrail' | 'custom'
  enabled: boolean
  priority: number
  settings?: Record<string, unknown>
}

const typeColors: Record<string, string> = {
  request: 'orange',
  response: 'purple',
  transform: 'green',
  guardrail: 'blue',
  custom: 'default',
}

const typeLabels: Record<string, string> = {
  request: '请求拦截',
  response: '响应拦截',
  transform: '转换',
  guardrail: '安全守卫',
  custom: '自定义',
}

const Plugins: React.FC = () => {
  const [loading, setLoading] = useState(false)
  const [plugins, setPlugins] = useState<PluginItem[]>([])
  const [registerModalOpen, setRegisterModalOpen] = useState(false)
  const [codeText, setCodeText] = useState('')

  const fetchPlugins = async () => {
    setLoading(true)
    try {
      const data = await getPlugins() as unknown as { plugins?: PluginItem[] }
      setPlugins(data.plugins || [])
    } catch {
      message.error('获取插件列表失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchPlugins()
  }, [])

  const handleToggle = async (plugin: PluginItem, enabled: boolean) => {
    try {
      const endpoint = enabled ? `/v1/plugins/${plugin.id}/enable` : `/v1/plugins/${plugin.id}/disable`
      const token = localStorage.getItem('api_token')
      const resp = await fetch(endpoint, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!resp.ok) throw new Error('Toggle failed')
      message.success(`${enabled ? '启用' : '禁用'}成功`)
      fetchPlugins()
    } catch {
      message.error('操作失败')
    }
  }

  const handleDelete = async (plugin: PluginItem) => {
    try {
      const token = localStorage.getItem('api_token')
      const resp = await fetch(`/v1/plugins/${plugin.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!resp.ok) throw new Error('Delete failed')
      message.success('删除成功')
      fetchPlugins()
    } catch {
      message.error('删除失败')
    }
  }

  const handleRegister = async () => {
    if (!codeText.trim()) {
      message.error('请填写插件代码')
      return
    }
    try {
      const token = localStorage.getItem('api_token')
      const resp = await fetch('/v1/plugins/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ code: codeText }),
      })
      const result = await resp.json()
      if (!resp.ok) {
        message.error(result?.error?.message || '注册失败')
        return
      }
      message.success('插件注册成功')
      setRegisterModalOpen(false)
      setCodeText('')
      fetchPlugins()
    } catch {
      message.error('注册失败')
    }
  }

  const columns = [
    {
      title: '名称', dataIndex: 'name', key: 'name', width: 180,
      render: (name: string, record: PluginItem) => (
        <Space>
          <CodeOutlined />
          <span>{name}</span>
          <Tag color="default" style={{ fontSize: 11 }}>{record.id}</Tag>
        </Space>
      ),
    },
    {
      title: '类型', dataIndex: 'type', key: 'type', width: 120,
      render: (type: string) => <Tag color={typeColors[type]}>{typeLabels[type] || type}</Tag>,
    },
    {
      title: '优先级', dataIndex: 'priority', key: 'priority', width: 80,
    },
    {
      title: '状态', dataIndex: 'enabled', key: 'enabled', width: 100,
      render: (_enabled: boolean, record: PluginItem) => (
        <Switch
          checked={record.enabled}
          onChange={(checked) => handleToggle(record, checked)}
          size="small"
        />
      ),
    },
    {
      title: '配置', key: 'settings', width: 200,
      render: (_value: unknown, record: PluginItem) => {
        if (!record.settings || Object.keys(record.settings).length === 0) return '-'
        return (
          <Space size={4} wrap>
            {Object.entries(record.settings).map(([k, v]) => (
              <Tag key={k} color="default" style={{ fontSize: 11 }}>
                {k}: {typeof v === 'object' ? JSON.stringify(v) : String(v)}
              </Tag>
            ))}
          </Space>
        )
      },
    },
    {
      title: '操作', key: 'action', width: 100,
      render: (_value: unknown, record: PluginItem) => (
        <Button
          size="small"
          danger
          icon={<DeleteOutlined />}
          onClick={() => Modal.confirm({
            title: '确认删除',
            content: `确定删除插件 "${record.name}" 吗？`,
            onOk: () => handleDelete(record),
          })}
        />
      ),
    },
  ]

  return (
    <div className="page-container">
      <div className="page-header">
        <h2>插件管理</h2>
        <Space>
          <Button icon={<ReloadOutlined />} onClick={fetchPlugins} loading={loading}>刷新</Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setRegisterModalOpen(true)}>
            注册插件
          </Button>
        </Space>
      </div>

      <Card>
        <Table
          columns={columns}
          dataSource={plugins}
          rowKey="id"
          loading={loading}
          scroll={{ x: 'max-content' }}
        />
      </Card>

      <Modal
        title="注册新插件"
        open={registerModalOpen}
        onOk={handleRegister}
        onCancel={() => { setRegisterModalOpen(false); setCodeText('') }}
        width={700}
      >
        <div style={{ marginBottom: 8, color: '#666', fontSize: 13 }}>
          输入 JavaScript 插件代码（VM 沙箱执行）
        </div>
        <Input.TextArea
          value={codeText}
          onChange={(e) => setCodeText(e.target.value)}
          rows={12}
          placeholder={`// 示例: 简单的请求日志插件\nmodule.exports = {\n  id: 'my-plugin',\n  name: 'My Plugin',\n  type: 'request',\n  priority: 50,\n  onRequest: async (ctx, request) => {\n    console.log('Request:', request.model);\n    return request;\n  }\n};`}
          style={{ fontFamily: 'monospace', fontSize: 13 }}
        />
      </Modal>
    </div>
  )
}

export default Plugins