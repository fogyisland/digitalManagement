/**
 * CategoryModal — create/edit dialog for Organize (Task 16).
 *
 * Lives in its own file so OrganizeCategories stays under the 500-line
 * cap. The modal owns its own Form state; the parent just toggles
 * `open`, supplies `editing` (or null for create) and the most recent
 * `parentForCreate` so the parent_id Select pre-fills from the row
 * that was clicked.
 */

import { useEffect, useMemo, useState } from 'react';
import { App, Form, Input, InputNumber, Modal, Select as AntSelect } from 'antd';
import { apiClient } from '@/api/client';
import type { Category } from '@/types';
import { tokens } from '@/theme/tokens';

export interface CategoryFormValues {
  name: string;
  slug?: string;
  parent_id?: string | null;
  description?: string | null;
  sort_order?: number;
}

const SLUG_RULE = {
  pattern: /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
  message: 'slug 只能包含小写字母、数字与连字符',
};

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

/** Build the parent_id `<Select>` payload: walks the flat list,
 *  skipping the node being edited (cannot be its own ancestor), and
 *  indents descendants with em-dashes for readability. */
export function buildParentOptions(
  categories: Category[],
  editing: Category | null,
): { value: string; label: string }[] {
  const byParent = new Map<string | null, Category[]>();
  for (const c of categories) {
    if (editing && c.id === editing.id) continue;
    const key = c.parent_id ?? null;
    const list = byParent.get(key);
    if (list) list.push(c);
    else byParent.set(key, [c]);
  }
  const opts: { value: string; label: string }[] = [];
  const walk = (parentKey: string | null, prefix: string): void => {
    const list = (byParent.get(parentKey) ?? []).slice().sort(
      (a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name, 'zh-Hans-CN'),
    );
    for (const c of list) {
      opts.push({ value: c.id, label: prefix + c.name });
      walk(c.id, prefix + '— ');
    }
  };
  walk(null, '');
  return opts;
}

export interface CategoryModalProps {
  open: boolean;
  editing: Category | null;
  categories: Category[];
  parentForCreate: string | null;
  onCancel: () => void;
  onSaved: () => void;
}

export default function CategoryModal(props: CategoryModalProps): JSX.Element {
  const { open, editing, categories, parentForCreate, onCancel, onSaved } = props;
  const { message } = App.useApp();
  const [form] = Form.useForm<CategoryFormValues>();
  const [submitting, setSubmitting] = useState<boolean>(false);

  useEffect(() => {
    if (!open) return;
    if (editing) {
      form.setFieldsValue({
        name: editing.name,
        slug: editing.slug,
        parent_id: editing.parent_id ?? null,
        description: editing.description ?? '',
        sort_order: editing.sort_order,
      });
    } else {
      form.resetFields();
      form.setFieldValue('sort_order', 0);
      form.setFieldValue('parent_id', parentForCreate);
    }
  }, [open, editing, parentForCreate, form]);

  const parentOptions = useMemo(
    () => buildParentOptions(categories, editing),
    [categories, editing],
  );

  const onOk = async (): Promise<void> => {
    let values: CategoryFormValues;
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
      parent_id: values.parent_id ?? null,
      description: values.description?.trim() || null,
      sort_order: typeof values.sort_order === 'number' ? values.sort_order : 0,
    };
    try {
      if (editing) {
        await apiClient.request<Category>({
          url: `/categories/${editing.id}`,
          method: 'PUT',
          data: payload,
        });
        message.success('已更新分类');
      } else {
        await apiClient.request<Category>({
          url: '/categories',
          method: 'POST',
          data: payload,
        });
        message.success('已新建分类');
      }
      onSaved();
    } catch (e: unknown) {
      message.error(extractErrorMessage(e, '保存分类失败'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      title={editing ? '编辑分类' : '新建分类'}
      open={open}
      onCancel={onCancel}
      onOk={() => void onOk()}
      okText={editing ? '保存' : '创建'}
      cancelText="取消"
      confirmLoading={submitting}
      destroyOnClose
      width={520}
    >
      <Form form={form} layout="vertical" preserve={false}>
        <Form.Item
          name="name"
          label="名称"
          rules={[{ required: true, message: '请输入分类名称' }]}
        >
          <Input placeholder="例如：人物" autoFocus />
        </Form.Item>
        <Form.Item name="slug" label="slug" rules={[SLUG_RULE]} extra="留空则按名称自动生成">
          <Input placeholder="例如：portrait" />
        </Form.Item>
        <Form.Item name="parent_id" label="父分类">
          <AntSelect
            allowClear
            placeholder="不选则为顶级分类"
            options={parentOptions}
            showSearch
            optionFilterProp="label"
          />
        </Form.Item>
        <Form.Item name="description" label="描述">
          <Input.TextArea rows={2} placeholder="可选说明" />
        </Form.Item>
        <Form.Item name="sort_order" label="排序" extra="数字越小越靠前">
          <InputNumber style={{ width: 160 }} />
        </Form.Item>
      </Form>
    </Modal>
  );
}
