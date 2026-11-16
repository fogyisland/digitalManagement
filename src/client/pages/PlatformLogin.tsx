/**
 * PlatformLogin — the platform door.
 *
 * One layer above every tenant. A platform administrator signs in here and
 * lands on the platform console: the tenant registry, and the MCP credentials
 * of their own account.
 *
 * A tenant administrator who tries this door is refused by the server — the
 * layer above their tenant is not theirs to enter — so the page says plainly
 * that this is not the door they want, and points back to the tenant one.
 */
import { useState } from 'react';
import { App, Button, Form, Input, Typography } from 'antd';
import {
  ArrowLeftOutlined,
  ApartmentOutlined,
  LockOutlined,
  UserOutlined,
} from '@ant-design/icons';
import { Link, useNavigate } from 'react-router-dom';
import { authApi } from '@/api/auth';
import { useAuthStore } from '@/stores/authStore';
import { useTenantStore } from '@/stores/tenantStore';
import { tokens } from '@/theme/tokens';
import { describeError } from '@/utils/errors';

const { Text, Title } = Typography;

interface PlatformLoginValues {
  username: string;
  password: string;
}

export default function PlatformLogin(): JSX.Element {
  const [loading, setLoading] = useState(false);
  const [form] = Form.useForm<PlatformLoginValues>();
  const navigate = useNavigate();
  const setAuth = useAuthStore((s) => s.setAuth);
  const { message } = App.useApp();

  const onFinish = async (values: PlatformLoginValues): Promise<void> => {
    setLoading(true);
    try {
      const resp = await authApi.platformLogin(values.username, values.password);
      setAuth(resp.user, resp.access_token, resp.refresh_token);
      // The platform layer sits above the tenants, so the session is not
      // narrowed to one: a leftover selection from a previous session would
      // silently scope the platform console to a single tenant.
      useTenantStore.getState().setTenantId(null);
      message.success(`欢迎回来，${resp.user.display_name || resp.user.username}`);
      navigate('/platform', { replace: true });
    } catch (e) {
      message.error(describeError(e, '平台登录失败'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: tokens.space[5],
        background: tokens.color.bg,
        padding: tokens.space[5],
        boxSizing: 'border-box',
      }}
    >
      <div
        aria-hidden
        style={{
          position: 'fixed',
          inset: 0,
          pointerEvents: 'none',
          background: `radial-gradient(58% 42% at 50% 0%, ${tokens.color.accentSoft}, transparent 72%)`,
        }}
      />

      <div
        style={{
          position: 'relative',
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
              平台管理
            </Title>
            <Text style={{ color: tokens.color.textMuted, fontSize: tokens.fontSize.sm }}>
              Platform Administration
            </Text>
          </div>
        </div>

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: tokens.space[2],
            marginBottom: tokens.space[4],
            color: tokens.color.textMuted,
            fontSize: tokens.fontSize.xs,
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
          }}
        >
          <ApartmentOutlined style={{ color: tokens.color.accent }} />
          平台管理员登录
        </div>

        <Form<PlatformLoginValues>
          form={form}
          layout="vertical"
          onFinish={(v) => void onFinish(v)}
          size="large"
        >
          <Form.Item
            name="username"
            label={
              <span style={{ color: tokens.color.textMuted, fontSize: tokens.fontSize.sm }}>
                用户名
              </span>
            }
            rules={[{ required: true, message: '请输入用户名' }]}
          >
            <Input
              prefix={<UserOutlined style={{ color: tokens.color.textMuted }} />}
              placeholder="平台管理员用户名"
              aria-label="用户名"
              autoComplete="username"
            />
          </Form.Item>
          <Form.Item
            name="password"
            label={
              <span style={{ color: tokens.color.textMuted, fontSize: tokens.fontSize.sm }}>
                密码
              </span>
            }
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
            <Button type="primary" htmlType="submit" loading={loading} block size="large">
              进入平台
            </Button>
          </Form.Item>
        </Form>

        <div
          style={{
            paddingTop: tokens.space[4],
            borderTop: `1px solid ${tokens.color.border}`,
            color: tokens.color.textMuted,
            fontSize: tokens.fontSize.sm,
            lineHeight: 1.6,
          }}
        >
          平台层在所有租户之上：在这里决定平台上有哪些租户、它们叫什么、
          是否停用，以及每个账户的 MCP 接入凭证。租户里的内容由租户管理员自己管。
        </div>
      </div>

      <div style={{ position: 'relative', textAlign: 'center' }}>
        <Link
          to="/login"
          style={{
            color: tokens.color.textMuted,
            fontSize: tokens.fontSize.base,
          }}
        >
          <ArrowLeftOutlined /> 返回租户登录
        </Link>
      </div>
    </div>
  );
}
