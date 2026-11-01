/**
 * Settings — Task 18.
 *
 * Three-card workspace:
 *   - 修改密码   password change form
 *   - 个人信息   user info (no all-caps, mono for ids)
 *   - 系统信息   API endpoints + storage path (mono <code> blocks)
 *
 * Layout uses tokens only; the legacy `dam-card`/`page-header` classes
 * are gone and AntD's `Descriptions` is themed via `labelStyle` to match
 * the muted eyebrow tone.
 */
import { useState } from 'react';
import { App, Button, Card, Form, Input, Space, Typography } from 'antd';
import { KeyOutlined, LockOutlined, ApiOutlined } from '@ant-design/icons';
import { authApi } from '@/api/auth';
import { useAuthStore } from '@/stores/authStore';
import { tokens } from '@/theme/tokens';

const { Text, Title } = Typography;

interface PasswordFormValues {
  old_password: string;
  new_password: string;
  confirm: string;
}

const DESCRIPTIONS_LABEL_STYLE: React.CSSProperties = {
  color: tokens.color.textMuted,
  fontSize: 12,
  textTransform: 'none',
  letterSpacing: 0,
};

const MONO_CODE_STYLE: React.CSSProperties = {
  fontFamily: tokens.font.mono,
  fontSize: 12,
  color: tokens.color.text,
  background: tokens.color.bgAlt,
  border: `1px solid ${tokens.color.border}`,
  padding: '1px 6px',
  borderRadius: tokens.radius.sm,
};

function roleBadge(role: string | undefined): React.ReactNode {
  if (!role) return '—';
  const tone =
    role === 'admin'
      ? { bg: 'rgba(248, 81, 73, 0.14)', fg: tokens.color.danger }
      : role === 'editor'
        ? { bg: 'rgba(245, 165, 36, 0.14)', fg: tokens.color.accent }
        : { bg: tokens.color.bgAlt, fg: tokens.color.textMuted };
  return (
    <span
      style={{
        padding: '2px 10px',
        borderRadius: tokens.radius.sm,
        fontSize: 12,
        fontFamily: tokens.font.mono,
        background: tone.bg,
        color: tone.fg,
      }}
    >
      {role}
    </span>
  );
}

export default function Settings(): JSX.Element {
  const { message } = App.useApp();
  const user = useAuthStore((s) => s.user);
  const [pwForm] = Form.useForm<PasswordFormValues>();
  const [loading, setLoading] = useState(false);

  const onChangePassword = async (): Promise<void> => {
    const v = await pwForm.validateFields();
    setLoading(true);
    try {
      await authApi.changePassword(v.old_password, v.new_password);
      message.success('密码已更新');
      pwForm.resetFields();
    } catch {
      // interceptor handled
    } finally {
      setLoading(false);
    }
  };

  const baseUrl = window.location.origin;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.space[5] }}>
      <header>
        <Title
          level={2}
          style={{
            margin: 0,
            color: tokens.color.text,
            fontWeight: 600,
            letterSpacing: '-0.01em',
          }}
        >
          设置
        </Title>
        <Text style={{ color: tokens.color.textMuted, fontSize: 13 }}>
          个人账号、密码与系统信息
        </Text>
      </header>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(360px, 1fr))',
          gap: tokens.space[4],
        }}
      >
        {/* 修改密码 */}
        <Card
          title={
            <Space size="small" align="center">
              <LockOutlined style={{ color: tokens.color.accent }} />
              <span style={{ color: tokens.color.text }}>修改密码</span>
            </Space>
          }
          bordered={false}
          style={{
            background: tokens.color.panel,
            border: `1px solid ${tokens.color.border}`,
            borderRadius: tokens.radius.lg,
          }}
          headStyle={{
            color: tokens.color.text,
            borderBottom: `1px solid ${tokens.color.border}`,
          }}
        >
          <Form<PasswordFormValues> form={pwForm} layout="vertical">
            <Form.Item
              name="old_password"
              label={<span style={{ color: tokens.color.textMuted, fontSize: 12 }}>当前密码</span>}
              rules={[{ required: true }]}
            >
              <Input.Password autoComplete="current-password" />
            </Form.Item>
            <Form.Item
              name="new_password"
              label={<span style={{ color: tokens.color.textMuted, fontSize: 12 }}>新密码</span>}
              rules={[{ required: true, min: 6 }]}
            >
              <Input.Password autoComplete="new-password" />
            </Form.Item>
            <Form.Item
              name="confirm"
              label={<span style={{ color: tokens.color.textMuted, fontSize: 12 }}>确认新密码</span>}
              dependencies={['new_password']}
              rules={[
                { required: true },
                ({ getFieldValue }) => ({
                  validator(_, value: string | undefined) {
                    if (!value || getFieldValue('new_password') === value) {
                      return Promise.resolve();
                    }
                    return Promise.reject(new Error('两次密码不一致'));
                  },
                }),
              ]}
            >
              <Input.Password autoComplete="new-password" />
            </Form.Item>
            <Button
              type="primary"
              onClick={() => void onChangePassword()}
              loading={loading}
              block
            >
              更新密码
            </Button>
          </Form>
        </Card>

        {/* 个人信息 */}
        <Card
          title={
            <Space size="small" align="center">
              <KeyOutlined style={{ color: tokens.color.accent }} />
              <span style={{ color: tokens.color.text }}>个人信息</span>
            </Space>
          }
          bordered={false}
          style={{
            background: tokens.color.panel,
            border: `1px solid ${tokens.color.border}`,
            borderRadius: tokens.radius.lg,
          }}
          headStyle={{
            color: tokens.color.text,
            borderBottom: `1px solid ${tokens.color.border}`,
          }}
        >
          <Text style={{ color: tokens.color.textMuted, fontSize: 12 }}>用户名</Text>
          <div
            style={{
              color: tokens.color.text,
              fontFamily: tokens.font.mono,
              fontSize: 13,
              padding: `${tokens.space[1]}px 0 ${tokens.space[3]}px 0`,
            }}
          >
            {user?.username ?? '—'}
          </div>
          <Text style={{ color: tokens.color.textMuted, fontSize: 12 }}>邮箱</Text>
          <div
            style={{
              color: tokens.color.text,
              fontSize: 13,
              padding: `${tokens.space[1]}px 0 ${tokens.space[3]}px 0`,
              wordBreak: 'break-word',
            }}
          >
            {user?.email ?? '—'}
          </div>
          <Text style={{ color: tokens.color.textMuted, fontSize: 12 }}>显示名</Text>
          <div
            style={{
              color: tokens.color.text,
              fontSize: 13,
              padding: `${tokens.space[1]}px 0 ${tokens.space[3]}px 0`,
            }}
          >
            {user?.display_name || '—'}
          </div>
          <Text style={{ color: tokens.color.textMuted, fontSize: 12 }}>角色</Text>
          <div style={{ padding: `${tokens.space[1]}px 0 ${tokens.space[3]}px 0` }}>
            {roleBadge(user?.role)}
          </div>
          <Text style={{ color: tokens.color.textMuted, fontSize: 12 }}>最近登录</Text>
          <div
            style={{
              color: tokens.color.text,
              fontFamily: tokens.font.mono,
              fontSize: 12,
              padding: `${tokens.space[1]}px 0 ${tokens.space[3]}px 0`,
            }}
          >
            {user?.last_login_at || '—'}
          </div>
          <Text style={{ color: tokens.color.textMuted, fontSize: 12 }}>注册时间</Text>
          <div
            style={{
              color: tokens.color.text,
              fontFamily: tokens.font.mono,
              fontSize: 12,
              padding: `${tokens.space[1]}px 0 0`,
            }}
          >
            {user?.created_at || '—'}
          </div>
        </Card>

        {/* 系统信息 */}
        <Card
          title={
            <Space size="small" align="center">
              <ApiOutlined style={{ color: tokens.color.accent }} />
              <span style={{ color: tokens.color.text }}>系统信息</span>
            </Space>
          }
          bordered={false}
          style={{
            background: tokens.color.panel,
            border: `1px solid ${tokens.color.border}`,
            borderRadius: tokens.radius.lg,
          }}
          headStyle={{
            color: tokens.color.text,
            borderBottom: `1px solid ${tokens.color.border}`,
          }}
        >
          <Text style={{ color: tokens.color.textMuted, fontSize: 12 }}>系统名称</Text>
          <div
            style={{
              color: tokens.color.text,
              fontSize: 13,
              padding: `${tokens.space[1]}px 0 ${tokens.space[3]}px 0`,
            }}
          >
            数字资产管理系统
          </div>
          <Text style={{ color: tokens.color.textMuted, fontSize: 12 }}>版本</Text>
          <div
            style={{
              color: tokens.color.text,
              fontFamily: tokens.font.mono,
              fontSize: 12,
              padding: `${tokens.space[1]}px 0 ${tokens.space[3]}px 0`,
            }}
          >
            v1.0.0
          </div>
          <Text style={{ color: tokens.color.textMuted, fontSize: 12 }}>API 基础地址</Text>
          <div style={{ padding: `${tokens.space[1]}px 0 ${tokens.space[3]}px 0` }}>
            <span style={MONO_CODE_STYLE}>{baseUrl}/api</span>
          </div>
          <Text style={{ color: tokens.color.textMuted, fontSize: 12 }}>管理 API</Text>
          <div style={{ padding: `${tokens.space[1]}px 0 ${tokens.space[3]}px 0` }}>
            <span style={MONO_CODE_STYLE}>/api/v1/*</span>
          </div>
          <Text style={{ color: tokens.color.textMuted, fontSize: 12 }}>公开投递</Text>
          <div style={{ padding: `${tokens.space[1]}px 0 ${tokens.space[3]}px 0` }}>
            <span style={MONO_CODE_STYLE}>/api/public/v1/*</span>
          </div>
          <Text style={{ color: tokens.color.textMuted, fontSize: 12 }}>文档</Text>
          <div
            style={{
              color: tokens.color.text,
              fontSize: 13,
              padding: `${tokens.space[1]}px 0 ${tokens.space[3]}px 0`,
            }}
          >
            <a href="/docs" target="_blank" rel="noreferrer" style={{ color: tokens.color.accent }}>
              Swagger UI
            </a>
            <span style={{ color: tokens.color.textMuted, margin: '0 6px' }}>·</span>
            <a href="/redoc" target="_blank" rel="noreferrer" style={{ color: tokens.color.accent }}>
              ReDoc
            </a>
          </div>
          <Text style={{ color: tokens.color.textMuted, fontSize: 12 }}>存储</Text>
          <div style={{ padding: `${tokens.space[1]}px 0 0` }}>
            <span style={MONO_CODE_STYLE}>./storage</span>
            <span style={{ color: tokens.color.textMuted, marginLeft: tokens.space[2] }}>
              本地文件系统
            </span>
          </div>
        </Card>
      </div>
    </div>
  );
}
