import { useEffect, useState } from 'react'
import { Card, Table, Tag, Button, Space, Modal, Form, Input, message, Empty, Typography } from 'antd'
import { ReloadOutlined, PlusOutlined, DeleteOutlined, EditOutlined, EyeOutlined, FileTextOutlined } from '@ant-design/icons'
import { getPrompts, createPrompt, updatePrompt, deletePrompt, renderPrompt } from '@/services/api'

interface PromptItem {
  id: string
  name: string
  description?: string
  template: string
  variables: string[]
  default_values?: Record<string, string>
  created_at: number
  updated_at: number
}

const Prompts: React.FC = () => {
  const [loading, setLoading] = useState(false)
  const [prompts, setPrompts] = useState<PromptItem[]>([])
  const [createModalOpen, setCreateModalOpen] = useState(false)
  const [editModalOpen, setEditModalOpen] = useState(false)
  const [previewModalOpen, setPreviewModalOpen] = useState(false)
  const [previewResult, setPreviewResult] = useState('')
  const [editingPrompt, setEditingPrompt] = useState<PromptItem | null>(null)
  const [createForm] = Form.useForm()
  const [editForm] = Form.useForm()

  const fetchPrompts = async () => {
    setLoading(true)
    try {
      const data = await getPrompts() as unknown as { templates?: PromptItem[] }
      setPrompts(data.templates || [])
    } catch {
      message.error('获取模板失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchPrompts()
  }, [])

  const handleCreate = async () => {
    try {
      const values = await createForm.validateFields()
      const variables = values.variables
        ? values.variables.split(',').map((s: string) => s.trim()).filter(Boolean)
        : undefined
      await createPrompt({ ...values, variables })
      message.success('模板创建成功')
      setCreateModalOpen(false)
      createForm.resetFields()
      fetchPrompts()
    } catch (error) {
      if (error instanceof Error) message.error(error.message)
    }
  }

  const handleEdit = async () => {
    if (!editingPrompt) return
    try {
      const values = await editForm.validateFields()
      const variables = values.variables
        ? values.variables.split(',').map((s: string) => s.trim()).filter(Boolean)
        : undefined
      await updatePrompt(editingPrompt.id, { ...values, variables })
      message.success('模板更新成功')
      setEditModalOpen(false)
      setEditingPrompt(null)
      fetchPrompts()
    } catch (error) {
      if (error instanceof Error) message.error(error.message)
    }
  }

  const handleDelete = async (prompt: PromptItem) => {
    try {
      await deletePrompt(prompt.id)
      message.success('删除成功')
      fetchPrompts()
    } catch {
      message.error('删除失败')
    }
  }

  const handlePreview = async (prompt: PromptItem) => {
    setEditingPrompt(prompt)
    try {
      const testVars: Record<string, string> = {}
      for (const v of prompt.variables) {
        testVars[v] = prompt.default_values?.[v] || `{{${v}}}`
      }
      const result = await renderPrompt(prompt.id, testVars) as unknown as { rendered?: string }
      setPreviewResult(result?.rendered || '渲染失败')
      setPreviewModalOpen(true)
    } catch {
      message.error('预览失败')
    }
  }

  const columns = [
    { title: '名称', dataIndex: 'name', key: 'name', width: 140 },
    { title: 'ID', dataIndex: 'id', key: 'id', width: 120 },
    {
      title: '变量', dataIndex: 'variables', key: 'variables', width: 200,
      render: (vars: string[]) => vars?.length
        ? vars.map((v) => <Tag key={v} style={{ fontSize: 11 }}>{`{{${v}}}`}</Tag>)
        : <Tag>无变量</Tag>,
    },
    {
      title: '描述', dataIndex: 'description', key: 'description', width: 180,
      render: (v: string | undefined) => v || '-',
    },
    {
      title: '更新时间', dataIndex: 'updated_at', key: 'updated_at', width: 120,
      render: (v: number) => new Date(v).toLocaleDateString(),
    },
    {
      title: '操作', key: 'action', width: 180,
      render: (_v: unknown, record: PromptItem) => (
        <Space>
          <Button size="small" icon={<EyeOutlined />} onClick={() => handlePreview(record)}>预览</Button>
          <Button size="small" icon={<EditOutlined />} onClick={() => {
            setEditingPrompt(record)
            editForm.setFieldsValue({
              name: record.name,
              description: record.description,
              template: record.template,
              variables: record.variables?.join(', ') || '',
              default_values: record.default_values ? JSON.stringify(record.default_values) : '',
            })
            setEditModalOpen(true)
          }}>编辑</Button>
          <Button size="small" danger icon={<DeleteOutlined />}
            onClick={() => Modal.confirm({
              title: '确认删除',
              content: `确定删除模板 "${record.name}" 吗？`,
              onOk: () => handleDelete(record),
            })}
          />
        </Space>
      ),
    },
  ]

  return (
    <div className="page-container">
      <div className="page-header">
        <h2><FileTextOutlined /> 提示词模板</h2>
        <Space>
          <Button icon={<ReloadOutlined />} onClick={fetchPrompts} loading={loading}>刷新</Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateModalOpen(true)}>
            创建模板
          </Button>
        </Space>
      </div>

      <Card>
        {prompts.length > 0 ? (
          <Table columns={columns} dataSource={prompts} rowKey="id" loading={loading} scroll={{ x: 'max-content' }} />
        ) : (
          !loading && <Empty description="暂无模板" />
        )}
      </Card>

      {/* 创建模板 */}
      <Modal title="创建模板" open={createModalOpen} onOk={handleCreate} onCancel={() => { setCreateModalOpen(false); createForm.resetFields() }} width={600}>
        <Form form={createForm} layout="vertical">
          <Form.Item label="模板 ID" name="id" rules={[{ required: true }]}>
            <Input placeholder="my-template" />
          </Form.Item>
          <Form.Item label="名称" name="name" rules={[{ required: true }]}>
            <Input placeholder="我的模板" />
          </Form.Item>
          <Form.Item label="描述" name="description">
            <Input placeholder="模板用途描述" />
          </Form.Item>
          <Form.Item label="模板内容" name="template" rules={[{ required: true, message: '请输入模板内容' }]}>
            <Input.TextArea rows={6} placeholder={'请将以下内容翻译成{{target_language}}：\n\n{{content}}'} />
          </Form.Item>
          <Form.Item label="变量（逗号分隔）" name="variables">
            <Input placeholder="target_language, content" />
          </Form.Item>
        </Form>
      </Modal>

      {/* 编辑模板 */}
      <Modal title="编辑模板" open={editModalOpen} onOk={handleEdit} onCancel={() => { setEditModalOpen(false); setEditingPrompt(null) }} width={600}>
        <Form form={editForm} layout="vertical">
          <Form.Item label="名称" name="name" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item label="描述" name="description">
            <Input />
          </Form.Item>
          <Form.Item label="模板内容" name="template" rules={[{ required: true }]}>
            <Input.TextArea rows={6} />
          </Form.Item>
          <Form.Item label="变量（逗号分隔）" name="variables">
            <Input />
          </Form.Item>
        </Form>
      </Modal>

      {/* 预览 */}
      <Modal title="模板预览" open={previewModalOpen} onCancel={() => setPreviewModalOpen(false)} footer={null} width={600}>
        <Typography.Paragraph
          code
          style={{
            padding: 12, background: '#f5f5f5', borderRadius: 6, whiteSpace: 'pre-wrap', fontSize: 13,
          }}
        >
          {previewResult}
        </Typography.Paragraph>
      </Modal>
    </div>
  )
}

export default Prompts