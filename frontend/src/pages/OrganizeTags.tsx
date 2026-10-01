/**
 * Tags column for Organize (Task 16).
 *
 * Renders the tag card cloud and the create-tag Modal. The backend
 * exposes only `POST /tags` (no PUT or DELETE), so edit/delete UI is
 * intentionally absent — see task-16-report.md concerns.
 */

import { useEffect, useState } from 'react';
import { App, Button, ColorPicker, Empty, Form, Input, Modal, Skeleton } from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import { apiClient } from '@/api/client';
import type { Tag } from '@/types/dto';
import { tokens } from '@/theme/tokens';

interface TagFormValues {
  name: string;
  slug?: string;
  color?: string;
}

const PANEL_STYLE: React.CSSProperties = {
  background: tokens.color.panel,
  border: `1px solid ${tokens.color.border}`,
  borderRadius: tokens.radius.lg,
  padding: tokens.space[4],
};

const SLUG_RULE = {
  pattern: /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
  message: 'slug 只能包含小写字母、数字与连字符',
};

function extractColorHex(value: unknown): string | null {
  if (!value) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && value !== null) {
    const obj = value as { toHexString?: () => string; toHex?: () => string };
    if (typeof obj.toHexString === 'function') return obj.toHexString();
    if (typeof obj.toHex === 'function') return obj.toHex();
  }
  return null;
}

function extractErrorMessage(err: unknown, fallback: string): string {
  if (err && typeof err === 'object' && 'response' in err) {
    const response = (err as { response?: { data?: { detail?: string; message?: string } } }).response;
    const data = response?.data;
    if (data?.detail) return String(data.detail);
    if (data?.message) return String(data.message);
  }
  if (err instanceof Error && err.message) return err.message;
  return fallback;
}

function TagModal(props: {
  open: boolean;
  onCancel: () => void;
  onSaved: () => void;
}): JSX.Element {
  const { open, onCancel, onSaved } = props;
  const { message } = App.useApp();
  const [form] = Form.useForm<TagFormValues>();
  const [submitting, setSubmitting] = useState<boolean>(false);

  useEffect(() => {
    if (!open) return;
    form.resetFields();
    form.setFieldValue('color', tokens.color.accent);
  }, [open, form]);

  const onOk = async (): Promise<void> => {
    let values: TagFormValues;
    try {
      values = await form.validateFields();
    } catch (e: unknown) {
      void e;
      return;
    }
    setSubmitting(true);
    const payload = {
      name: values.name.trim(),
      slug: values.slug && values.slug.trim() ? values.slug.trim() : values.name.trim(),
      color: extractColorHex(values.color) ?? tokens.color.accent,
    };
    try {
      await apiClient.request<Tag>({ url: '/tags', method: 'POST', data: payload });
      message.success('已新建标签');
      onSaved();
    } catch (e: unknown) {
      message.error(extractErrorMessage(e, '新建标签失败'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      title="新建标签"
      open={open}
      onCancel={onCancel}
      onOk={() => void onOk()}
      okText="创建"
      cancelText="取消"
      confirmLoading={submitting}
      destroyOnClose
      width={480}
    >
      <Form form={form} layout="vertical" preserve={false}>
        <Form.Item name="name" label="名称" rules={[{ required: true, message: '请输入标签名称' }]}>
          <Input placeholder="例如：暖色调" autoFocus />
        </Form.Item>
        <Form.Item name="slug" label="slug" rules={[SLUG_RULE]} extra="留空则按名称自动生成">
          <Input placeholder="例如：warm-tone" />
        </Form.Item>
        <Form.Item name="color" label="颜色" extra="仅作视觉提示">
          <ColorPicker defaultValue={tokens.color.accent} showText format="hex" />
        </Form.Item>
      </Form>
    </Modal>
  );
}

interface OrganizeTagsProps {
  tags: Tag[];
  loading: boolean;
  error?: Error;
  onReload: () => Promise<void>;
}

export default function OrganizeTags(props: OrganizeTagsProps): JSX.Element {
  const { tags, loading, error, onReload } = props;
  const [modalOpen, setModalOpen] = useState<boolean>(false);

  return (
    <div style={{ ...PANEL_STYLE, display: 'flex', flexDirection: 'column', gap: tokens.space[3] }}>
      <div
        style={{
          fontSize: 12,
          color: tokens.color.textMuted,
          padding: '6px 10px',
          borderRadius: tokens.radius.sm,
          background: 'rgba(245, 165, 36, 0.06)',
          border: `1px dashed ${tokens.color.border}`,
        }}
      >
        标签暂仅支持新建；编辑与删除需后端补齐 PUT / DELETE 接口（详见 task-16-report concerns）。
      </div>

      {loading && tags.length === 0 ? (
        <Skeleton active paragraph={{ rows: 3 }} />
      ) : error ? (
        <div
          style={{
            padding: tokens.space[4],
            background: 'rgba(248, 81, 73, 0.08)',
            border: `1px solid ${tokens.color.danger}`,
            borderRadius: tokens.radius.md,
            color: tokens.color.danger,
            display: 'flex',
            alignItems: 'center',
            gap: tokens.space[3],
          }}
        >
          <span>加载标签失败：{error.message}</span>
          <Button size="small" onClick={() => void onReload()}>
            重试
          </Button>
        </div>
      ) : tags.length === 0 ? (
        <Empty description={<span style={{ color: tokens.color.textMuted }}>暂无标签</span>}>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setModalOpen(true)}>
            新增标签
          </Button>
        </Empty>
      ) : (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: tokens.space[3] }}>
          {tags.map((tag) => {
            const usageColor = tag.color || tokens.color.accent;
            return (
              <div
                key={tag.id}
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 4,
                  padding: `${tokens.space[2]}px ${tokens.space[3]}px`,
                  background: tokens.color.panelAlt,
                  border: `1px solid ${tokens.color.border}`,
                  borderRadius: tokens.radius.md,
                  minWidth: 120,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span
                    aria-hidden
                    style={{
                      width: 10,
                      height: 10,
                      borderRadius: 5,
                      background: usageColor,
                      flexShrink: 0,
                    }}
                  />
                  <span style={{ color: tokens.color.text, fontWeight: 500 }}>{tag.name}</span>
                  <span
                    style={{
                      marginLeft: 'auto',
                      fontFamily: tokens.font.mono,
                      fontSize: 11,
                      padding: '0 6px',
                      borderRadius: tokens.radius.sm,
                      background: tokens.color.bgAlt,
                      color: tokens.color.textMuted,
                      border: `1px solid ${tokens.color.border}`,
                    }}
                    title="使用次数"
                  >
                    {tag.usage_count}
                  </span>
                </div>
                <span
                  style={{
                    fontFamily: tokens.font.mono,
                    fontSize: 11,
                    color: tokens.color.textMuted,
                  }}
                >
                  {tag.slug}
                </span>
              </div>
            );
          })}
        </div>
      )}

      <TagModal
        open={modalOpen}
        onCancel={() => setModalOpen(false)}
        onSaved={() => {
          setModalOpen(false);
          void onReload();
        }}
      />
    </div>
  );
}