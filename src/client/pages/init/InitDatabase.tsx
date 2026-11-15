/**
 * Setup wizard — page one: the database connection.
 *
 * The first thing a fresh installation needs is a database it can reach. The
 * page collects the connection values, hands them to `/api/init/database`,
 * and only advances once the backend has actually connected, created the
 * schema and written `.env` — so a wrong password never leaves a
 * half-configured installation behind.
 */
import { useState } from 'react';
import { Alert, Button, Col, Form, Input, InputNumber, Row, Typography } from 'antd';
import { DatabaseOutlined } from '@ant-design/icons';
import { describeInitError, initApi } from './initApi';
import type { DatabaseInput } from './initApi';
import { tokens } from '@/theme/tokens';

const { Text, Title } = Typography;

interface InitDatabaseProps {
  /** Move on to the administrator page. */
  onDone: (values: DatabaseInput) => void;
}

/**
 * The defaults a local MySQL installation almost always uses.
 *
 * They are only a starting point — the operator's values win, and the backend
 * is what decides whether they work.
 */
const DEFAULTS: DatabaseInput = {
  host: '127.0.0.1',
  port: 3306,
  user: 'root',
  password: '',
  database: 'digital_management',
};

export default function InitDatabase({ onDone }: InitDatabaseProps): JSX.Element {
  const [form] = Form.useForm<DatabaseInput>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onFinish = async (values: DatabaseInput): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      await initApi.saveDatabase(values);
      onDone(values);
    } catch (err) {
      // The wording comes from the backend (`{ detail }`), so the operator
      // sees which part of the connection failed rather than "request failed".
      setError(describeInitError(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div>
      <Title level={3} style={{ marginBottom: tokens.space[1] }}>
        <DatabaseOutlined style={{ marginRight: tokens.space[2] }} />
        数据库连接
      </Title>
      <Text type="secondary">
        填写 MySQL 的连接信息。系统会先试连，成功后自动建库、建表，并把连接参数写入 <code>.env</code>。
      </Text>

      {error ? (
        <Alert
          type="error"
          showIcon
          style={{ marginTop: tokens.space[4] }}
          message="连接失败"
          description={error}
        />
      ) : null}

      <Form<DatabaseInput>
        form={form}
        layout="vertical"
        initialValues={DEFAULTS}
        onFinish={onFinish}
        style={{ marginTop: tokens.space[5] }}
      >
        <Row gutter={tokens.space[3]}>
          <Col xs={24} md={16}>
            <Form.Item
              name="host"
              label="主机"
              rules={[{ required: true, message: '请填写主机地址' }]}
            >
              <Input placeholder="127.0.0.1" autoComplete="off" />
            </Form.Item>
          </Col>
          <Col xs={24} md={8}>
            <Form.Item
              name="port"
              label="端口"
              rules={[{ required: true, message: '请填写端口' }]}
            >
              <InputNumber min={1} max={65535} style={{ width: '100%' }} />
            </Form.Item>
          </Col>
        </Row>

        <Form.Item
          name="user"
          label="用户名"
          rules={[{ required: true, message: '请填写数据库用户名' }]}
        >
          <Input placeholder="root" autoComplete="off" />
        </Form.Item>

        <Form.Item name="password" label="密码">
          <Input.Password placeholder="没有密码时留空" autoComplete="new-password" />
        </Form.Item>

        <Form.Item
          name="database"
          label="数据库名"
          rules={[
            { required: true, message: '请填写数据库名' },
            {
              pattern: /^[A-Za-z0-9_$-]+$/,
              message: '只能包含字母、数字、下划线、连字符和美元符',
            },
          ]}
        >
          <Input placeholder="digital_management" autoComplete="off" />
        </Form.Item>

        <Form.Item style={{ marginTop: tokens.space[2] }}>
          <Button type="primary" htmlType="submit" loading={loading} block size="large">
            测试连接并创建数据表
          </Button>
        </Form.Item>
      </Form>
    </div>
  );
}
