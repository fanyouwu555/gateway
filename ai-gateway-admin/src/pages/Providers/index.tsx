import { useEffect, useState } from 'react'
import { Card, Table, Button, Tag, Space, message, Modal, List, Spin, Empty, Typography, Tooltip, Checkbox, Select, Divider, Alert } from 'antd'
import { ReloadOutlined, RobotOutlined, SearchOutlined, ThunderboltOutlined, GlobalOutlined, CloudOutlined, BulbOutlined, StarOutlined, FireOutlined, CodeOutlined, TeamOutlined, ApiOutlined, CloudServerOutlined, RocketOutlined, EyeOutlined, SettingOutlined } from '@ant-design/icons'
import { getHealth, getProviderStats, discoverModels, getConfig, updateConfig } from '@/services/api'
import type { ProviderStats, ModelInfo, GatewayConfig } from '@/types'

const { Text } = Typography

// 从模型名称中提取上下文窗口大小（单位：tokens）
function extractContextWindow(modelId: string): number | undefined {
  // 匹配模型名称中的上下文窗口标识，如 "32k", "128k", "256k" 等
  const match = modelId.match(/(\d+)k/i)
  if (match) {
    return parseInt(match[1]) * 1000
  }
  return undefined
}

interface ProviderData {
  name: string
  status: 'active' | 'inactive' | 'degraded'
  has_api_key?: boolean
  base_url?: string
  total_requests: number
  avg_duration_ms: number
  success_rate: number
  enabled_models?: string[]
  default_model?: string
}

const providerIcons: Record<string, React.ReactNode> = {
  openai: <RobotOutlined />,
  deepseek: <SearchOutlined />,
  anthropic: <ThunderboltOutlined />,
  mistral: <CloudOutlined />,
  groq: <BulbOutlined />,
  google: <GlobalOutlined />,
  moonshot: <StarOutlined />,
  volcano: <FireOutlined />,
  'kimi-code': <CodeOutlined />,
  cohere: <TeamOutlined />,
  together: <ApiOutlined />,
  azure: <CloudServerOutlined />,
  xai: <RocketOutlined />,
}

const Providers: React.FC = () => {
  const [loading, setLoading] = useState(false)
  const [providers, setProviders] = useState<ProviderData[]>([])
  const [discoverVisible, setDiscoverVisible] = useState(false)
  const [discoverLoading, setDiscoverLoading] = useState(false)
  const [discoverData, setDiscoverData] = useState<Record<string, { models?: ModelInfo[]; error?: string; cached?: boolean }>>({})
  
  // 模型配置 Modal 状态
  const [configVisible, setConfigVisible] = useState(false)
  const [configLoading, setConfigLoading] = useState(false)
  const [currentProvider, setCurrentProvider] = useState<ProviderData | null>(null)
  const [availableModels, setAvailableModels] = useState<ModelInfo[]>([])
  const [selectedModels, setSelectedModels] = useState<string[]>([])
  const [defaultModel, setDefaultModel] = useState<string>('')
  const [gatewayConfig, setGatewayConfig] = useState<GatewayConfig | null>(null)

  const fetchProviders = async () => {
    setLoading(true)
    try {
      const [health, stats, config] = await Promise.all([
        getHealth(),
        getProviderStats(),
        getConfig(),
      ])

      const healthData = health
      const statsData = stats
      const configData = config

      setGatewayConfig(configData)

      const providerMap = new Map<string, ProviderStats>()
      statsData.forEach((s) => providerMap.set(s.provider, s))

      // 从路由配置中提取每个供应商已启用的模型和默认模型
      const routingRules = configData?.routing?.[0]?.rules || []
      
      const providerList: ProviderData[] = (healthData?.services?.providers || []).map((p) => {
        const stat = providerMap.get(p.name)
        const s = p.status || 'inactive'
        
        // 获取该供应商已启用的模型
        const enabledModels = routingRules
          .filter((r) => r.provider === p.name)
          .map((r) => r.model)
        
        // 获取该供应商的默认模型（第一个启用的模型）
        const defaultModel = enabledModels.length > 0 ? enabledModels[0] : undefined
        
        return {
          name: p.name,
          status: s as 'active' | 'inactive' | 'degraded',
          has_api_key: p.has_api_key,
          base_url: p.base_url,
          total_requests: stat?.total_requests || 0,
          avg_duration_ms: stat?.avg_duration_ms || 0,
          success_rate: stat?.success_rate || 0,
          enabled_models: enabledModels,
          default_model: defaultModel,
        }
      })

      setProviders(providerList)
    } catch (error) {
      message.error('获取 Provider 失败')
    } finally {
      setLoading(false)
    }
  }

  const handleDiscover = async () => {
    setDiscoverVisible(true)
    setDiscoverLoading(true)
    setDiscoverData({})
    try {
      const data = await discoverModels()
      setDiscoverData(data as Record<string, { models?: ModelInfo[]; error?: string; cached?: boolean }>)
    } catch (error) {
      message.error('模型发现失败')
    } finally {
      setDiscoverLoading(false)
    }
  }

  const handleDiscoverProvider = async (providerName: string) => {
    setDiscoverVisible(true)
    setDiscoverLoading(true)
    
    // 直接设置初始数据（显示加载状态）
    setDiscoverData({
      [providerName]: { models: [], cached: false }
    })
    
    try {
      // 直接调用 API，不使用 axios 拦截器，手动设置认证头
      const response = await fetch(`/api/v1/admin/discover-models?provider=${providerName}`, {
        headers: {
          'Authorization': `Bearer ${localStorage.getItem('api_token') || ''}`
        }
      })
      
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`)
      }
      
      const data = await response.json()
      console.log('API 响应:', data)
      
      if (data.models && data.models.length > 0) {
        const transformedModels = data.models.map((model: {id: string}) => ({
          id: model.id,
          owned_by: providerName,
          context_window: extractContextWindow(model.id),
        }))
        
        setDiscoverData({
          [providerName]: { 
            models: transformedModels,
            cached: data.cached 
          },
        })
      } else {
        setDiscoverData({
          [providerName]: { models: [], cached: data.cached, error: '未返回模型数据' }
        })
      }
      
    } catch (error) {
      console.error('请求失败:', error)
      setDiscoverData({
        [providerName]: { models: [], error: '请求失败: ' + (error as Error).message }
      })
    } finally {
      setDiscoverLoading(false)
    }
  }

  // 打开模型配置 Modal
  const handleOpenConfig = async (provider: ProviderData) => {
    if (!provider.has_api_key || provider.status === 'inactive') {
      message.warning('该供应商未配置 API Key，无法配置模型')
      return
    }
    
    setCurrentProvider(provider)
    setConfigLoading(true)
    setConfigVisible(true)
    setSelectedModels(provider.enabled_models || [])
    setDefaultModel(provider.default_model || '')
    
    try {
      // 获取该供应商的可用模型
      const response = await fetch(`/api/v1/admin/discover-models?provider=${provider.name}`, {
        headers: {
          'Authorization': `Bearer ${localStorage.getItem('api_token') || ''}`
        }
      })
      
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`)
      }
      
      const data = await response.json()
      
      if (data.models && data.models.length > 0) {
        const transformedModels = data.models.map((model: {id: string}) => ({
          id: model.id,
          owned_by: provider.name,
          context_window: extractContextWindow(model.id),
        }))
        setAvailableModels(transformedModels)
      } else {
        setAvailableModels([])
        message.warning('未获取到可用模型')
      }
    } catch (error) {
      console.error('获取模型失败:', error)
      message.error('获取模型列表失败')
      setAvailableModels([])
    } finally {
      setConfigLoading(false)
    }
  }

  // 保存模型配置
  const handleSaveConfig = async () => {
    if (!currentProvider || !gatewayConfig) return
    
    if (selectedModels.length === 0) {
      message.warning('请至少选择一个模型')
      return
    }
    
    if (!defaultModel || !selectedModels.includes(defaultModel)) {
      message.warning('请选择一个默认模型（必须在已选模型中）')
      return
    }
    
    setConfigLoading(true)
    try {
      // 构建新的路由规则
      const currentRules = gatewayConfig.routing?.[0]?.rules || []
      
      // 移除该供应商的旧规则
      const otherRules = currentRules.filter((r) => r.provider !== currentProvider.name)
      
      // 添加新规则（默认模型放在第一位）
      const newRules = [
        // 默认模型规则
        {
          model: defaultModel,
          provider: currentProvider.name,
          max_tokens: 128000,
        },
        // 其他选中模型规则
        ...selectedModels
          .filter((m) => m !== defaultModel)
          .map((model) => ({
            model,
            provider: currentProvider.name,
            max_tokens: 128000,
          })),
      ]
      
      const updatedRouting = [
        {
          name: 'default',
          rules: [...otherRules, ...newRules],
          fallback: gatewayConfig.routing?.[0]?.fallback || 'volcano',
        },
      ]
      
      // 更新配置
      await updateConfig({ routing: updatedRouting })
      
      message.success(`已更新 ${currentProvider.name} 的模型配置`)
      setConfigVisible(false)
      
      // 刷新供应商列表
      await fetchProviders()
    } catch (error) {
      console.error('保存配置失败:', error)
      message.error('保存配置失败')
    } finally {
      setConfigLoading(false)
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
          <span>{providerIcons[name] || <ApiOutlined />}</span>
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
    {
      title: '已启用模型',
      key: 'enabled_models',
      width: 200,
      render: (_: unknown, record: ProviderData) => (
        <div>
          {record.enabled_models && record.enabled_models.length > 0 ? (
            <Space size={[0, 4]} wrap>
              {record.enabled_models.map((model) => (
                <Tag key={model} color={model === record.default_model ? 'green' : 'blue'}>
                  {model === record.default_model && '★ '}
                  {model}
                </Tag>
              ))}
            </Space>
          ) : (
            <Text type="secondary">未配置</Text>
          )}
        </div>
      ),
    },
    {
      title: '操作',
      key: 'action',
      render: (_: unknown, record: ProviderData) => (
        <Space>
          <Tooltip title="查看可用模型">
            <Button
              type="link"
              size="small"
              icon={<EyeOutlined />}
              onClick={() => handleDiscoverProvider(record.name)}
            />
          </Tooltip>
          <Tooltip title="配置模型">
            <Button
              type="link"
              size="small"
              icon={<SettingOutlined />}
              onClick={() => handleOpenConfig(record)}
            />
          </Tooltip>
        </Space>
      ),
    },
  ]

  const renderModelItem = (model: ModelInfo) => (
    <List.Item>
      <List.Item.Meta
        title={
          <Space>
            <Text strong>{model.id}</Text>
            {model.context_window && (
              <Tag color="blue">{(model.context_window / 1000).toFixed(0)}K ctx</Tag>
            )}
            {model.max_output_tokens && (
              <Tag color="cyan">{(model.max_output_tokens / 1000).toFixed(0)}K out</Tag>
            )}
            {model.pricing && (
              <Tag color="gold">${model.pricing.input}/${model.pricing.output}</Tag>
            )}
          </Space>
        }
        description={
          <Space size={4}>
            {model.owned_by && <Text type="secondary">{model.owned_by}</Text>}
            {model.capabilities?.vision && <Tag color="purple" bordered={false}>Vision</Tag>}
            {model.capabilities?.function_call && <Tag color="orange" bordered={false}>Tools</Tag>}
            {model.capabilities?.streaming && <Tag color="green" bordered={false}>Stream</Tag>}
          </Space>
        }
      />
    </List.Item>
  )

  return (
    <div className="page-container">
      <div className="page-header">
        <h2>Provider 管理</h2>
        <Space>
          <Button icon={<SearchOutlined />} onClick={handleDiscover}>
            发现模型
          </Button>
          <Button icon={<ReloadOutlined />} onClick={fetchProviders} loading={loading}>
            刷新
          </Button>
        </Space>
      </div>

      <Card>
        <Table columns={columns} dataSource={providers} rowKey="name" loading={loading} scroll={{ x: 'max-content' }} />
      </Card>

      <Modal
        title="模型发现 — 扫描各 Provider 可用模型"
        open={discoverVisible}
        onCancel={() => setDiscoverVisible(false)}
        footer={null}
        width={720}
      >
        {discoverLoading && !Object.keys(discoverData).length ? (
          <div style={{ textAlign: 'center', padding: '40px 0' }}>
            <Spin tip="正在扫描 Provider 模型..." />
          </div>
        ) : (
          Object.keys(discoverData).length === 0 ? (
            <Empty description="暂无数据" />
          ) : (
            <div style={{ maxHeight: 500, overflowY: 'auto' }}>
              {Object.entries(discoverData).map(([providerName, data]) => (
                <Card
                  key={providerName}
                  size="small"
                  title={
                    <Space>
                      {providerIcons[providerName] || <ApiOutlined />}
                      <span style={{ textTransform: 'uppercase' }}>{providerName}</span>
                      {data.cached && <Tag color="default">缓存</Tag>}
                      {data.error && <Tag color="red">失败</Tag>}
                      {data.models && <Tag color="blue">{data.models.length} 模型</Tag>}
                    </Space>
                  }
                  style={{ marginBottom: 12 }}
                >
                  {data.error ? (
                    <Text type="danger">{data.error}</Text>
                  ) : data.models && data.models.length > 0 ? (
                    <List
                      size="small"
                      dataSource={data.models}
                      renderItem={renderModelItem}
                      split={false}
                    />
                  ) : (
                    <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="无模型数据" />
                  )}
                </Card>
              ))}
            </div>
          )
        )}
      </Modal>

      {/* 模型配置 Modal */}
      <Modal
        title={
          <Space>
            {currentProvider && providerIcons[currentProvider.name]}
            <span>配置 {currentProvider?.name} 的可用模型</span>
          </Space>
        }
        open={configVisible}
        onCancel={() => setConfigVisible(false)}
        onOk={handleSaveConfig}
        confirmLoading={configLoading}
        width={600}
        okText="保存配置"
        cancelText="取消"
      >
        {configLoading && availableModels.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '40px 0' }}>
            <Spin tip="正在加载模型列表..." />
          </div>
        ) : (
          <div>
            <Alert
              message="选择该供应商可用的模型，并设置默认模型"
              description="默认模型将作为该供应商的首选模型，当请求未指定模型时使用"
              type="info"
              showIcon
              style={{ marginBottom: 16 }}
            />
            
            <Divider orientation="left">默认模型</Divider>
            <Select
              style={{ width: '100%', marginBottom: 16 }}
              placeholder="请选择默认模型"
              value={defaultModel || undefined}
              onChange={(value) => setDefaultModel(value)}
              disabled={selectedModels.length === 0}
            >
              {selectedModels.map((model) => (
                <Select.Option key={model} value={model}>
                  {model}
                </Select.Option>
              ))}
            </Select>
            
            <Divider orientation="left">
              可用模型 
              <Tag color="blue">{availableModels.length}</Tag>
            </Divider>
            
            <div style={{ maxHeight: 300, overflowY: 'auto', padding: '8px 0' }}>
              <Space direction="vertical" style={{ width: '100%' }}>
                {availableModels.map((model) => (
                  <Card
                    key={model.id}
                    size="small"
                    style={{ 
                      marginBottom: 8,
                      borderColor: selectedModels.includes(model.id) ? '#1890ff' : undefined,
                    }}
                    bodyStyle={{ padding: '8px 12px' }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                      <Space>
                        <Checkbox
                          checked={selectedModels.includes(model.id)}
                          onChange={(e) => {
                            if (e.target.checked) {
                              setSelectedModels([...selectedModels, model.id])
                              // 如果这是第一个选中的模型，自动设为默认
                              if (selectedModels.length === 0) {
                                setDefaultModel(model.id)
                              }
                            } else {
                              const newSelected = selectedModels.filter((m) => m !== model.id)
                              setSelectedModels(newSelected)
                              // 如果取消的是默认模型，清空默认模型
                              if (defaultModel === model.id) {
                                setDefaultModel(newSelected.length > 0 ? newSelected[0] : '')
                              }
                            }
                          }}
                        />
                        <Text strong>{model.id}</Text>
                        {model.context_window && (
                          <Tag color="blue">{(model.context_window / 1000).toFixed(0)}K ctx</Tag>
                        )}
                      </Space>
                      {selectedModels.includes(model.id) && model.id === defaultModel && (
                        <Tag color="green">默认</Tag>
                      )}
                    </div>
                  </Card>
                ))}
              </Space>
            </div>
            
            {selectedModels.length > 0 && (
              <div style={{ marginTop: 16, padding: '12px', background: '#f6ffed', borderRadius: 4, border: '1px solid #b7eb8f' }}>
                <Text strong style={{ color: '#52c41a' }}>
                  已选择 {selectedModels.length} 个模型
                </Text>
                <br />
                <Text type="secondary">
                  默认模型: {defaultModel || '未设置'}
                </Text>
              </div>
            )}
          </div>
        )}
      </Modal>
    </div>
  )
}

export default Providers
