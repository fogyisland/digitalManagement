/**
 * Tags column for Organize (Task 16).
 *
 * Renders the tag card cloud plus the create/edit Modal. The backend
 * exposes the full CRUD surface — `POST /tags`, `PUT /tags/:id` and
 * `DELETE /tags/:id` (see `backend/src/routes/tags.js`) — so editing
 * and deleting are wired up here through `tagsApi`.
 *
 * Two behaviours worth knowing:
 *   - `PUT /tags/:id` only honours `name` and `color`. The slug is
 *     re-derived from the name by the backend, never sent from here.
 *   - `DELETE /tags/:id` also drops the tag's bindings in
 *     `asset_tags`. The assets survive; they just lose that tag.
 */

import { useEffect, useState } from 'react';
import {
  App,
  Button,
  ColorPicker,
  Empty,
  Form,
  Input,
  Modal,
  Popconfirm,
  Skeleton,
  Tooltip,
} from 'antd';
import { DeleteOutlined, EditOutlined, PlusOutlined } from '@ant-design/icons';
import { tagsApi } from '@/api/tags';
import type { Tag } from '@/types';
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

interface TagModalProps {
  open: boolean;
  /** `null` = create mode, a tag = edit mode. */
  editing: Tag | null;
  onCancel: () => void;
  onSaved: () => void;
}

function TagModal({ open, editing, onCancel, onSaved }: TagModalProps): JSX.Element {
  const { message } = App.useApp();
  const [form] = Form.useForm<TagFormValues>();
  const [submitting, setSubmitting] = useState<boolean>(false);
  const isEdit = editing !== null;

  useEffect(() => {
    if (!open) return;
    form.resetFields();
    if (editing) {
      form.setFieldsValue({
        name: editing.name,
        slug: editing.slug,
        color: editing.color ?? tokens.color.accent,
      });
    } else {
      form.setFieldValue('color', tokens.color.accent);
    }
  }, [open, editing, form]);

  const onOk = async (): Promise<void> => {
    let values: TagFormValues;
    try {
      values = await form.validateFields();
    } catch (e: unknown) {
      // antd already renders the field-level validation messages.
      console.warn('[tags] validation failed:', e);
      return;
    }
    setSubmitting(true);
    const name = values.name.trim();
    const color = extractColorHex(values.color) ?? tokens.color.accent;
    try {
      if (editing) {
        await tagsApi.update(editing.id, { name, color });
        message.success('已保存');
      } else {
        await tagsApi.create({ name, color });
        message.success('已新建标签');
      }
      onSaved();
    } catch (e: unknown) {
      message.error(extractErrorMessage(e, isEdit ? '保存标签失败' : '新建标签失败'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      title={isEdit ? '编辑标签' : '新建标签'}
      open={open}
      onCancel={onCancel}
      onOk={() => void onOk()}
      okText={isEdit ? '保存' : '创建'}
      cancelText="取消"
      confirmLoading={submitting}
      destroyOnClose
      width={480}
    >
      <Form form={form} layout="vertical" preserve={false}>
        <Form.Item name="name" label="名称" rules={[{ required: true, message: '请输入标签名称' }]}>
          <Input placeholder="例如：暖色调" autoFocus />
        </Form.Item>
        <Form.Item
          name="slug"
          label="slug"
          rules={isEdit ? [] : [SLUG_RULE]}
          extra={
            isEdit
              ? 'slug 由后端按名称重新生成，此处仅供查看'
              : '留空则按名称自动生成'
          }
        >
          <Input placeholder="例如：warm-tone" disabled={isEdit} />
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
  const { message } = App.useApp();
  const [modalOpen, setModalOpen] = useState<boolean>(false);
  const [editing, setEditing] = useState<Tag | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const openCreate = (): void => {
    setEditing(null);
    setModalOpen(true);
  };

  const openEdit = (tag: Tag): void => {
    setEditing(tag);
    setModalOpen(true);
  };

  const onDelete = async (tag: Tag): Promise<void> => {
    setDeletingId(tag.id);
    try {
      await tagsApi.remove(tag.id);
      message.success(`已删除标签「${tag.name}」`);
      await onReload();
    } catch (e: unknown) {
      message.error(extractErrorMessage(e, '删除标签失败'));
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <div style={{ ...PANEL_STYLE, display: 'flex', flexDirection: 'column', gap: tokens.space[3] }}>
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
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
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
                  <Tooltip title="编辑">
                    <Button
                      size="small"
                      type="text"
                      icon={<EditOutlined />}
                      onClick={() => openEdit(tag)}
                      aria-label={`编辑标签 ${tag.name}`}
                    />
                  </Tooltip>
                  <Popconfirm
                    title="确认删除该标签？"
                    description="资产本身保留，仅解除标签绑定。"
                    okText="删除"
                    cancelText="取消"
                    okButtonProps={{ danger: true }}
                    onConfirm={() => void onDelete(tag)}
                  >
                    <Button
                      size="small"
                      type="text"
                      danger
                      loading={deletingId === tag.id}
                      icon={<DeleteOutlined />}
                      aria-label={`删除标签 ${tag.name}`}
                    />
                  </Popconfirm>
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
        editing={editing}
        onCancel={() => {
          setModalOpen(false);
          setEditing(null);
        }}
        onSaved={() => {
          setModalOpen(false);
          setEditing(null);
          void onReload();
        }}
      />
    </div>
  );
}
