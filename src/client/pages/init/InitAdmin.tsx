/**
 * Setup wizard — page two: the administrator and the first tenant.
 *
 * A platform needs an owner before it can be used, and every row belongs to
 * a tenant, so this page creates both in one step. The password rule is the
 * backend's (at least ten characters, letters and digits); it is repeated
 * here so the operator sees why before submitting.
 */
import { useState } from 'react';
import { Alert, Button, Form, Input, Space, Typography } from 'antd';
import { TeamOutlined } from '@ant-design/icons';
import { describeInitError, initApi } from './initApi';
import type { AdminInput } from './initApi';
import { tokens } from '@/theme/tokens';

const { Text, Title } = Typography;

interface InitAdminProps {
  /** Go back to the database page. */
  onBack: () => void;
  /** Move on to the confirmation page. */
  onDone: (values: AdminInput) => void;
}

/** The minimum the backend accepts; kept in one place here. */
const MIN_PASSWORD_LENGTH = 10;

export default function InitAdmin({ onBack, onDone }: InitAdminProps): JSX.Element {
  const [form] = Form.useForm<AdminInput>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onFinish = async (values: AdminInput): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      await initApi.saveAdmin(values);
      onDone(values);
    } catch (err) {
      setError(describeInitError(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div>
      <Title level={3} style={{ marginBottom: tokens.space[1] }}>
        <TeamOutlined style={{ marginRight: tokens.space[2] }} />
        管理员与租户
      </Title>
      <Text type="secondary">
        创建第一个租户和它的管理员。管理员可以用这个账号登录，之后在「用户」页里添加其他成员。
      </Text>

      {error ? (
        <Alert
          type="error"
          showIcon
          style={{ marginTop: tokens.space[4] }}
          message="创建失败"
          description={error}
        />
      ) : null}

      <Form<AdminInput>
        form={form}
        layout="vertical"
        onFinish={onFinish}
        style={{ marginTop: tokens.space[5] }}
      >
        <Form.Item
          name="tenantName"
          label="租户名称"
          rules={[{ required: true, message: '请填写租户名称' }]}
        >
          <Input placeholder="例如：设计团队" autoComplete="off" />
        </Form.Item>

        <Form.Item
          name="username"
          label="管理员用户名"
          rules={[{ required: true, message: '请填写用户名' }]}
        >
          <Input placeholder="admin" autoComplete="off" />
        </Form.Item>

        <Form.Item name="email" label="邮箱（可选）">
          <Input placeholder="admin@example.com" autoComplete="off" type="email" />
        </Form.Item>

        <Form.Item
          name="password"
          label="密码"
          rules={[
            { required: true, message: '请填写密码' },
            { min: MIN_PASSWORD_LENGTH, message: `至少 ${MIN_PASSWORD_LENGTH} 位` },
            {
              validator: (_rule, value: string | undefined) => {
                const text = value || '';
                if (!text) return Promise.resolve();
                if (!/[A-Za-z]/.test(text) || !/\d/.test(text)) {
                  return Promise.reject(new Error('必须同时包含字母和数字'));
                }
                return Promise.resolve();
              },
            },
          ]}
        >
          <Input.Password placeholder="至少 10 位，包含字母和数字" autoComplete="new-password" />
        </Form.Item>

        <Form.Item style={{ marginTop: tokens.space[2] }}>
          <Space>
            <Button onClick={onBack} size="large" disabled={loading}>
              上一步
            </Button>
            <Button type="primary" htmlType="submit" loading={loading} size="large">
              创建租户与管理员
            </Button>
          </Space>
        </Form.Item>
      </Form>
    </div>
  );
}
