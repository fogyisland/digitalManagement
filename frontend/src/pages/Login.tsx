import { useState } from 'react'
import { Button, Form, Input, App, Typography } from 'antd'
import { LockOutlined, UserOutlined } from '@ant-design/icons'
import { useNavigate, useLocation } from 'react-router-dom'
import { authApi } from '@/api/auth'
import { useAuthStore } from '@/stores/authStore'

const { Text } = Typography

export default function Login() {
  const [loading, setLoading] = useState(false)
  const [form] = Form.useForm()
  const navigate = useNavigate()
  const location = useLocation()
  const setAuth = useAuthStore((s) => s.setAuth)
  const { message } = App.useApp()

  const onFinish = async (values: { username: string; password: string }) => {
    setLoading(true)
    try {
      const resp = await authApi.login(values.username, values.password)
      setAuth(resp.user, resp.access_token, resp.refresh_token)
      message.success(`欢迎回来，${resp.user.display_name || resp.user.username}`)
      const from = (location.state as any)?.from || '/'
      navigate(from, { replace: true })
    } catch {
      // error toast handled in interceptor
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="login-page">
      <div className="login-card">
        <div className="login-logo">
          <div className="logo-icon">D</div>
          <h1>数字资产管理系统</h1>
          <p>Digital Asset Management Platform</p>
        </div>

        <Form
          form={form}
          layout="vertical"
          onFinish={onFinish}
          initialValues={{ username: 'admin', password: 'Admin@123456' }}
          size="large"
        >
          <Form.Item
            name="username"
            rules={[{ required: true, message: '请输入用户名' }]}
          >
            <Input prefix={<UserOutlined />} placeholder="用户名" autoComplete="username" />
          </Form.Item>
          <Form.Item
            name="password"
            rules={[{ required: true, message: '请输入密码' }]}
          >
            <Input.Password prefix={<LockOutlined />} placeholder="密码" autoComplete="current-password" />
          </Form.Item>
          <Form.Item>
            <Button type="primary" htmlType="submit" loading={loading} block size="large">
              登 录
            </Button>
          </Form.Item>
        </Form>

        <div style={{ textAlign: 'center', marginTop: 8 }}>
          <Text type="secondary" style={{ fontSize: 12 }}>
            默认管理员：admin / Admin@123456
          </Text>
        </div>
        <div style={{ textAlign: 'center', marginTop: 4 }}>
          <Text type="secondary" style={{ fontSize: 12 }}>
            首次使用后请立即修改密码
          </Text>
        </div>
      </div>
    </div>
  )
}
