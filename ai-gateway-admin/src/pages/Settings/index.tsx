import { useEffect, useState } from 'react'
import { Card, Form, Input, InputNumber, Switch, Select, Button, Space, message, Row, Col } from 'antd'
import { SaveOutlined, ReloadOutlined } from '@ant-design/icons'
import { getConfig as fetchGatewayConfig, updateConfig as saveGatewayConfig } from '@/services/api'

interface ConfigData {
  port: number
  host: string
  log_level: string
  rate_limit: {
    enabled: boolean
    qps: number
    burst: number
  }
  auth: {
    enabled: boolean
  }
  failover: {
    enabled: boolean
    failureThreshold: number
    successThreshold: number
    healthCheckInterval: number
  }
}

const Settings: React.FC = () => {
  const [loading, setLoading] = useState(false)
  const [form] = Form.useForm()
  const [initialValues] = useState<ConfigData>({
    port: 3000,
    host: '0.0.0.0',
    log_level: 'info',
    rate_limit: {
      enabled: true,
      qps: 10,
      burst: 20,
    },
    auth: {
      enabled: true,
    },
    failover: {
      enabled: false,
      failureThreshold: 3,
      successThreshold: 2,
      healthCheckInterval: 60000,
    },
  })

  const fetchConfig = async () => {
    setLoading(true)
    try {
      const data: any = await fetchGatewayConfig()
      if (data && data.port) {
        form.setFieldsValue({
          port: data.port,
          host: data.host,
          log_level: data.log_level,
          rate_limit: {
            enabled: data.rate_limit?.enabled ?? true,
            qps: data.rate_limit?.qps ?? 10,
            burst: data.rate_limit?.burst ?? 20,
          },
          auth: {
            enabled: data.auth?.enabled ?? true,
          },
          failover: {
            enabled: data.failover?.enabled ?? false,
            failureThreshold: data.failover?.failureThreshold ?? 3,
            successThreshold: data.failover?.successThreshold ?? 2,
            healthCheckInterval: data.failover?.healthCheckInterval ?? 60000,
          },
        })
        message.success('配置已加载')
      }
    } catch (error) {
      console.error(error)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchConfig()
  }, [])

  const handleSave = async () => {
    try {
      const values = await form.validateFields()
      await saveGatewayConfig(values)
      message.success('配置保存成功')
    } catch (error) {
      console.error(error)
    }
  }

  const handleReset = () => {
    form.setFieldsValue(initialValues)
    message.info('已重置为默认配置')
  }

  return (
    <div className="page-container">
      <div className="page-header">
        <h2>系统设置</h2>
        <Space>
          <Button icon={<ReloadOutlined />} onClick={fetchConfig} loading={loading}>
            重新加载
          </Button>
          <Button type="primary" icon={<SaveOutlined />} onClick={handleSave}>
            保存配置
          </Button>
        </Space>
      </div>

      <Form form={form} layout="vertical" initialValues={initialValues}>
        {/* 基本设置 */}
        <Card title="基本设置" style={{ marginBottom: 16 }}>
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item label="端口" name="port" rules={[{ required: true }]}>
                <InputNumber style={{ width: '100%' }} min={1} max={65535} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item label="主机" name="host" rules={[{ required: true }]}>
                <Input placeholder="0.0.0.0" />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item label="日志级别" name="log_level">
            <Select>
              <Select.Option value="debug">Debug</Select.Option>
              <Select.Option value="info">Info</Select.Option>
              <Select.Option value="warn">Warn</Select.Option>
              <Select.Option value="error">Error</Select.Option>
            </Select>
          </Form.Item>
        </Card>

        {/* 限流设置 */}
        <Card title="限流设置" style={{ marginBottom: 16 }}>
          <Form.Item label="启用限流" name={['rate_limit', 'enabled']} valuePropName="checked">
            <Switch />
          </Form.Item>
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item label="QPS (每秒请求数)" name={['rate_limit', 'qps']}>
                <InputNumber style={{ width: '100%' }} min={1} max={10000} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item label="突发容量" name={['rate_limit', 'burst']}>
                <InputNumber style={{ width: '100%' }} min={1} max={10000} />
              </Form.Item>
            </Col>
          </Row>
        </Card>

        {/* 认证设置 */}
        <Card title="认证设置" style={{ marginBottom: 16 }}>
          <Form.Item label="启用 API Key 认证" name={['auth', 'enabled']} valuePropName="checked">
            <Switch />
          </Form.Item>
          <p style={{ color: '#8c8c8c', fontSize: 12 }}>
            启用后，所有请求需要通过 x-api-key 或 Authorization header 提供有效的 API Key
          </p>
        </Card>

        {/* Failover 设置 */}
        <Card title="Failover 设置" style={{ marginBottom: 16 }}>
          <Form.Item label="启用故障转移" name={['failover', 'enabled']} valuePropName="checked">
            <Switch />
          </Form.Item>
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item label="失败阈值 (次)" name={['failover', 'failureThreshold']}>
                <InputNumber style={{ width: '100%' }} min={1} max={10} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item label="成功阈值 (次)" name={['failover', 'successThreshold']}>
                <InputNumber style={{ width: '100%' }} min={1} max={10} />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item label="健康检测间隔 (ms)" name={['failover', 'healthCheckInterval']}>
            <InputNumber style={{ width: '100%' }} min={10000} max={300000} step={10000} />
          </Form.Item>
          <p style={{ color: '#8c8c8c', fontSize: 12 }}>
            当 API Key 连续失败达到阈值后，将自动切换到备用 Key；连续成功达到阈值后，将恢复使用
          </p>
        </Card>

        {/* 按钮 */}
        <Space>
          <Button type="primary" icon={<SaveOutlined />} onClick={handleSave} size="large">
            保存配置
          </Button>
          <Button icon={<ReloadOutlined />} onClick={handleReset} size="large">
            重置默认
          </Button>
        </Space>
      </Form>
    </div>
  )
}

export default Settings