/**
 * ImportUrlTab — second tab of the Import page.
 *
 * Single URL input + optional title + source_tool. Submits via
 * `POST /assets/import-url`, which the backend serves
 * (`backend/src/routes/assets.js`): it downloads the file, stores it and
 * answers 201 with the new asset. A failed download answers 502 with a
 * `{ detail }` body, which is surfaced verbatim.
 */

import { useState } from 'react';
import {
  App,
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
      message.error(describeError(e, 'URL 导入失败'));
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
