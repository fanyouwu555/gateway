import { useEffect, useState } from 'react'
import {
  Card,
  Table,
  Button,
  Space,
  Drawer,
  Collapse,
  Tag,
  Popconfirm,
  DatePicker,
  Input,
  Select,
  message,
  Descriptions,
  Empty,
} from 'antd'
import type { ColumnsType } from 'antd/es/table'
import {
  ReloadOutlined,
  DeleteOutlined,
  EyeOutlined,
  CommentOutlined,
} from '@ant-design/icons'
import { getConversations, getConversation, deleteConversation } from '@/services/api'
import type { ConversationSession, ConversationTurn, ConversationDetail } from '@/types'
import DOMPurify from 'dompurify'

/**
 * 清理后端返回的文本内容，防止 XSS。
 * 当前页面按纯文本渲染，保留此函数以符合安全规范并为后续 Markdown/HTML 渲染做准备。
 */
const sanitizeContent = (text: string | unknown): string => {
  return DOMPurify.sanitize(String(text ?? ''))
}

const { RangePicker } = DatePicker

const Conversations: React.FC = () => {
  const [loading, setLoading] = useState(false)
  const [sessions, setSessions] = useState<ConversationSession[]>([])
  const [total, setTotal] = useState(0)
  const [offset, setOffset] = useState(0)
  const [limit] = useState(20)

  const [detailVisible, setDetailVisible] = useState(false)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailData, setDetailData] = useState<ConversationDetail | null>(null)

  const [dateRange, setDateRange] = useState<[number, number] | null>(null)
  const [modelFilter, setModelFilter] = useState('')
  const [tenantFilter, setTenantFilter] = useState('')
  const [clientFilter, setClientFilter] = useState<string>('')

  const fetchSessions = async (currentOffset = offset) => {
    setLoading(true)
    try {
      const result = await getConversations({
        start: dateRange ? dateRange[0] : undefined,
        end: dateRange ? dateRange[1] : undefined,
        model: modelFilter || undefined,
        tenant_id: tenantFilter || undefined,
        client: clientFilter || undefined,
        limit,
        offset: currentOffset,
      })
      setSessions(result.sessions || [])
      setTotal(result.total || 0)
    } catch {
      message.error('获取对话日志失败')
    } finally {
      setLoading(false)
    }
  }

  const fetchDetail = async (sessionId: string) => {
    setDetailLoading(true)
    try {
      const result = await getConversation(sessionId)
      setDetailData(result)
    } catch {
      message.error('获取对话详情失败')
    } finally {
      setDetailLoading(false)
    }
  }

  const handleDelete = async (sessionId: string) => {
    try {
      await deleteConversation(sessionId)
      message.success('删除成功')
      fetchSessions(offset)
    } catch {
      message.error('删除失败')
    }
  }

  const showDetail = (sessionId: string) => {
    setDetailVisible(true)
    fetchDetail(sessionId)
  }

  const closeDetail = () => {
    setDetailVisible(false)
    setDetailData(null)
  }

  useEffect(() => {
    fetchSessions(0)
  }, [])

  const handleDateChange = (_: unknown, dates: [string, string] | null) => {
    if (dates) {
      setDateRange([new Date(dates[0]).getTime(), new Date(dates[1]).getTime()])
    } else {
      setDateRange(null)
    }
  }

  const handleSearch = () => {
    setOffset(0)
    fetchSessions(0)
  }

  const formatTime = (ts: number) => {
    return new Date(ts).toLocaleString('zh-CN')
  }

  const columns: ColumnsType<ConversationSession> = [
    {
      title: '会话ID',
      dataIndex: 'session_id',
      key: 'session_id',
      render: (id: string) => (
        <Button type="link" onClick={() => showDetail(id)} style={{ padding: 0 }}>
          {id}
        </Button>
      ),
    },
    {
      title: '创建时间',
      dataIndex: 'created_at',
      key: 'created_at',
      render: (ts: number) => formatTime(ts),
    },
    {
      title: '轮数',
      dataIndex: 'turn_count',
      key: 'turn_count',
      width: 80,
    },
    {
      title: '总Tokens',
      dataIndex: 'total_tokens',
      key: 'total_tokens',
      width: 100,
    },
    {
      title: '总成本',
      dataIndex: 'total_cost',
      key: 'total_cost',
      width: 100,
      render: (cost: number) => `¥${cost.toFixed(6)}`,
    },
    {
      title: '租户',
      dataIndex: 'tenant_id',
      key: 'tenant_id',
      width: 100,
      render: (tenant: string) => tenant ? <Tag>{tenant}</Tag> : '-',
    },
    {
      title: '客户端',
      dataIndex: 'client_info',
      key: 'client_info',
      width: 120,
      render: (clientInfo: ConversationSession['client_info']) => {
        if (!clientInfo || clientInfo.name === 'unknown') {
          return <Tag color="default">未知</Tag>
        }
        const colorMap: Record<string, string> = {
          opencode: 'cyan',
          cursor: 'blue',
          trae: 'orange',
          vscode: 'geekblue',
          jetbrains: 'purple',
          curl: 'lime',
          python: 'gold',
          browser: 'magenta',
        }
        const color = colorMap[clientInfo.name] || 'processing'
        return (
          <Tag color={color}>
            {clientInfo.name}
            {clientInfo.version ? ` v${clientInfo.version}` : ''}
          </Tag>
        )
      },
    },
    {
      title: '最后模型',
      dataIndex: 'last_model',
      key: 'last_model',
      width: 150,
    },
    {
      title: '操作',
      key: 'action',
      width: 120,
      render: (_: unknown, record: ConversationSession) => (
        <Space size="small">
          <Button
            type="text"
            icon={<EyeOutlined />}
            onClick={() => showDetail(record.session_id)}
            title="查看详情"
          />
          <Popconfirm
            title="确认删除"
            description={`删除会话 ${record.session_id}？`}
            onConfirm={() => handleDelete(record.session_id)}
            okText="删除"
            cancelText="取消"
          >
            <Button type="text" danger icon={<DeleteOutlined />} title="删除" />
          </Popconfirm>
        </Space>
      ),
    },
  ]

  const renderTurnContent = (turn: ConversationTurn) => {
    const items = []

    // 用户消息
    if (turn.request.messages?.length > 0) {
      items.push({
        key: 'user',
        label: (
          <Space>
            <Tag color="blue">用户</Tag>
            <span style={{ fontSize: 12, color: '#888' }}>{formatTime(turn.timestamp)}</span>
          </Space>
        ),
        children: (
          <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
            {turn.request.messages.map((msg, idx) => (
              <div key={idx} style={{ marginBottom: 8 }}>
                {sanitizeContent(msg.content)}
              </div>
            ))}
          </div>
        ),
      })
    }

    // 工具调用
    const toolCalls = turn.response.tool_calls
    if (toolCalls && toolCalls.length > 0) {
      items.push({
        key: 'tool_calls',
        label: <Tag color="orange">工具调用</Tag>,
        children: (
          <Space direction="vertical" style={{ width: '100%' }}>
            {toolCalls.map((tc) => (
              <Card size="small" key={tc.id} title={tc.function.name}>
                <pre style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                  {(() => {
                    try {
                      return JSON.stringify(JSON.parse(tc.function.arguments), null, 2)
                    } catch {
                      return tc.function.arguments
                    }
                  })()}
                </pre>
              </Card>
            ))}
          </Space>
        ),
      })
    }

    // 思考过程（默认折叠）
    if (turn.response.reasoning_content) {
      items.push({
        key: 'reasoning',
        label: <Tag color="default">思考过程</Tag>,
        children: (
          <div
            style={{
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              background: '#f5f5f5',
              padding: 12,
              borderRadius: 4,
            }}
          >
            {sanitizeContent(turn.response.reasoning_content)}
          </div>
        ),
      })
    }

    // 助手回复
    items.push({
      key: 'assistant',
      label: <Tag color="green">助手</Tag>,
      children: (
        <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
          {sanitizeContent(turn.response.content)}
        </div>
      ),
    })

    // 元数据
    items.push({
      key: 'meta',
      label: <Tag color="purple">元数据</Tag>,
      children: (
        <Descriptions size="small" column={3}>
          <Descriptions.Item label="Provider">{turn.metadata.provider}</Descriptions.Item>
          <Descriptions.Item label="耗时">{turn.metadata.duration_ms}ms</Descriptions.Item>
          <Descriptions.Item label="成本">¥{turn.metadata.cost?.toFixed(6) || 0}</Descriptions.Item>
          <Descriptions.Item label="Prompt">{turn.response.usage.prompt_tokens}</Descriptions.Item>
          <Descriptions.Item label="Completion">{turn.response.usage.completion_tokens}</Descriptions.Item>
          <Descriptions.Item label="Total">{turn.response.usage.total_tokens}</Descriptions.Item>
          <Descriptions.Item label="状态码">{turn.metadata.status_code}</Descriptions.Item>
          {turn.metadata.client_info && (
            <Descriptions.Item label="客户端">
              <Tag color="cyan">{turn.metadata.client_info.name}</Tag>
              {turn.metadata.client_info.version && ` v${turn.metadata.client_info.version}`}
            </Descriptions.Item>
          )}
          {turn.metadata.session_source && (
            <Descriptions.Item label="会话来源">
              {turn.metadata.session_source.provided_by_header || '自动生成'}
            </Descriptions.Item>
          )}
        </Descriptions>
      ),
    })

    return items
  }

  return (
    <div className="page-container">
      <div className="page-header">
        <h2>
          <CommentOutlined /> 对话日志
        </h2>
        <Space>
          <RangePicker
            showTime
            onChange={handleDateChange}
            placeholder={['开始时间', '结束时间']}
          />
          <Input
            placeholder="模型过滤"
            value={modelFilter}
            onChange={(e) => setModelFilter(e.target.value)}
            style={{ width: 150 }}
          />
          <Input
            placeholder="租户过滤"
            value={tenantFilter}
            onChange={(e) => setTenantFilter(e.target.value)}
            style={{ width: 150 }}
          />
          <Select
            placeholder="客户端筛选"
            value={clientFilter || undefined}
            onChange={(value) => setClientFilter(value)}
            style={{ width: 150 }}
            allowClear
            options={[
              { value: 'opencode', label: 'OpenCode' },
              { value: 'cursor', label: 'Cursor' },
              { value: 'trae', label: 'Trae' },
              { value: 'vscode', label: 'VSCode' },
              { value: 'jetbrains', label: 'JetBrains' },
              { value: 'browser', label: '浏览器' },
              { value: 'curl', label: 'cURL' },
              { value: 'python', label: 'Python' },
              { value: 'unknown', label: '未知' },
            ]}
          />
          <Button type="primary" onClick={handleSearch}>
            查询
          </Button>
          <Button icon={<ReloadOutlined />} onClick={() => fetchSessions(offset)} loading={loading}>
            刷新
          </Button>
        </Space>
      </div>

      <Card>
        <Table
          columns={columns}
          dataSource={sessions}
          rowKey="session_id"
          loading={loading}
          scroll={{ x: 'max-content' }}
          pagination={{
            current: Math.floor(offset / limit) + 1,
            pageSize: limit,
            total,
            onChange: (page) => {
              const newOffset = (page - 1) * limit
              setOffset(newOffset)
              fetchSessions(newOffset)
            },
          }}
        />
      </Card>

      <Drawer
        title={detailData?.session ? `会话详情: ${detailData.session.session_id}` : '会话详情'}
        width={800}
        open={detailVisible}
        onClose={closeDetail}
        destroyOnClose
      >
        {detailLoading ? (
          <div style={{ textAlign: 'center', padding: 40 }}>加载中...</div>
        ) : detailData ? (
          <Space direction="vertical" style={{ width: '100%' }} size="large">
            <Descriptions size="small" bordered column={3}>
              <Descriptions.Item label="会话ID">{detailData.session.session_id}</Descriptions.Item>
              <Descriptions.Item label="轮数">{detailData.session.turn_count}</Descriptions.Item>
              <Descriptions.Item label="租户">{detailData.session.tenant_id || '-'}</Descriptions.Item>
              <Descriptions.Item label="总Prompt">{detailData.session.total_prompt_tokens}</Descriptions.Item>
              <Descriptions.Item label="总Completion">{detailData.session.total_completion_tokens}</Descriptions.Item>
              <Descriptions.Item label="总Tokens">{detailData.session.total_tokens}</Descriptions.Item>
              <Descriptions.Item label="总成本">¥{detailData.session.total_cost.toFixed(6)}</Descriptions.Item>
              <Descriptions.Item label="最后模型">{detailData.session.last_model || '-'}</Descriptions.Item>
              <Descriptions.Item label="创建时间">{formatTime(detailData.session.created_at)}</Descriptions.Item>
              {detailData.session.client_info && (
                <>
                  <Descriptions.Item label="客户端">
                    <Tag color="cyan">{detailData.session.client_info.name}</Tag>
                    {detailData.session.client_info.version && ` v${detailData.session.client_info.version}`}
                  </Descriptions.Item>
                  <Descriptions.Item label="识别方式">
                    {detailData.session.client_info.inferred_from === 'header' ? '声明' : '推断'}
                  </Descriptions.Item>
                </>
              )}
              {detailData.session.user_agent && (
                <Descriptions.Item label="User-Agent" span={3}>
                  <span style={{ fontSize: 12, color: '#888', wordBreak: 'break-all' }}>{detailData.session.user_agent}</span>
                </Descriptions.Item>
              )}
            </Descriptions>

            {detailData.turns.length === 0 ? (
              <Empty description="暂无对话轮次" />
            ) : (
              detailData.turns.map((turn, idx) => (
                <Card
                  key={turn.turn_id}
                  size="small"
                  title={`第 ${idx + 1} 轮 — ${formatTime(turn.timestamp)}`}
                  style={{ marginBottom: 16 }}
                >
                  <Collapse
                    defaultActiveKey={['user', 'assistant']}
                    items={renderTurnContent(turn)}
                  />
                </Card>
              ))
            )}
          </Space>
        ) : (
          <Empty description="加载失败" />
        )}
      </Drawer>
    </div>
  )
}

export default Conversations
