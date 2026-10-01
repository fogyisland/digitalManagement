import { App, Button, Card, Form, Input, Space, Typography, Descriptions } from 'antd'
import { KeyOutlined, LockOutlined, ApiOutlined } from '@ant-design/icons'
import { useState } from 'react'
import { authApi } from '@/api/auth'
import { useAuthStore } from '@/stores/authStore'

const { Title } = Typography

export default function Settings() {
  const { message } = App.useApp()
  const user = useAuthStore((s) => s.user)
  const [pwForm] = Form.useForm()
  const [loading, setLoading] = useState(false)

  const onChangePassword = async () => {
    const v = await pwForm.validateFields()
    setLoading(true)
    try {
      await authApi.changePassword(v.old_password, v.new_password)
      message.success('密码已更新')
      pwForm.resetFields()
    } catch {
      // interceptor handled
    } finally {
      setLoading(false)
    }
  }

  const baseUrl = window.location.origin

  return (
    <div>
      <div className="page-header">
        <div>
          <h2 className="page-title">设置</h2>
          <div className="page-subtitle">个人账号、密码与系统信息</div>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(360px, 1fr))', gap: 16 }}>
        <Card title={<Space><LockOutlined /> 修改密码</Space>} bordered={false} style={{ borderRadius: 10 }}>
          <Form form={pwForm} layout="vertical" size="large">
            <Form.Item name="old_password" label="当前密码" rules={[{ required: true }]}>
              <Input.Password />
            </Form.Item>
            <Form.Item name="new_password" label="新密码" rules={[{ required: true, min: 6 }]}>
              <Input.Password />
            </Form.Item>
            <Form.Item
              name="confirm"
              label="确认新密码"
              dependencies={['new_password']}
              rules={[
                { required: true },
                ({ getFieldValue }) => ({
                  validator(_, value) {
                    if (!value || getFieldValue('new_password') === value) return Promise.resolve()
                    return Promise.reject(new Error('两次密码不一致'))
                  },
                }),
              ]}
            >
              <Input.Password />
            </Form.Item>
            <Button type="primary" onClick={onChangePassword} loading={loading} block>
              更新密码
            </Button>
          </Form>
        </Card>

        <Card title={<Space><KeyOutlined /> 个人信息</Space>} bordered={false} style={{ borderRadius: 10 }}>
          <Descriptions column={1} size="middle">
            <Descriptions.Item label="用户名">{user?.username}</Descriptions.Item>
            <Descriptions.Item label="邮箱">{user?.email}</Descriptions.Item>
            <Descriptions.Item label="显示名">{user?.display_name || '—'}</Descriptions.Item>
            <Descriptions.Item label="角色">
              <span style={{
                padding: '2px 10px', borderRadius: 4, fontSize: 12,
                background: user?.role === 'admin' ? '#fff1f0' : user?.role === 'editor' ? '#e6f4ff' : '#f5f5f5',
                color: user?.role === 'admin' ? '#ff4d4f' : user?.role === 'editor' ? '#1677ff' : '#595959',
              }}>
                {user?.role}
              </span>
            </Descriptions.Item>
            <Descriptions.Item label="最近登录">{user?.last_login_at || '—'}</Descriptions.Item>
            <Descriptions.Item label="注册时间">{user?.created_at}</Descriptions.Item>
          </Descriptions>
        </Card>

        <Card title={<Space><ApiOutlined /> 系统信息</Space>} bordered={false} style={{ borderRadius: 10 }}>
          <Descriptions column={1} size="middle">
            <Descriptions.Item label="系统名称">数字资产管理系统</Descriptions.Item>
            <Descriptions.Item label="版本">v1.0.0</Descriptions.Item>
            <Descriptions.Item label="API 基础地址">
              <code>{baseUrl}/api</code>
            </Descriptions.Item>
            <Descriptions.Item label="管理 API"><code>/api/v1/*</code></Descriptions.Item>
            <Descriptions.Item label="公开投递"><code>/api/public/v1/*</code></Descriptions.Item>
            <Descriptions.Item label="文档">
              <a href="/docs" target="_blank">Swagger UI</a> · <a href="/redoc" target="_blank">ReDoc</a>
            </Descriptions.Item>
            <Descriptions.Item label="存储">
              <code>./storage</code> （本地文件系统）
            </Descriptions.Item>
          </Descriptions>
        </Card>
      </div>
    </div>
  )
}
