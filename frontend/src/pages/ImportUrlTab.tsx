/**
 * ImportUrlTab — second tab of the Import page.
 *
 * Single URL input + optional title + source_tool. Submits via
 * `POST /assets/import-url` (concern parked: backend does not ship this
 * route today; UI surfaces the 404 gracefully and the navigation still
 * falls back to `/library`).
 */

import { useState } from 'react';
import {
  App,
  Alert,
  Button,
  Form,
  Input,
  Select,
  Space,
  Typography,
} from 'antd';
import { LinkOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { importUrlByUrl } from '@/api/assets';
import { tokens } from '@/theme/tokens';
import { describeError } from '@/utils/parseMetadata';

const { Text, Title } = Typography;

const SOURCE_TOOL_OPTIONS: { value: string; label: string }[] = [
  { value: 'manual', label: '手动上传' },
  { value: 'comfyui', label: 'ComfyUI' },
  { value: 'admin', label: '管理后台' },
];

interface FormValues {
  url: string;
  title?: string;
  source_tool?: string;
}

export default function ImportUrlTab(): JSX.Element {
  const navigate = useNavigate();
  const { message } = App.useApp();
  const [form] = Form.useForm<FormValues>();
  const [submitting, setSubmitting] = useState<boolean>(false);

  const onSubmit = async (): Promise<void> => {
    const values = await form.validateFields();
    if (!values.url) {
      message.warning('请输入目标 URL');
      return;
    }
    setSubmitting(true);
    try {
      const asset = await importUrlByUrl({
        url: values.url,
        title: values.title,
        source_tool: values.source_tool ?? 'manual',
      });
      message.success(`已导入「${asset.title || asset.original_name}」`);
      navigate('/library');
    } catch (e: unknown) {
      const detail = describeError(e, 'URL 导入失败');
      message.error(detail);
      // The route does not exist on the backend today; if we see a 404,
      // still nudge the user back to the library so they are not stuck.
      if (detail.toLowerCase().includes('not found') || detail.includes('404')) {
        setTimeout(() => navigate('/library'), 800);
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.space[4] }}>
      <Title level={4} style={{ margin: 0, color: tokens.color.text, fontWeight: 600 }}>
        URL 抓取
      </Title>
      <Text style={{ color: tokens.color.textMuted, fontSize: 12 }}>
        给定一个外部 URL，提交后服务端会拉取并写入资产记录；同一 hash 已存在时会复用原记录。
      </Text>

      <Alert
        type="warning"
        showIcon
        message={
          <Text style={{ fontSize: 12 }}>
            当前后端尚未提供 <code>/assets/import-url</code>；提交会得到 404。
            UI 会在错误提示后自动跳转到资产库，避免阻塞。
          </Text>
        }
        style={{
          background: 'rgba(248, 81, 73, 0.08)',
          border: `1px solid ${tokens.color.danger}`,
        }}
      />

      <section
        style={{
          background: tokens.color.panel,
          border: `1px solid ${tokens.color.border}`,
          borderRadius: tokens.radius.lg,
          padding: tokens.space[4],
        }}
      >
        <Form
          form={form}
          layout="vertical"
          initialValues={{ source_tool: 'manual' }}
          requiredMark={false}
        >
          <Form.Item
            name="url"
            label="目标 URL"
            rules={[
              { required: true, message: '请输入 URL' },
              { type: 'url', message: 'URL 格式不合法' },
            ]}
          >
            <Input
              prefix={<LinkOutlined style={{ color: tokens.color.textMuted }} />}
              placeholder="https://example.com/path/to/image.png"
              allowClear
              style={{ fontFamily: tokens.font.mono, fontSize: 12 }}
            />
          </Form.Item>

          <Space size="middle" style={{ width: '100%' }} wrap>
            <Form.Item name="title" label="标题" style={{ flex: 1, minWidth: 220 }}>
              <Input placeholder="选填；留空将使用文件名" maxLength={255} allowClear />
            </Form.Item>
            <Form.Item name="source_tool" label="来源" style={{ minWidth: 160 }}>
              <Select options={SOURCE_TOOL_OPTIONS} />
            </Form.Item>
          </Space>

          <Form.Item label=" " colon={false}>
            <Space>
              <Button
                type="primary"
                onClick={() => void onSubmit()}
                loading={submitting}
              >
                抓取并导入
              </Button>
              <Button
                onClick={() => form.resetFields()}
                disabled={submitting}
              >
                清空
              </Button>
            </Space>
          </Form.Item>
        </Form>
      </section>
    </div>
  );
}
