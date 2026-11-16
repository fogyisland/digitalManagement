/**
 * Login — the tenant door.
 *
 * The login page belongs to a tenant: you name the tenant you are signing
 * into, and the credentials have to belong to it. The tenant list is the
 * public directory (`GET /auth/tenants`) — there is no session yet, so the
 * directory carries nothing but names.
 *
 * The platform sits one layer above every tenant, and it has its own door:
 * the link at the bottom of this page. A platform administrator signs in
 * there, and lands on the platform console rather than inside a tenant.
 *
 * Design tokens only — no legacy classes, no raw colours.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { App, Button, Form, Input, Select, Typography } from 'antd';
import {
  ArrowRightOutlined,
  BankOutlined,
  LockOutlined,
  ReloadOutlined,
  UserOutlined,
} from '@ant-design/icons';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { authApi } from '@/api/auth';
import { useAuthStore } from '@/stores/authStore';
import { tokens } from '@/theme/tokens';
import { describeError } from '@/utils/errors';
import type { TenantDirectoryEntry } from '@/types';

const { Text, Title } = Typography;

interface LoginValues {
  tenant: string;
  username: string;
  password: string;
}

export default function Login(): JSX.Element {
  const [loading, setLoading] = useState(false);
  const [directory, setDirectory] = useState<TenantDirectoryEntry[]>([]);
  const [directoryError, setDirectoryError] = useState<string | null>(null);
  const [directoryLoading, setDirectoryLoading] = useState(true);
  const [form] = Form.useForm<LoginValues>();
  const navigate = useNavigate();
  const location = useLocation();
  const setAuth = useAuthStore((s) => s.setAuth);
  const { message } = App.useApp();

  const loadDirectory = useCallback(async (): Promise<void> => {
    setDirectoryLoading(true);
    try {
      const response = await authApi.tenants();
      setDirectory(response.items);
      setDirectoryError(null);
    } catch (e: unknown) {
      setDirectory([]);
      setDirectoryError(describeError(e, '无法读取租户列表'));
    } finally {
      setDirectoryLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadDirectory();
  }, [loadDirectory]);

  const tenantOptions = useMemo(
    () =>
      directory.map((tenant) => ({
        value: tenant.id,
        label: tenant.name,
        disabled: tenant.status !== 'active',
        tenant,
      })),
    [directory],
  );

  const onFinish = async (values: LoginValues): Promise<void> => {
    setLoading(true);
    try {
      const resp = await authApi.login(values.username, values.password, values.tenant);
      setAuth(resp.user, resp.access_token, resp.refresh_token);
      // A tenant account belongs to exactly one tenant, and the session the
      // server opened is already scoped to it. A platform administrator has its
      // own door one layer up — the server refuses this one for them — so
      // there is no tenant to narrow here.
      message.success(`欢迎回来，${resp.user.display_name || resp.user.username}`);
      const state = (location.state as { from?: string } | null);
      const from = state?.from || '/';
      navigate(from, { replace: true });
    } catch (e) {
      // The shared response interceptor only rotates tokens and redirects on a
      // 401 — it never raises a toast — so the failure has to be reported here
      // or the operator sees nothing at all.
      const status = (e as { response?: { status?: number } } | null)?.response?.status;
      message.error(
        status === 403
          ? '这个账号是平台管理员，请用页面底部的「平台管理登录」进入'
          : describeError(e, '登录失败'),
      );
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
              数字资产管理系统
            </Title>
            <Text style={{ color: tokens.color.textMuted, fontSize: tokens.fontSize.sm }}>
              Digital Asset Management
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
          <BankOutlined style={{ color: tokens.color.accent }} />
          租户登录
        </div>

        {directoryError && (
          <div
            role="alert"
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: tokens.space[3],
              marginBottom: tokens.space[4],
              padding: `${tokens.space[2]} ${tokens.space[3]}`,
              borderRadius: tokens.radius.md,
              border: `1px solid ${tokens.color.border}`,
              background: tokens.color.dangerFaint,
              color: tokens.color.text,
              fontSize: tokens.fontSize.sm,
            }}
          >
            <span>{directoryError}</span>
            <Button
              size="small"
              type="text"
              icon={<ReloadOutlined />}
              onClick={() => void loadDirectory()}
            >
              重试
            </Button>
          </div>
        )}

        <Form<LoginValues>
          form={form}
          layout="vertical"
          onFinish={(v) => void onFinish(v)}
          initialValues={{ username: 'admin' }}
          size="large"
        >
          <Form.Item
            name="tenant"
            label={
              <span style={{ color: tokens.color.textMuted, fontSize: tokens.fontSize.sm }}>
                租户
              </span>
            }
            extra={
              <span style={{ color: tokens.color.textMuted, fontSize: tokens.fontSize.xs }}>
                你要进入哪个租户 · 平台管理员请用页面底部的「平台管理登录」
              </span>
            }
            rules={
              directoryError
                ? []
                : [{ required: true, message: '请选择要登录的租户' }]
            }
          >
            <Select
              placeholder={directoryLoading ? '正在读取租户…' : '选择要登录的租户'}
              showSearch
              optionFilterProp="label"
              loading={directoryLoading}
              disabled={directoryError !== null}
              options={tenantOptions}
              suffixIcon={<BankOutlined style={{ color: tokens.color.textMuted }} />}
              optionRender={(option) => (
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: tokens.space[3],
                  }}
                >
                  <span>{option.data.tenant.name}</span>
                  <span
                    style={{
                      fontFamily: tokens.font.mono,
                      fontSize: tokens.fontSize.xs,
                      color: tokens.color.textMuted,
                    }}
                  >
                    {option.data.tenant.id}
                  </span>
                </div>
              )}
            />
          </Form.Item>

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
              placeholder="用户名"
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

      <div style={{ position: 'relative', textAlign: 'center' }}>
        <Link
          to="/platform/login"
          style={{
            color: tokens.color.accent,
            fontSize: tokens.fontSize.base,
            fontWeight: tokens.fontWeight.medium,
          }}
        >
          平台管理登录 <ArrowRightOutlined />
        </Link>
        <div
          style={{
            marginTop: tokens.space[1],
            color: tokens.color.textMuted,
            fontSize: tokens.fontSize.xs,
          }}
        >
          平台管理员从这里进入平台层
        </div>
      </div>
    </div>
  );
}
