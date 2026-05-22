import { useEffect, useState } from 'react'
import { Card, Table, Button, Tag, Space, Modal, Form, Input, Select, Drawer, Descriptions, message, Popconfirm } from 'antd'
import { PlusOutlined, ReloadOutlined, EyeOutlined, DeleteOutlined } from '@ant-design/icons'
import { getTenants, getTenantStats, getTenantKeys, createTenant, deleteTenant } from '@/services/api'
import type { Tenant, TenantStats } from '@/types'

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
  const [apiKeys, setApiKeys] = useState<any[]>([])
  const [form] = Form.useForm()

  const fetchTenants = async () => {
    setLoading(true)
    try {
      const data: any = await getTenants()
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
      const statsAny: any = await getTenantStats(tenant.tenant_id)
      const keysDataAny: any = await getTenantKeys(tenant.tenant_id)
      setTenantStats(statsAny)
      setApiKeys(keysDataAny.keys || [])
    } catch (error) {
      message.error('获取租户详情失败')
      console.error(error)
    }
    setDetailVisible(true)
  }

  const handleCreate = async () => {
    try {
      const values = await form.validateFields()
      await createTenant({
        name: values.name,
        plan: values.plan,
        status: 'active',
      })
      message.success('创建成功')
      setCreateModalVisible(false)
      form.resetFields()
      fetchTenants()
    } catch (error: any) {
      message.error(error?.response?.data?.error?.message || '创建租户失败')
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
      render: (settings: any) => (
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
      render: (_: any, record: Tenant) => (
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
        </Form>
      </Modal>

      {/* 租户详情抽屉 */}
      <Drawer title="租户详情" open={detailVisible} onClose={() => setDetailVisible(false)} width={600}>
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
        {apiKeys.length > 0 && (
          <>
            <h4 style={{ marginTop: 16 }}>API Keys</h4>
            <Table
              size="small"
              columns={[
                { title: '名称', dataIndex: 'name', key: 'name' },
                { title: 'Key', dataIndex: 'key', key: 'key', render: (v: string) => `${v.slice(0, 12)}...` },
                { title: '创建时间', dataIndex: 'created_at', key: 'created_at', render: (v: number) => new Date(v).toLocaleDateString() },
              ]}
              dataSource={apiKeys}
              rowKey="key"
              pagination={false}
            />
          </>
        )}
      </Drawer>
    </div>
  )
}

export default Tenants