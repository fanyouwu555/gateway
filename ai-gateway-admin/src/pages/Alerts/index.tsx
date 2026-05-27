import { useEffect, useState } from 'react'
import { Card, Table, Tag, Button, Space, Switch, Modal, Form, Input, InputNumber, Select, message } from 'antd'
import { ReloadOutlined, PlusOutlined, DeleteOutlined, BellOutlined } from '@ant-design/icons'
import { getAlerts, createAlert, deleteAlert, toggleAlert } from '@/services/api'

interface AlertRuleItem {
  id: string
  name: string
  metric: 'error_rate' | 'avg_latency_ms' | 'total_requests'
  threshold: number
  condition: 'gt' | 'lt'
  webhook_url: string
  enabled: boolean
  cooldown_seconds: number
}

const metricLabels: Record<string, string> = {
  error_rate: '错误率',
  avg_latency_ms: '平均延迟',
  total_requests: '总请求数',
}

const conditionLabels: Record<string, string> = {
  gt: '> (大于)',
  lt: '< (小于)',
}

const Alerts: React.FC = () => {
  const [loading, setLoading] = useState(false)
  const [rules, setRules] = useState<AlertRuleItem[]>([])
  const [createModalOpen, setCreateModalOpen] = useState(false)
  const [form] = Form.useForm()

  const fetchRules = async () => {
    setLoading(true)
    try {
      const data = await getAlerts() as unknown as { rules?: AlertRuleItem[] }
      setRules(data.rules || [])
    } catch {
      message.error('获取告警规则失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchRules()
  }, [])

  const handleToggle = async (rule: AlertRuleItem, enabled: boolean) => {
    try {
      await toggleAlert(rule.id, enabled)
      message.success(`${enabled ? '启用' : '禁用'}成功`)
      fetchRules()
    } catch {
      message.error('操作失败')
    }
  }

  const handleDelete = async (rule: AlertRuleItem) => {
    try {
      await deleteAlert(rule.id)
      message.success('删除成功')
      fetchRules()
    } catch {
      message.error('删除失败')
    }
  }

  const handleCreate = async () => {
    try {
      const values = await form.validateFields()
      await createAlert(values)
      message.success('告警规则创建成功')
      setCreateModalOpen(false)
      form.resetFields()
      fetchRules()
    } catch (error) {
      if (error instanceof Error) {
        message.error(error.message)
      }
    }
  }

  const columns = [
    { title: '名称', dataIndex: 'name', key: 'name', width: 160 },
    { title: 'ID', dataIndex: 'id', key: 'id', width: 200 },
    {
      title: '指标', dataIndex: 'metric', key: 'metric', width: 120,
      render: (m: string) => <Tag>{metricLabels[m] || m}</Tag>,
    },
    {
      title: '条件', key: 'condition', width: 140,
      render: (_v: unknown, r: AlertRuleItem) => `${conditionLabels[r.condition]} ${r.threshold}`,
    },
    {
      title: '冷却期', dataIndex: 'cooldown_seconds', key: 'cooldown_seconds', width: 100,
      render: (v: number) => `${v}s`,
    },
    {
      title: '状态', dataIndex: 'enabled', key: 'enabled', width: 80,
      render: (_v: boolean, r: AlertRuleItem) => (
        <Switch checked={r.enabled} onChange={(c) => handleToggle(r, c)} size="small" />
      ),
    },
    {
      title: '操作', key: 'action', width: 80,
      render: (_v: unknown, r: AlertRuleItem) => (
        <Button
          size="small" danger icon={<DeleteOutlined />}
          onClick={() => Modal.confirm({
            title: '确认删除',
            content: `确定删除告警规则 "${r.name}" 吗？`,
            onOk: () => handleDelete(r),
          })}
        />
      ),
    },
  ]

  return (
    <div className="page-container">
      <div className="page-header">
        <h2><BellOutlined /> 告警规则</h2>
        <Space>
          <Button icon={<ReloadOutlined />} onClick={fetchRules} loading={loading}>刷新</Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateModalOpen(true)}>
            创建规则
          </Button>
        </Space>
      </div>

      <Card>
        <Table
          columns={columns}
          dataSource={rules}
          rowKey="id"
          loading={loading}
          scroll={{ x: 'max-content' }}
        />
      </Card>

      <Modal
        title="创建告警规则"
        open={createModalOpen}
        onOk={handleCreate}
        onCancel={() => { setCreateModalOpen(false); form.resetFields() }}
        width={520}
      >
        <Form form={form} layout="vertical">
          <Form.Item label="规则 ID" name="id" rules={[{ required: true, message: '请输入规则 ID' }]}>
            <Input placeholder="high-error-rate" />
          </Form.Item>
          <Form.Item label="名称" name="name" rules={[{ required: true, message: '请输入规则名称' }]}>
            <Input placeholder="高错误率告警" />
          </Form.Item>
          <Form.Item label="指标" name="metric" rules={[{ required: true }]} initialValue="error_rate">
            <Select>
              <Select.Option value="error_rate">错误率</Select.Option>
              <Select.Option value="avg_latency_ms">平均延迟 (ms)</Select.Option>
              <Select.Option value="total_requests">总请求数</Select.Option>
            </Select>
          </Form.Item>
          <Form.Item label="阈值" name="threshold" rules={[{ required: true, message: '请输入阈值' }]}>
            <InputNumber style={{ width: '100%' }} placeholder="0.05 (错误率 5%)" step={0.01} />
          </Form.Item>
          <Form.Item label="条件" name="condition" initialValue="gt">
            <Select>
              <Select.Option value="gt">大于 (&gt;)</Select.Option>
              <Select.Option value="lt">小于 (&lt;)</Select.Option>
            </Select>
          </Form.Item>
          <Form.Item label="Webhook URL" name="webhook_url" rules={[{ required: true, type: 'url', message: '请输入有效的 Webhook URL' }]}>
            <Input placeholder="https://hooks.slack.com/services/xxx" />
          </Form.Item>
          <Form.Item label="冷却时间 (秒)" name="cooldown_seconds" initialValue={300}>
            <InputNumber style={{ width: '100%' }} min={10} max={86400} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )
}

export default Alerts