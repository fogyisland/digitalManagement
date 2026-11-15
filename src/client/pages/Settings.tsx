/**
 * Settings.
 *
 * Three-panel workspace:
 *   - 修改密码   password change form
 *   - 个人信息   user info (mono for ids)
 *   - 系统信息   API endpoints + storage path (mono <code> blocks)
 *
 * Layout uses the shared `PageHeader` / `Panel` components; the legacy
 * `dam-card` / `page-header` classes are gone and AntD's `Descriptions` is
 * themed via `labelStyle` to match the muted eyebrow tone.
 */
import { useState, type ReactNode } from 'react';
import { App, Button, Form, Input, Space, Typography } from 'antd';
import { KeyOutlined, LockOutlined, ApiOutlined } from '@ant-design/icons';
import { authApi } from '@/api/auth';
import { useAuthStore } from '@/stores/authStore';
import { PageHeader, Panel, Pill } from '@/components/ui';
import { tokens } from '@/theme/tokens';

const { Text } = Typography;

interface PasswordFormValues {
  old_password: string;
  new_password: string;
  confirm: string;
}

const MONO_CODE_STYLE: React.CSSProperties = {
  fontFamily: tokens.font.mono,
  fontSize: tokens.fontSize.sm,
  color: tokens.color.text,
  background: tokens.color.bgAlt,
  border: `1px solid ${tokens.color.border}`,
  padding: '1px 6px',
  borderRadius: tokens.radius.sm,
};

const LABEL_STYLE: React.CSSProperties = {
  color: tokens.color.textMuted,
  fontSize: tokens.fontSize.sm,
};

/**
 * A labelled read-only value. The page shows a dozen of these; writing the
 * label/value pair out by hand each time is where the spacing drifts.
 */
function Field({
  label,
  children,
  mono = false,
}: {
  label: string;
  children: ReactNode;
  mono?: boolean;
}): JSX.Element {
  return (
    <div style={{ paddingBottom: tokens.space[3] }}>
      <Text style={LABEL_STYLE}>{label}</Text>
      <div
        style={{
          marginTop: tokens.space[1],
          color: tokens.color.text,
          fontSize: tokens.fontSize.base,
          fontFamily: mono ? tokens.font.mono : tokens.font.base,
          wordBreak: 'break-word',
        }}
      >
        {children}
      </div>
    </div>
  );
}

function roleTone(role: string | undefined): 'danger' | 'accent' | 'neutral' {
  if (role === 'admin') return 'danger';
  if (role === 'editor') return 'accent';
  return 'neutral';
}

export default function Settings(): JSX.Element {
  const { message } = App.useApp();
  const user = useAuthStore((s) => s.user);
  const [pwForm] = Form.useForm<PasswordFormValues>();
  const [loading, setLoading] = useState(false);

  const onChangePassword = async (): Promise<void> => {
    let values: PasswordFormValues;
    try {
      values = await pwForm.validateFields();
    } catch {
      // AntD has already marked the offending fields.
      return;
    }
    setLoading(true);
    try {
      await authApi.changePassword(values.old_password, values.new_password);
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
      <PageHeader
        title="设置"
        subtitle="个人账号、密码与系统信息"
      />

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(360px, 1fr))',
          gap: tokens.space[4],
          alignItems: 'start',
        }}
      >
        {/* 修改密码 */}
        <Panel
          as="section"
          title={
            <Space size="small" align="center">
              <LockOutlined style={{ color: tokens.color.accent }} />
              <span style={{ color: tokens.color.text }}>修改密码</span>
            </Space>
          }
        >
          <Form<PasswordFormValues> form={pwForm} layout="vertical">
            <Form.Item
              name="old_password"
              label={<span style={LABEL_STYLE}>当前密码</span>}
              rules={[{ required: true }]}
            >
              <Input.Password autoComplete="current-password" />
            </Form.Item>
            <Form.Item
              name="new_password"
              label={<span style={LABEL_STYLE}>新密码</span>}
              rules={[{ required: true, min: 6 }]}
            >
              <Input.Password autoComplete="new-password" />
            </Form.Item>
            <Form.Item
              name="confirm"
              label={<span style={LABEL_STYLE}>确认新密码</span>}
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
        </Panel>

        {/* 个人信息 */}
        <Panel
          as="section"
          title={
            <Space size="small" align="center">
              <KeyOutlined style={{ color: tokens.color.accent }} />
              <span style={{ color: tokens.color.text }}>个人信息</span>
            </Space>
          }
        >
          <Field label="用户名" mono>
            {user?.username ?? '—'}
          </Field>
          <Field label="邮箱">{user?.email ?? '—'}</Field>
          <Field label="显示名">{user?.display_name || '—'}</Field>
          <Field label="角色">
            <Pill
              value={user?.role ?? '—'}
              tone={roleTone(user?.role)}
              mono
            />
          </Field>
          <Field label="最近登录" mono>
            {user?.last_login_at || '—'}
          </Field>
          <Field label="注册时间" mono>
            {user?.created_at || '—'}
          </Field>
        </Panel>

        {/* 系统信息 */}
        <Panel
          as="section"
          title={
            <Space size="small" align="center">
              <ApiOutlined style={{ color: tokens.color.accent }} />
              <span style={{ color: tokens.color.text }}>系统信息</span>
            </Space>
          }
        >
          <Field label="系统名称">数字资产管理系统</Field>
          <Field label="版本" mono>
            v1.0.0
          </Field>
          <Field label="API 基础地址">
            <span style={MONO_CODE_STYLE}>{baseUrl}/api</span>
          </Field>
          <Field label="管理 API">
            <span style={MONO_CODE_STYLE}>/api/v1/*</span>
          </Field>
          <Field label="公开投递">
            <span style={MONO_CODE_STYLE}>/api/public/v1/*</span>
          </Field>
          <Field label="文档">
            <a href="/docs" target="_blank" rel="noreferrer" style={{ color: tokens.color.accent }}>
              Swagger UI
            </a>
            <span style={{ color: tokens.color.textMuted, margin: '0 6px' }}>·</span>
            <a href="/redoc" target="_blank" rel="noreferrer" style={{ color: tokens.color.accent }}>
              ReDoc
            </a>
          </Field>
          <Field label="存储">
            <span style={MONO_CODE_STYLE}>./storage</span>
            <span style={{ color: tokens.color.textMuted, marginLeft: tokens.space[2] }}>
              本地文件系统
            </span>
          </Field>
        </Panel>
      </div>
    </div>
  );
}
