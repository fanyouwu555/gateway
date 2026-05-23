import { useEffect, useState } from 'react'
import { Card, Table, Button, Tag, Space, Modal, Form, Input, InputNumber, Select, Drawer, Descriptions, message, Popconfirm } from 'antd'
import { PlusOutlined, ReloadOutlined, EyeOutlined, DeleteOutlined, EditOutlined, KeyOutlined } from '@ant-design/icons'
import { getTenants, getTenantStats, getTenantKeys, createTenant, createTenantKey, updateKeyPolicy, deleteTenant, deleteApiKey } from '@/services/api'
import type { Tenant, TenantStats, ApiKey } from '@/types'

const planColors: Record<string, string> = {
  free: 'default',
  pro: 'blue',
  enterprise: 'purple',
}

const statusColors: Record<string, string> = {
  active: 'green',
  suspended: 'red',
  trial: 'orange',
}

const Tenants: React.FC = () => {
  const [loading, setLoading] = useState(false)
  const [tenants, setTenants] = useState<Tenant[]>([])
  const [createModalVisible, setCreateModalVisible] = useState(false)
  const [detailVisible, setDetailVisible] = useState(false)
  const [currentTenant, setCurrentTenant] = useState<Tenant | null>(null)
  const [tenantStats, setTenantStats] = useState<TenantStats | null>(null)
  const [apiKeys, setApiKeys] = useState<ApiKey[]>([])
  const [form] = Form.useForm()

  // Create Key modal
  const [createKeyModalVisible, setCreateKeyModalVisible] = useState(false)
  const [createKeyForm] = Form.useForm()

  // Edit Policy modal
  const [editPolicyModalVisible, setEditPolicyModalVisible] = useState(false)
  const [editingKey, setEditingKey] = useState<ApiKey | null>(null)
  const [editPolicyForm] = Form.useForm()

  const fetchTenants = async () => {
    setLoading(true)
    try {
      const data = await getTenants() as unknown as { tenants?: Tenant[] }
      setTenants(data.tenants || [])
    } catch (error) {
      message.error('获取租户失败，请检查网络连接')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchTenants()
  }, [])

  const handleViewDetail = async (tenant: Tenant) => {
    setCurrentTenant(tenant)
    try {
      const statsData = await getTenantStats(tenant.tenant_id) as unknown as TenantStats
      const keysData = await getTenantKeys(tenant.tenant_id) as unknown as { keys?: ApiKey[] }
      setTenantStats(statsData)
      setApiKeys(keysData.keys || [])
    } catch (error) {
      message.error('获取租户详情失败')
      console.error(error)
    }
    setDetailVisible(true)
  }

  const handleCreate = async () => {
    try {
      const values = await form.validateFields()
      const payload: Parameters<typeof createTenant>[0] = {
        name: values.name,
        plan: values.plan,
        status: 'active',
      }

      // Build settings if any field present
      const settings: Record<string, unknown> = {}
      if (values.settings?.default_provider) settings.default_provider = values.settings.default_provider
      if (values.settings?.allowed_providers) {
        settings.allowed_providers = values.settings.allowed_providers.split(',').map((s: string) => s.trim()).filter(Boolean)
      }
      if (values.settings?.allowed_models) {
        settings.allowed_models = values.settings.allowed_models.split(',').map((s: string) => s.trim()).filter(Boolean)
      }
      if (values.settings?.webhook_url) settings.webhook_url = values.settings.webhook_url
      if (Object.keys(settings).length > 0) payload.settings = settings

      // Build limits if any field present
      const limits: Record<string, number> = {}
      if (values.limits?.daily_requests !== undefined) limits.daily_requests = values.limits.daily_requests
      if (values.limits?.daily_tokens !== undefined) limits.daily_tokens = values.limits.daily_tokens
      if (values.limits?.monthly_cost !== undefined) limits.monthly_cost = values.limits.monthly_cost
      if (values.limits?.max_api_keys !== undefined) limits.max_api_keys = values.limits.max_api_keys
      if (values.limits?.concurrent_requests !== undefined) limits.concurrent_requests = values.limits.concurrent_requests
      if (Object.keys(limits).length > 0) payload.limits = limits

      await createTenant(payload)
      message.success('创建成功')
      setCreateModalVisible(false)
      form.resetFields()
      fetchTenants()
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : (error as { response?: { data?: { error?: { message?: string } } } })?.response?.data?.error?.message
      message.error(errMsg || '创建租户失败')
    }
  }

  const handleDelete = async (tenant: Tenant) => {
    try {
      await deleteTenant(tenant.tenant_id)
      message.success('删除成功')
      fetchTenants()
    } catch (error) {
      message.error('删除失败')
    }
  }

  // Create Key handlers
  const handleCreateKey = () => {
    setCreateKeyModalVisible(true)
  }

  const handleCreateKeySubmit = async () => {
    if (!currentTenant) return
    try {
      const values = await createKeyForm.validateFields()
      const payload: Record<string, unknown> = { name: values.name }
      if (values.expires_at) payload.expires_at = values.expires_at
      if (values.allowed_models) payload.allowed_models = values.allowed_models.split(',').map((s: string) => s.trim()).filter(Boolean)
      if (values.rate_limit_qps) payload.rate_limit_qps = values.rate_limit_qps
      if (values.rate_limit_burst) payload.rate_limit_burst = values.rate_limit_burst
      if (values.monthly_budget) payload.monthly_budget = values.monthly_budget
      if (values.max_tokens_per_request) payload.max_tokens_per_request = values.max_tokens_per_request
      if (values.metadata_key) {
        payload.metadata = { [values.metadata_key]: values.metadata_value || '' }
      }
      const result = await createTenantKey(currentTenant.tenant_id, payload as Parameters<typeof createTenantKey>[1]) as unknown as { key?: string }
      message.success('Key 创建成功')
      message.info(`Key: ${result.key} — 请立即保存，关闭后将无法再次获取`)
      setCreateKeyModalVisible(false)
      createKeyForm.resetFields()
      // Refresh keys
      const keysData = await getTenantKeys(currentTenant.tenant_id) as unknown as { keys?: ApiKey[] }
      setApiKeys(keysData.keys || [])
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : (error as { response?: { data?: { error?: { message?: string } } } })?.response?.data?.error?.message
      message.error(errMsg || '创建 Key 失败')
    }
  }

  // Edit Policy handlers
  const handleEditPolicy = (key: ApiKey) => {
    setEditingKey(key)
    editPolicyForm.setFieldsValue({
      name: key.name,
      allowed_models: key.allowed_models?.join(', ') || '',
      rate_limit_qps: key.rate_limit_qps,
      rate_limit_burst: key.rate_limit_burst,
      monthly_budget: key.monthly_budget,
      max_tokens_per_request: key.max_tokens_per_request,
      metadata_key: key.metadata ? Object.keys(key.metadata)[0] : '',
      metadata_value: key.metadata ? Object.values(key.metadata)[0] : '',
    })
    setEditPolicyModalVisible(true)
  }

  const handleEditPolicySubmit = async () => {
    if (!currentTenant || !editingKey) return
    try {
      const values = await editPolicyForm.validateFields()
      const payload: Record<string, unknown> = {}
      if (values.name) payload.name = values.name
      if (values.allowed_models) {
        payload.allowed_models = values.allowed_models.split(',').map((s: string) => s.trim()).filter(Boolean)
      }
      if (values.rate_limit_qps) payload.rate_limit_qps = values.rate_limit_qps
      if (values.rate_limit_burst) payload.rate_limit_burst = values.rate_limit_burst
      if (values.monthly_budget) payload.monthly_budget = values.monthly_budget
      if (values.max_tokens_per_request) payload.max_tokens_per_request = values.max_tokens_per_request
      if (values.metadata_key) {
        payload.metadata = { [values.metadata_key]: values.metadata_value || '' }
      }
      await updateKeyPolicy(currentTenant.tenant_id, editingKey.key, payload as Parameters<typeof updateKeyPolicy>[2])
      message.success('策略更新成功')
      setEditPolicyModalVisible(false)
      setEditingKey(null)
      editPolicyForm.resetFields()
      // Refresh keys
      const keysData = await getTenantKeys(currentTenant.tenant_id) as unknown as { keys?: ApiKey[] }
      setApiKeys(keysData.keys || [])
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : (error as { response?: { data?: { error?: { message?: string } } } })?.response?.data?.error?.message
      message.error(errMsg || '更新策略失败')
    }
  }

  // Delete Key handler
  const handleDeleteKey = async (key: ApiKey) => {
    try {
      await deleteApiKey(key.key)
      message.success('Key 已删除')
      if (currentTenant) {
        const keysData = await getTenantKeys(currentTenant.tenant_id) as unknown as { keys?: ApiKey[] }
        setApiKeys(keysData.keys || [])
      }
    } catch (error) {
      message.error('删除 Key 失败')
    }
  }

  const columns = [
    { title: '名称', dataIndex: 'name', key: 'name', width: 150 },
    { title: 'ID', dataIndex: 'tenant_id', key: 'tenant_id', width: 180 },
    {
      title: '计划',
      dataIndex: 'plan',
      key: 'plan',
      width: 100,
      render: (plan: string) => <Tag color={planColors[plan]}>{plan.toUpperCase()}</Tag>,
    },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      width: 100,
      render: (status: string) => <Tag color={statusColors[status]}>{status}</Tag>,
    },
    {
      title: '可用模型',
      dataIndex: 'settings',
      key: 'models',
      render: (settings?: { allowed_providers?: string[] }) => (
        <Space>
          {settings?.allowed_providers?.map((p: string) => (
            <Tag key={p}>{p}</Tag>
          )) || '-'}
        </Space>
      ),
    },
    {
      title: '操作',
      key: 'action',
      render: (_value: unknown, record: Tenant) => (
        <Space>
          <Button size="small" icon={<EyeOutlined />} onClick={() => handleViewDetail(record)}>
            详情
          </Button>
          <Popconfirm title="确认删除?" onConfirm={() => handleDelete(record)}>
            <Button size="small" danger icon={<DeleteOutlined />}>
              删除
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ]

  const keyColumns = [
    { title: '名称', dataIndex: 'name', key: 'name', width: 120 },
    { title: 'Key', dataIndex: 'key', key: 'key', width: 180, render: (v: string) => `${v.slice(0, 16)}...` },
    {
      title: '模型限制',
      key: 'allowed_models',
      width: 150,
      render: (_value: unknown, record: ApiKey) =>
        record.allowed_models?.length
          ? record.allowed_models.map((m) => <Tag key={m} color="blue">{m}</Tag>)
          : <Tag>不限</Tag>,
    },
    {
      title: 'QPS/突发',
      key: 'rate_limit',
      width: 100,
      render: (_value: unknown, record: ApiKey) =>
        record.rate_limit_qps ? `${record.rate_limit_qps}/${record.rate_limit_burst || '-'}` : '-',
    },
    {
      title: '月预算',
      key: 'monthly_budget',
      width: 90,
      render: (_value: unknown, record: ApiKey) =>
        record.monthly_budget ? <span>${record.monthly_budget}</span> : '-',
    },
    {
      title: '单次 Max Tokens',
      key: 'max_tokens',
      width: 100,
      render: (_value: unknown, record: ApiKey) => record.max_tokens_per_request || '-',
    },
    {
      title: '创建时间',
      dataIndex: 'created_at',
      key: 'created_at',
      width: 100,
      render: (v: number) => new Date(v).toLocaleDateString(),
    },
    {
      title: '操作',
      key: 'action',
      width: 120,
      render: (_value: unknown, record: ApiKey) => (
        <Space size="small">
          <Button size="small" icon={<EditOutlined />} onClick={() => handleEditPolicy(record)}>
            策略
          </Button>
          <Popconfirm title="确认删除此 Key?" onConfirm={() => handleDeleteKey(record)}>
            <Button size="small" danger icon={<DeleteOutlined />} />
          </Popconfirm>
        </Space>
      ),
    },
  ]

  return (
    <div className="page-container">
      <div className="page-header">
        <h2>租户管理</h2>
        <Space>
          <Button icon={<ReloadOutlined />} onClick={fetchTenants} loading={loading}>
            刷新
          </Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateModalVisible(true)}>
            创建租户
          </Button>
        </Space>
      </div>

      <Card>
        <Table columns={columns} dataSource={tenants} rowKey="tenant_id" loading={loading} scroll={{ x: 'max-content' }} />
      </Card>

      {/* 创建租户弹窗 */}
      <Modal
        title="创建租户"
        open={createModalVisible}
        onOk={handleCreate}
        onCancel={() => {
          setCreateModalVisible(false)
          form.resetFields()
        }}
      >
        <Form form={form} layout="vertical">
          <Form.Item label="名称" name="name" rules={[{ required: true, message: '请输入租户名称' }]}>
            <Input placeholder="租户名称" />
          </Form.Item>
          <Form.Item label="计划" name="plan" rules={[{ required: true }]} initialValue="free">
            <Select>
              <Select.Option value="free">Free</Select.Option>
              <Select.Option value="pro">Pro</Select.Option>
              <Select.Option value="enterprise">Enterprise</Select.Option>
            </Select>
          </Form.Item>

          <Form.Item label="默认 Provider" name={['settings', 'default_provider']}>
            <Input placeholder="openai" />
          </Form.Item>
          <Form.Item label="允许的 Providers（逗号分隔）" name={['settings', 'allowed_providers']}>
            <Input placeholder="openai, deepseek" />
          </Form.Item>
          <Form.Item label="允许的模型（逗号分隔）" name={['settings', 'allowed_models']}>
            <Input placeholder="gpt-4o-mini, deepseek-chat" />
          </Form.Item>
          <Form.Item label="Webhook URL" name={['settings', 'webhook_url']}>
            <Input placeholder="https://example.com/webhook" />
          </Form.Item>

          <Form.Item label="日请求限制" name={['limits', 'daily_requests']}>
            <InputNumber min={1} style={{ width: '100%' }} placeholder="1000" />
          </Form.Item>
          <Form.Item label="日 Token 限制" name={['limits', 'daily_tokens']}>
            <InputNumber min={1} style={{ width: '100%' }} placeholder="100000" />
          </Form.Item>
          <Form.Item label="月预算（USD）" name={['limits', 'monthly_cost']}>
            <InputNumber min={0} step={0.01} style={{ width: '100%' }} placeholder="100" />
          </Form.Item>
          <Form.Item label="最大 API Keys" name={['limits', 'max_api_keys']}>
            <InputNumber min={1} style={{ width: '100%' }} placeholder="10" />
          </Form.Item>
          <Form.Item label="并发请求限制" name={['limits', 'concurrent_requests']}>
            <InputNumber min={1} style={{ width: '100%' }} placeholder="100" />
          </Form.Item>
        </Form>
      </Modal>

      {/* 创建虚拟 Key 弹窗 */}
      <Modal
        title="创建 API Key（虚拟 Key）"
        open={createKeyModalVisible}
        onOk={handleCreateKeySubmit}
        onCancel={() => {
          setCreateKeyModalVisible(false)
          createKeyForm.resetFields()
        }}
        width={520}
      >
        <Form form={createKeyForm} layout="vertical">
          <Form.Item label="名称" name="name" rules={[{ required: true, message: '请输入 Key 名称' }]}>
            <Input placeholder="例如：user-zhangsan" />
          </Form.Item>
          <Form.Item label="允许的模型（逗号分隔，留空=不限制）" name="allowed_models">
            <Input placeholder="gpt-4o-mini, deepseek-chat" />
          </Form.Item>
          <Form.Item label="QPS 限制" name="rate_limit_qps">
            <InputNumber min={1} style={{ width: '100%' }} placeholder="每秒请求数" />
          </Form.Item>
          <Form.Item label="突发容量" name="rate_limit_burst">
            <InputNumber min={1} style={{ width: '100%' }} placeholder="突发请求数" />
          </Form.Item>
          <Form.Item label="月度预算（USD）" name="monthly_budget">
            <InputNumber min={0} step={0.01} style={{ width: '100%' }} placeholder="月度费用上限" />
          </Form.Item>
          <Form.Item label="单次 Max Tokens" name="max_tokens_per_request">
            <InputNumber min={1} style={{ width: '100%' }} placeholder="单次请求最大 token" />
          </Form.Item>
          <Form.Item label="过期时间" name="expires_at">
            <InputNumber min={Date.now()} style={{ width: '100%' }} placeholder="时间戳（毫秒），留空=永不过期" />
          </Form.Item>
          <Space style={{ width: '100%' }}>
            <Form.Item label="元数据 Key" name="metadata_key">
              <Input placeholder="user_id" />
            </Form.Item>
            <Form.Item label="元数据 Value" name="metadata_value">
              <Input placeholder="u123" />
            </Form.Item>
          </Space>
        </Form>
      </Modal>

      {/* 编辑 Key 策略弹窗 */}
      <Modal
        title="编辑 Key 策略"
        open={editPolicyModalVisible}
        onOk={handleEditPolicySubmit}
        onCancel={() => {
          setEditPolicyModalVisible(false)
          setEditingKey(null)
          editPolicyForm.resetFields()
        }}
        width={520}
      >
        <Form form={editPolicyForm} layout="vertical">
          <Form.Item label="名称" name="name">
            <Input placeholder="Key 名称" />
          </Form.Item>
          <Form.Item label="允许的模型（逗号分隔，空=不限制）" name="allowed_models">
            <Input placeholder="gpt-4o-mini, deepseek-chat" />
          </Form.Item>
          <Form.Item label="QPS 限制" name="rate_limit_qps">
            <InputNumber min={1} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item label="突发容量" name="rate_limit_burst">
            <InputNumber min={1} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item label="月度预算（USD）" name="monthly_budget">
            <InputNumber min={0} step={0.01} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item label="单次 Max Tokens" name="max_tokens_per_request">
            <InputNumber min={1} style={{ width: '100%' }} />
          </Form.Item>
          <Space style={{ width: '100%' }}>
            <Form.Item label="元数据 Key" name="metadata_key">
              <Input placeholder="user_id" />
            </Form.Item>
            <Form.Item label="元数据 Value" name="metadata_value">
              <Input placeholder="u123" />
            </Form.Item>
          </Space>
        </Form>
      </Modal>

      {/* 租户详情抽屉 */}
      <Drawer title="租户详情" open={detailVisible} onClose={() => setDetailVisible(false)} width={680}>
        {currentTenant && (
          <Descriptions column={1} bordered size="small">
            <Descriptions.Item label="名称">{currentTenant.name}</Descriptions.Item>
            <Descriptions.Item label="ID">{currentTenant.tenant_id}</Descriptions.Item>
            <Descriptions.Item label="计划">
              <Tag color={planColors[currentTenant.plan]}>{currentTenant.plan}</Tag>
            </Descriptions.Item>
            <Descriptions.Item label="状态">
              <Tag color={statusColors[currentTenant.status]}>{currentTenant.status}</Tag>
            </Descriptions.Item>
            <Descriptions.Item label="日请求限制">{currentTenant.limits?.daily_requests}</Descriptions.Item>
            <Descriptions.Item label="日 Token 限制">{currentTenant.limits?.daily_tokens}</Descriptions.Item>
            <Descriptions.Item label="月预算">${currentTenant.limits?.monthly_cost}</Descriptions.Item>
          </Descriptions>
        )}
        {tenantStats && (
          <>
            <h4 style={{ marginTop: 16 }}>使用统计</h4>
            <Descriptions column={2} bordered size="small">
              <Descriptions.Item label="总请求">{tenantStats.total_requests}</Descriptions.Item>
              <Descriptions.Item label="总 Token">{tenantStats.total_tokens}</Descriptions.Item>
              <Descriptions.Item label="总成本">${tenantStats.total_cost?.toFixed(2)}</Descriptions.Item>
              <Descriptions.Item label="API Keys">{tenantStats.api_keys_count}</Descriptions.Item>
            </Descriptions>
          </>
        )}
        <div style={{ marginTop: 16, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h4 style={{ margin: 0 }}>API Keys / 虚拟 Key</h4>
          <Button type="primary" size="small" icon={<KeyOutlined />} onClick={handleCreateKey}>
            创建 Key
          </Button>
        </div>
        <Table
          style={{ marginTop: 8 }}
          size="small"
          columns={keyColumns}
          dataSource={apiKeys}
          rowKey="key"
          pagination={false}
          scroll={{ x: 'max-content' }}
        />
      </Drawer>
    </div>
  )
}

export default Tenants