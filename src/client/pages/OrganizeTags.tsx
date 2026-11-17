/**
 * Tags column for Organize (Task 16).
 *
 * Renders the tag card cloud plus the create/edit Modal. The backend
 * exposes the full CRUD surface — `POST /tags`, `PUT /tags/:id` and
 * `DELETE /tags/:id` (see `src/server/routes/tags.js`) — so editing
 * and deleting are wired up here through `tagsApi`.
 *
 * Two behaviours worth knowing:
 *   - `POST /tags` destructures only `{name, color, description}` and
 *     stores `slugify(name)` (`src/server/routes/tags.js:45` and `:53`);
 *     `PUT /tags/:id` takes `{name, color}` and re-derives the slug from
 *     the name (`:69` and `:73`). The slug is therefore never sent from
 *     here — the old slug input was accepted and then dropped.
 *   - `DELETE /tags/:id` also drops the tag's bindings in
 *     `asset_tags`. The assets survive; they just lose that tag.
 */

import { useEffect, useMemo, useState } from 'react';
import {
  App,
  Button,
  ColorPicker,
  Form,
  Input,
  Popconfirm,
} from 'antd';
import { DeleteOutlined, EditOutlined, PlusOutlined } from '@ant-design/icons';
import { tagsApi } from '@/api/tags';
import { FormModal, Hint, Pill, StateBlock, resolveDataStatus } from '@/components/ui';
import type { Tag } from '@/types';
import { tokens } from '@/theme/tokens';
import { describeError } from '@/utils/errors';

interface TagFormValues {
  name: string;
  /**
   * 取色器回传的是 Color 对象，提交前由 `extractColorHex` 归一化成 hex。
   * 存库时写回的是 hex 字符串，`ColorPicker` 的 `value` 同样接受字符串。
   */
  color?: string | { toHexString?: () => string; toHex?: () => string };
}

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
  const isEdit = editing !== null;

  useEffect(() => {
    if (!open) return;
    form.resetFields();
    if (editing) {
      form.setFieldsValue({
        name: editing.name,
        // 存库的是 hex 字符串，ColorPicker 的 value 直接接受字符串。
        color: editing.color ?? tokens.color.accent,
      });
    } else {
      form.setFieldsValue({ color: tokens.color.accent });
    }
  }, [open, editing, form]);

  const onSubmit = async (values: TagFormValues): Promise<void> => {
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
      message.error(describeError(e, isEdit ? '保存标签失败' : '新建标签失败'));
    }
  };

  return (
    <FormModal
      open={open}
      title={isEdit ? '编辑标签' : '新建标签'}
      form={form}
      onCancel={onCancel}
      onSubmit={onSubmit}
      okText={isEdit ? '保存' : '创建'}
      width={480}
      // AntD 会把字段级错误标在输入框下方；这里再兜一次底，
      // 免得整表校验失败时用户什么也看不到。
      onValidationError={() => message.error('请检查表单填写')}
    >
      <Form form={form} layout="vertical" preserve={false}>
        <Form.Item name="name" label="名称" rules={[{ required: true, message: '请输入标签名称' }]}>
          <Input placeholder="例如：暖色调" autoFocus />
        </Form.Item>
        <Form.Item
          name="color"
          label="颜色"
          extra="仅作视觉提示；标签的 slug 由名称自动生成。"
        >
          <ColorPicker showText format="hex" />
        </Form.Item>
      </Form>
    </FormModal>
  );
}

interface OrganizeTagsProps {
  /** `undefined` until the list has loaded successfully. */
  tags?: Tag[];
  loading: boolean;
  error?: Error;
  onReload: () => Promise<void>;
  /** 现在能不能写——平台管理员没选租户时不能写。 */
  canWrite: boolean;
  /** 不能写的时候，怎么才能写。 */
  hint: string | null;
}

export default function OrganizeTags(props: OrganizeTagsProps): JSX.Element {
  const { tags, loading, error, onReload, canWrite, hint } = props;
  const { message } = App.useApp();
  const [modalOpen, setModalOpen] = useState<boolean>(false);
  const [editing, setEditing] = useState<Tag | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const list = useMemo(() => tags ?? [], [tags]);

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
      message.error(describeError(e, '删除标签失败'));
    } finally {
      setDeletingId(null);
    }
  };

  // `useApi` flips `loading` inside an effect, so the very first frame has
  // neither data nor an error. Treat that as "still loading" instead of
  // flashing the empty state for one frame.
  const pending = loading || (!tags && !error);
  const status = resolveDataStatus({
    loading: pending,
    error,
    hasData: !!tags,
    isEmpty: list.length === 0,
  });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.space[3] }}>
      {status === 'loading' && <StateBlock status="loading" rows={3} />}

      {status === 'error' && (
        <StateBlock
          status="error"
          title="加载标签失败"
          error={error}
          errorFallback="无法加载标签"
          onRetry={() => void onReload()}
        />
      )}

      {status === 'empty' && (
        <StateBlock
          status="empty"
          title="暂无标签"
          description="标签用于给资产打标记。"
          action={
            <Hint title={hint}>
              <Button
                type="primary"
                icon={<PlusOutlined />}
                disabled={!canWrite}
                onClick={openCreate}
              >
                新增标签
              </Button>
            </Hint>
          }
        />
      )}

      {status === 'ready' && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: tokens.space[3] }}>
          {list.map((tag) => {
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
                  <span title="使用次数" style={{ marginLeft: 'auto' }}>
                    <Pill value={tag.usage_count} tone="accent" />
                  </span>
                  <Hint title={canWrite ? '编辑' : hint}>
                    <Button
                      size="small"
                      type="text"
                      icon={<EditOutlined />}
                      disabled={!canWrite}
                      onClick={() => openEdit(tag)}
                      aria-label={`编辑标签 ${tag.name}`}
                    />
                  </Hint>
                  {/* 删除按钮住在 Popconfirm 里面，而 Popconfirm 要一个 DOM
                      节点挂载——所以提示包的是外面那层 span，而不是插在两者
                      中间。 */}
                  <Hint title={canWrite ? null : hint}>
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
                        disabled={!canWrite}
                        loading={deletingId === tag.id}
                        icon={<DeleteOutlined />}
                        aria-label={`删除标签 ${tag.name}`}
                      />
                    </Popconfirm>
                  </Hint>
                </div>
                <Pill value={tag.slug} tone="neutral" mono />
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
