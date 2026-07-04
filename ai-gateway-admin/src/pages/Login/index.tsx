import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Input, Button, message } from 'antd'
import { KeyOutlined } from '@ant-design/icons'
import { useAuth } from '@/components/Auth/AuthContext'
import { verifyApiKey } from '@/services/api'

export default function LoginPage() {
  const [apiKey, setApiKey] = useState('')
  const [loading, setLoading] = useState(false)
  const navigate = useNavigate()
  const { login } = useAuth()

  const handleLogin = async () => {
    if (!apiKey.trim()) return
    setLoading(true)
    try {
      const data = await verifyApiKey(apiKey.trim())
      if (data.is_admin) {
        login(apiKey.trim())
        message.success('登录成功')
        navigate('/dashboard')
      } else {
        message.error('API Key 无管理员权限')
      }
    } catch (error) {
      const status = (error as { response?: { status?: number } })?.response?.status
      if (status === 401) {
        message.error('API Key 无效，请重试')
      } else if (status === 403) {
        message.error('API Key 无管理员权限')
      } else {
        message.error('无法连接到服务器')
      }
    } finally {
      setLoading(false)
    }
  }

  return (
    <div style={{
      minHeight: '100vh',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: '#f0f2f5',
    }}>
      <div style={{
        maxWidth: 400,
        width: '100%',
        margin: '0 16px',
        borderRadius: 12,
        overflow: 'hidden',
        boxShadow: '0 4px 24px rgba(0,0,0,0.08)',
        background: '#fff',
      }}>
        <div style={{
          background: 'linear-gradient(135deg, #1677ff 0%, #0958d9 100%)',
          padding: '36px 24px 24px',
          textAlign: 'center',
        }}>
          <div style={{ color: '#fff', fontSize: 28, fontWeight: 700, letterSpacing: 1 }}>
            AI Gateway
          </div>
          <div style={{ color: 'rgba(255,255,255,0.7)', fontSize: 14, marginTop: 4 }}>
            管理控制台
          </div>
        </div>
        <div style={{ padding: '28px 24px' }}>
          <div style={{ marginBottom: 20 }}>
            <div style={{ fontSize: 13, color: '#333', marginBottom: 6, fontWeight: 500 }}>
              管理员 API Key
            </div>
            <Input.Password
              placeholder="请输入管理员 API Key"
              prefix={<KeyOutlined style={{ color: '#bfbfbf' }} />}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              onPressEnter={handleLogin}
              size="large"
            />
          </div>
          <Button
            type="primary"
            block
            size="large"
            loading={loading}
            disabled={!apiKey.trim()}
            onClick={handleLogin}
          >
            登 录
          </Button>
          {import.meta.env.DEV && (
            <div style={{ marginTop: 12, textAlign: 'center', fontSize: 12, color: '#999' }}>
              开发模式: 仅用于本地调试，请勿在生产环境使用
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
