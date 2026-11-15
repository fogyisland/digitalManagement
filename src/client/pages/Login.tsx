/**
 * Login — Task 18.
 *
 * Single-column centered form (420 px) on the dark amber background.
 * Uses design tokens only — no legacy classes (`login-card`, etc.).
 * The primary button inherits the amber accent through `damTheme.token`.
 */
import { useState } from 'react';
import { App, Button, Form, Input, Typography } from 'antd';
import { LockOutlined, UserOutlined } from '@ant-design/icons';
import { useNavigate, useLocation } from 'react-router-dom';
import { authApi } from '@/api/auth';
import { useAuthStore } from '@/stores/authStore';
import { tokens } from '@/theme/tokens';
import { describeError } from '@/utils/errors';

const { Text, Title } = Typography;

interface LoginValues {
  username: string;
  password: string;
}

export default function Login(): JSX.Element {
  const [loading, setLoading] = useState(false);
  const [form] = Form.useForm<LoginValues>();
  const navigate = useNavigate();
  const location = useLocation();
  const setAuth = useAuthStore((s) => s.setAuth);
  const { message } = App.useApp();

  const onFinish = async (values: LoginValues): Promise<void> => {
    setLoading(true);
    try {
      const resp = await authApi.login(values.username, values.password);
      setAuth(resp.user, resp.access_token, resp.refresh_token);
      message.success(`欢迎回来，${resp.user.display_name || resp.user.username}`);
      const state = (location.state as { from?: string } | null);
      const from = state?.from || '/';
      navigate(from, { replace: true });
    } catch (e) {
      // The shared response interceptor only rotates tokens and redirects on a
      // 401 — it never raises a toast — so the failure has to be reported here
      // or the operator sees nothing at all.
      message.error(describeError(e, '登录失败'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: tokens.color.bg,
        padding: tokens.space[5],
      }}
    >
      <div
        style={{
          width: 420,
          maxWidth: '100%',
          background: tokens.color.panel,
          border: `1px solid ${tokens.color.border}`,
          borderTop: `2px solid ${tokens.color.accent}`,
          borderRadius: tokens.radius.lg,
          padding: tokens.space[6],
          boxShadow: tokens.shadow.raised,
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: tokens.space[3],
            marginBottom: tokens.space[5],
          }}
        >
          <div
            aria-hidden
            style={{
              width: 40,
              height: 40,
              borderRadius: tokens.radius.md,
              background: `linear-gradient(135deg, ${tokens.color.accent} 0%, ${tokens.color.comfyui} 100%)`,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontWeight: tokens.fontWeight.bold,
              color: tokens.color.bg,
              fontSize: 18,
            }}
          >
            D
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.2 }}>
            <Title
              level={3}
              style={{
                margin: 0,
                color: tokens.color.text,
                fontWeight: 600,
                letterSpacing: '-0.01em',
              }}
            >
              数字资产管理系统
            </Title>
            <Text style={{ color: tokens.color.textMuted, fontSize: 12 }}>
              Digital Asset Management
            </Text>
          </div>
        </div>

        <Form<LoginValues>
          form={form}
          layout="vertical"
          onFinish={(v) => void onFinish(v)}
          initialValues={{ username: 'admin' }}
          size="large"
        >
          <Form.Item
            name="username"
            label={<span style={{ color: tokens.color.textMuted, fontSize: tokens.fontSize.sm }}>用户名</span>}
            rules={[{ required: true, message: '请输入用户名' }]}
          >
            <Input
              prefix={<UserOutlined style={{ color: tokens.color.textMuted }} />}
              placeholder="用户名"
              aria-label="用户名"
              autoComplete="username"
            />
          </Form.Item>
          <Form.Item
            name="password"
            label={<span style={{ color: tokens.color.textMuted, fontSize: tokens.fontSize.sm }}>密码</span>}
            rules={[{ required: true, message: '请输入密码' }]}
          >
            <Input.Password
              prefix={<LockOutlined style={{ color: tokens.color.textMuted }} />}
              placeholder="密码"
              aria-label="密码"
              autoComplete="current-password"
            />
          </Form.Item>
          <Form.Item style={{ marginBottom: tokens.space[3] }}>
            <Button
              type="primary"
              htmlType="submit"
              loading={loading}
              block
              size="large"
            >
              登录
            </Button>
          </Form.Item>
        </Form>

        <div
          style={{
            paddingTop: tokens.space[4],
            borderTop: `1px solid ${tokens.color.border}`,
            textAlign: 'center',
            color: tokens.color.textMuted,
            fontSize: tokens.fontSize.sm,
            fontFamily: tokens.font.mono,
          }}
        >
          <div>默认管理员：admin / Admin@123456</div>
          <div style={{ marginTop: tokens.space[1] }}>首次使用后请立即修改密码</div>
        </div>
      </div>
    </div>
  );
}
