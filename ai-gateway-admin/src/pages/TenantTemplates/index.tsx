import { useEffect, useMemo, useState } from 'react'
import { Card, Table, Button, Tag, Space, Modal, Form, Input, InputNumber, Select, Switch, Collapse, message } from 'antd'
import { PlusOutlined, ReloadOutlined, EditOutlined, DeleteOutlined } from '@ant-design/icons'
import {
  getTenantTemplates,
  createTenantTemplate,
  updateTenantTemplate,
  deleteTenantTemplate,
  getConfig,
  getModels,
} from '@/services/api'
import type { TenantTemplate, DefaultKeyPolicy, TenantSettings, TenantLimits, ModelListItem } from '@/types'

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

const billingModeLabels: Record<string, string> = {
  competition: '比赛',
  subscription: '包月',
  prepaid: '预付',
}

const TenantTemplates: React.FC = () => {
  const [loading, setLoading] = useState(false)
  const [templates, setTemplates] = useState<TenantTemplate[]>([])
  const [modalVisible, setModalVisible] = useState(false)
  const [editingTemplate, setEditingTemplate] = useState<TenantTemplate | null>(null)
  const [form] = Form.useForm()
  const [providerOptions, setProviderOptions] = useState<string[]>([])
  const [modelList, setModelList] = useState<ModelListItem[]>([])
  const watchedDefaultProvider = Form.useWatch('default_provider', form)
  const watchedAllowedProviders = Form.useWatch('allowed_providers', form)
  const watchedAllowedModels = Form.useWatch('allowed_models', form)

  const selectedProviders = useMemo(() => {
    const providers = (watchedAllowedProviders as string[] | undefined) || []
    if (providers.length > 0) return providers
    if (watchedDefaultProvider) return [watchedDefaultProvider as string]
    return []
  }, [watchedAllowedProviders, watchedDefaultProvider])

  const providerFilteredModels = useMemo(() => {
    if (selectedProviders.length === 0) return modelList
    return modelList.filter((m) => selectedProviders.includes(m.owned_by))
  }, [modelList, selectedProviders])

  const tenantModelOptions = providerFilteredModels.map((m) => m.id)
  const keyModelOptions = (watchedAllowedModels && (watchedAllowedModels as string[]).length > 0
    ? (watchedAllowedModels as string[]).filter((m) => tenantModelOptions.includes(m))
    : tenantModelOptions
  ).map((m) => ({ label: m, value: m }))

  useEffect(() => {
    if (modelList.length === 0) return
    const values = form.getFieldsValue()
    const next: Record<string, unknown> = {}
    const allowedModels = (values.allowed_models as string[] | undefined) || []
    const filteredAllowedModels = allowedModels.filter((m) => tenantModelOptions.includes(m))
    if (filteredAllowedModels.length !== allowedModels.length) {
      next.allowed_models = filteredAllowedModels
    }
    const defaultKeyAllowedModels = (values.default_key_allowed_models as string[] | undefined) || []
    const filteredKeyAllowedModels = defaultKeyAllowedModels.filter((m) =>
      keyModelOptions.some((opt) => opt.value === m)
    )
    if (filteredKeyAllowedModels.length !== defaultKeyAllowedModels.length) {
      next.default_key_allowed_models = filteredKeyAllowedModels
    }
    if (values.default_model && !keyModelOptions.some((opt) => opt.value === values.default_model)) {
      next.default_model = undefined
    }
    if (Object.keys(next).length > 0) {
      form.setFieldsValue(next)
    }
  }, [tenantModelOptions, keyModelOptions, modelList.length, form])

  const fetchTemplates = async () => {
    setLoading(true)
    try {
      const data = await getTenantTemplates()
      setTemplates(data.templates || [])
    } catch (error) {
      message.error('获取租户模板失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchTemplates()
    fetchProviderAndModelOptions()
  }, [])

  const fetchProviderAndModelOptions = async () => {
    try {
      const [configData, modelsData] = await Promise.all([getConfig(), getModels()])
      const providers = Object.keys(configData.providers || {})
      setProviderOptions(providers)
      setModelList(modelsData.data || [])
    } catch {
      // 静默失败，不影响主流程
    }
  }

  const openCreateModal = () => {
    setEditingTemplate(null)
    form.resetFields()
    setModalVisible(true)
  }

  const openEditModal = (template: TenantTemplate) => {
    setEditingTemplate(template)
    form.setFieldsValue({
      name: template.name,
      description: template.description,
      is_default: template.is_default,
      plan: template.tenant.plan,
      status: template.tenant.status,
      default_provider: template.tenant.settings?.default_provider,
      allowed_providers: template.tenant.settings?.allowed_providers,
      allowed_models: template.tenant.settings?.allowed_models,
      webhook_url: template.tenant.settings?.webhook_url,
      daily_requests: template.tenant.limits?.daily_requests,
      daily_tokens: template.tenant.limits?.daily_tokens,
      max_api_keys: template.tenant.limits?.max_api_keys,
      concurrent_requests: template.tenant.limits?.concurrent_requests,
      default_key_name: template.default_key?.name,
      billing_mode: template.default_key?.billing_mode,
      balance: template.default_key?.balance !== undefined ? template.default_key.balance / 1_000_000 : undefined,
      default_key_allowed_models: template.default_key?.allowed_models,
      default_model: template.default_key?.default_model,
      rate_limit_qps: template.default_key?.rate_limit_qps,
      rate_limit_burst: template.default_key?.rate_limit_burst,
      monthly_budget: template.default_key?.monthly_budget,
      max_tokens_per_request: template.default_key?.max_tokens_per_request,
      subscription_expires_at: template.default_key?.subscription_expires_at,
      expires_at: template.default_key?.expires_at,
    })
    setModalVisible(true)
  }

  const buildSettings = (values: Record<string, unknown>): TenantSettings => {
    const settings: TenantSettings = {}
    if (values.default_provider) settings.default_provider = values.default_provider as string
    const allowedProviders = values.allowed_providers as string[] | undefined
    if (allowedProviders && allowedProviders.length > 0) settings.allowed_providers = allowedProviders
    const allowedModels = values.allowed_models as string[] | undefined
    if (allowedModels && allowedModels.length > 0) settings.allowed_models = allowedModels
    if (values.webhook_url) settings.webhook_url = values.webhook_url as string
    return settings
  }

  const buildLimits = (values: Record<string, unknown>): TenantLimits => ({
    daily_requests: Number(values.daily_requests ?? 1000),
    daily_tokens: Number(values.daily_tokens ?? 100000),
    max_api_keys: Number(values.max_api_keys ?? 5),
    concurrent_requests: Number(values.concurrent_requests ?? 10),
  })

  const buildDefaultKey = (values: Record<string, unknown>): DefaultKeyPolicy | undefined => {
    const name = values.default_key_name as string | undefined
    if (!name) return undefined
    const defaultKey: DefaultKeyPolicy = { name }
    if (values.billing_mode) defaultKey.billing_mode = values.billing_mode as DefaultKeyPolicy['billing_mode']
    if (values.balance !== undefined && values.balance !== null) defaultKey.balance = Math.round((values.balance as number) * 1_000_000)
    const allowedModels = values.default_key_allowed_models as string[] | undefined
    if (allowedModels && allowedModels.length > 0) defaultKey.allowed_models = allowedModels
    if (values.default_model) defaultKey.default_model = values.default_model as string
    if (values.rate_limit_qps) defaultKey.rate_limit_qps = values.rate_limit_qps as number
    if (values.rate_limit_burst) defaultKey.rate_limit_burst = values.rate_limit_burst as number
    if (values.monthly_budget) defaultKey.monthly_budget = values.monthly_budget as number
    if (values.max_tokens_per_request) defaultKey.max_tokens_per_request = values.max_tokens_per_request as number
    if (values.subscription_expires_at) defaultKey.subscription_expires_at = values.subscription_expires_at as number
    if (values.expires_at) defaultKey.expires_at = values.expires_at as number
    return defaultKey
  }

  const handleSubmit = async () => {
    try {
      const values = await form.validateFields()
      const payload = {
        name: values.name as string,
        description: values.description as string | undefined,
        is_default: values.is_default as boolean | undefined,
        tenant: {
          plan: values.plan as TenantTemplate['tenant']['plan'],
          status: values.status as TenantTemplate['tenant']['status'],
          settings: buildSettings(values),
          limits: buildLimits(values),
        },
        default_key: buildDefaultKey(values),
      }

      if (editingTemplate) {
        await updateTenantTemplate(editingTemplate.template_id, payload)
        message.success('更新成功')
      } else {
        await createTenantTemplate(payload)
        message.success('创建成功')
      }
      setModalVisible(false)
      form.resetFields()
      setEditingTemplate(null)
      fetchTemplates()
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : (error as { response?: { data?: { error?: { message?: string } } } })?.response?.data?.error?.message
      if (errMsg) message.error(errMsg)
    }
  }

  const handleDelete = (template: TenantTemplate) => {
    Modal.confirm({
      title: '确认删除',
      content: `确定删除模板 "${template.name}" 吗？`,
      okText: '删除',
      okType: 'danger',
      cancelText: '取消',
      onOk: async () => {
        try {
          await deleteTenantTemplate(template.template_id)
          message.success('删除成功')
          fetchTemplates()
        } catch (error) {
          message.error('删除失败')
        }
      },
    })
  }

  const columns = [
    { title: '名称', dataIndex: 'name', key: 'name', width: 160 },
    { title: '描述', dataIndex: 'description', key: 'description', width: 200, render: (v?: string) => v || '-' },
    {
      title: '默认',
      dataIndex: 'is_default',
      key: 'is_default',
      width: 80,
      render: (v?: boolean) => v ? <Tag color="blue">是</Tag> : <Tag>否</Tag>,
    },
    {
      title: '计划',
      dataIndex: ['tenant', 'plan'],
      key: 'plan',
      width: 100,
      render: (plan: string) => <Tag color={planColors[plan]}>{plan.toUpperCase()}</Tag>,
    },
    {
      title: '状态',
      dataIndex: ['tenant', 'status'],
      key: 'status',
      width: 100,
      render: (status: string) => <Tag color={statusColors[status]}>{status}</Tag>,
    },
    {
      title: '默认 Key 计费',
      key: 'default_key_billing',
      width: 120,
      render: (_value: unknown, record: TenantTemplate) =>
        record.default_key?.billing_mode ? (
          <Tag color={record.default_key.billing_mode === 'competition' ? 'green' : record.default_key.billing_mode === 'subscription' ? 'blue' : 'orange'}>
            {billingModeLabels[record.default_key.billing_mode]}
          </Tag>
        ) : '-',
    },
    {
      title: '创建时间',
      dataIndex: 'created_at',
      key: 'created_at',
      width: 120,
      render: (v: number) => new Date(v).toLocaleDateString(),
    },
    {
      title: '操作',
      key: 'action',
      width: 140,
      render: (_value: unknown, record: TenantTemplate) => (
        <Space>
          <Button size="small" icon={<EditOutlined />} onClick={() => openEditModal(record)}>
            编辑
          </Button>
          <Button size="small" danger icon={<DeleteOutlined />} onClick={() => handleDelete(record)}>
            删除
          </Button>
        </Space>
      ),
    },
  ]

  return (
    <div className="page-container">
      <div className="page-header">
        <h2>租户模板管理</h2>
        <Space>
          <Button icon={<ReloadOutlined />} onClick={fetchTemplates} loading={loading}>
            刷新
          </Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreateModal}>
            创建模板
          </Button>
        </Space>
      </div>

      <Card>
        <Table
          columns={columns}
          dataSource={templates}
          rowKey="template_id"
          loading={loading}
          scroll={{ x: 'max-content' }}
        />
      </Card>

      <Modal
        title={editingTemplate ? '编辑模板' : '创建模板'}
        open={modalVisible}
        onOk={handleSubmit}
        onCancel={() => {
          setModalVisible(false)
          setEditingTemplate(null)
          form.resetFields()
        }}
        width={600}
      >
        <Form form={form} layout="vertical">
          <Form.Item label="名称" name="name" rules={[{ required: true, message: '请输入模板名称' }]}>
            <Input placeholder="例如：Pro" />
          </Form.Item>
          <Form.Item label="描述" name="description">
            <Input.TextArea rows={2} placeholder="模板描述" />
          </Form.Item>
          <Form.Item label="设为默认模板" name="is_default" valuePropName="checked">
            <Switch />
          </Form.Item>

          <Form.Item label="计划" name="plan" rules={[{ required: true }]} initialValue="free">
            <Select>
              <Select.Option value="free">Free</Select.Option>
              <Select.Option value="pro">Pro</Select.Option>
              <Select.Option value="enterprise">Enterprise</Select.Option>
            </Select>
          </Form.Item>
          <Form.Item label="状态" name="status" rules={[{ required: true }]} initialValue="active">
            <Select>
              <Select.Option value="active">Active</Select.Option>
              <Select.Option value="suspended">Suspended</Select.Option>
              <Select.Option value="trial">Trial</Select.Option>
            </Select>
          </Form.Item>

          <Form.Item label="默认 Provider" name="default_provider">
            <Select placeholder="请选择默认 Provider" allowClear showSearch>
              {providerOptions.map((p) => (
                <Select.Option key={p} value={p}>{p}</Select.Option>
              ))}
            </Select>
          </Form.Item>
          <Form.Item label="允许的 Providers" name="allowed_providers">
            <Select
              mode="multiple"
              placeholder="请选择允许的 Providers"
              allowClear
              showSearch
              options={providerOptions.map((p) => ({ label: p, value: p }))}
            />
          </Form.Item>
          <Form.Item label="允许的模型" name="allowed_models">
            <Select
              mode="multiple"
              placeholder="请选择允许的模型"
              allowClear
              showSearch
              options={tenantModelOptions.map((m) => ({ label: m, value: m }))}
            />
          </Form.Item>
          <Form.Item label="Webhook URL" name="webhook_url">
            <Input placeholder="https://example.com/webhook" />
          </Form.Item>

          <Form.Item label="日请求限制" name="daily_requests" initialValue={1000}>
            <InputNumber min={1} style={{ width: '100%' }} placeholder="1000" />
          </Form.Item>
          <Form.Item label="日 Token 限制" name="daily_tokens" initialValue={100000}>
            <InputNumber min={1} style={{ width: '100%' }} placeholder="100000" />
          </Form.Item>
          <Form.Item label="最大 API Keys" name="max_api_keys" initialValue={5}>
            <InputNumber min={1} style={{ width: '100%' }} placeholder="5" />
          </Form.Item>
          <Form.Item label="并发请求限制" name="concurrent_requests" initialValue={10}>
            <InputNumber min={1} style={{ width: '100%' }} placeholder="10" />
          </Form.Item>

          <Collapse ghost>
            <Collapse.Panel header="默认 Key 策略（可选）" key="default_key">
              <Form.Item label="Key 名称" name="default_key_name">
                <Input placeholder="默认 Key 名称" />
              </Form.Item>
              <Form.Item label="计费模式" name="billing_mode">
                <Select placeholder="请选择计费模式" allowClear>
                  <Select.Option value="competition">比赛（免费）</Select.Option>
                  <Select.Option value="subscription">包月</Select.Option>
                  <Select.Option value="prepaid">预付</Select.Option>
                </Select>
              </Form.Item>
              <Form.Item label="初始余额（元）" name="balance">
                <InputNumber min={0} step={0.01} style={{ width: '100%' }} placeholder="仅预付模式有效" />
              </Form.Item>
              <Form.Item label="允许的模型" name="default_key_allowed_models">
                <Select
                  mode="multiple"
                  placeholder="请选择允许的模型"
                  allowClear
                  showSearch
                  options={keyModelOptions}
                />
              </Form.Item>
              <Form.Item label="默认模型" name="default_model">
                <Select placeholder="请选择默认模型" allowClear showSearch>
                  {keyModelOptions.map((m) => (
                    <Select.Option key={m.value} value={m.value}>{m.label}</Select.Option>
                  ))}
                </Select>
              </Form.Item>
              <Form.Item label="QPS 限制" name="rate_limit_qps">
                <InputNumber min={1} style={{ width: '100%' }} placeholder="每秒请求数" />
              </Form.Item>
              <Form.Item label="突发容量" name="rate_limit_burst">
                <InputNumber min={1} style={{ width: '100%' }} placeholder="突发请求数" />
              </Form.Item>
              <Form.Item label="月度预算（元）" name="monthly_budget">
                <InputNumber min={0} step={0.01} style={{ width: '100%' }} placeholder="月度费用上限" />
              </Form.Item>
              <Form.Item label="单次 Max Tokens" name="max_tokens_per_request">
                <InputNumber min={1} style={{ width: '100%' }} placeholder="单次请求最大 token" />
              </Form.Item>
              <Form.Item label="订阅过期时间（时间戳 ms）" name="subscription_expires_at">
                <InputNumber min={Date.now()} style={{ width: '100%' }} placeholder="仅包月模式有效" />
              </Form.Item>
              <Form.Item label="Key 过期时间（时间戳 ms）" name="expires_at">
                <InputNumber min={Date.now()} style={{ width: '100%' }} placeholder="留空=永不过期" />
              </Form.Item>
            </Collapse.Panel>
          </Collapse>
        </Form>
      </Modal>
    </div>
  )
}

export default TenantTemplates
