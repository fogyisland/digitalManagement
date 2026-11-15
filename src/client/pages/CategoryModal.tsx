/**
 * CategoryModal — create/edit dialog for Organize (Task 16).
 *
 * Lives in its own file so OrganizeCategories stays under the 500-line
 * cap. The modal owns its own Form state; the parent just toggles
 * `open`, supplies `editing` (or null for create) and the most recent
 * `parentForCreate` so the parent_id Select pre-fills from the row
 * that was clicked.
 *
 * ## Why there is no slug input
 *
 * The backend never reads a client-supplied slug. `POST /categories`
 * destructures only `{name, parent_id, description, sort_order}` and
 * stores `slugify(name)` (`src/server/routes/categories.js:62` and
 * `:76`); `PUT /categories/:id` does the same — it recomputes the slug
 * from the name whenever a name is sent (`:96` and `:104`). The old
 * editable slug field therefore accepted a value, validated it against
 * a latin-only rule the server does not even use, and then dropped it
 * on the floor. It is gone; what is left is a read-only preview of the
 * slug the server *will* derive, so the user still sees the URL they
 * are about to get.
 */

import { useEffect, useMemo } from 'react';
import { App, Form, Input, InputNumber, Select as AntSelect } from 'antd';
import { categoriesApi } from '@/api/categories';
import { FormModal } from '@/components/ui';
import type { Category } from '@/types';
import { tokens } from '@/theme/tokens';
import { describeError } from '@/utils/errors';

export interface CategoryFormValues {
  name: string;
  parent_id?: string | null;
  description?: string | null;
  sort_order?: number;
}

/**
 * Mirror of the server's `slugify` (`src/server/lib/util.js:15-21`).
 *
 * The server keeps CJK characters — the product is Chinese-first and the
 * slug is an opaque identifier, never a filesystem path — so a latin-only
 * rule on this side would not match what the server actually produces.
 */
export function previewSlug(name: string): string {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9一-龥]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

/**
 * Collect the id of `rootId` plus every descendant of it.
 *
 * The parent `<Select>` must not offer a node's own subtree: picking a
 * descendant as the parent creates a cycle, and the tree is projected
 * from the roots downwards, so every node on the cycle becomes
 * unreachable and silently disappears from the tree.
 */
function collectSubtreeIds(categories: Category[], rootId: string): Set<string> {
  const childrenByParent = new Map<string, Category[]>();
  for (const c of categories) {
    if (!c.parent_id) continue;
    const list = childrenByParent.get(c.parent_id);
    if (list) list.push(c);
    else childrenByParent.set(c.parent_id, [c]);
  }

  const subtree = new Set<string>([rootId]);
  const stack: string[] = [rootId];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    for (const child of childrenByParent.get(current) ?? []) {
      if (subtree.has(child.id)) continue;
      subtree.add(child.id);
      stack.push(child.id);
    }
  }
  return subtree;
}

/** Build the parent_id `<Select>` payload: walks the flat list,
 *  skipping the node being edited together with its whole subtree
 *  (neither may become its own ancestor), and indents descendants with
 *  em-dashes for readability. */
export function buildParentOptions(
  categories: Category[],
  editing: Category | null,
): { value: string; label: string }[] {
  const forbidden = editing ? collectSubtreeIds(categories, editing.id) : new Set<string>();
  const byParent = new Map<string | null, Category[]>();
  for (const c of categories) {
    if (forbidden.has(c.id)) continue;
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

  useEffect(() => {
    if (!open) return;
    if (editing) {
      form.setFieldsValue({
        name: editing.name,
        parent_id: editing.parent_id ?? null,
        description: editing.description ?? '',
        sort_order: editing.sort_order,
      });
    } else {
      form.resetFields();
      form.setFieldsValue({
        name: '',
        parent_id: parentForCreate,
        description: '',
        sort_order: 0,
      });
    }
  }, [open, editing, parentForCreate, form]);

  const parentOptions = useMemo(
    () => buildParentOptions(categories, editing),
    [categories, editing],
  );

  /** Live preview of the slug the server will derive from the name. */
  const nameValue = Form.useWatch('name', form);
  const slugPreview = useMemo(() => previewSlug(nameValue ?? ''), [nameValue]);

  const onSubmit = async (values: CategoryFormValues): Promise<void> => {
    const payload = {
      name: values.name.trim(),
      parent_id: values.parent_id ?? null,
      description: values.description?.trim() || null,
      sort_order: typeof values.sort_order === 'number' ? values.sort_order : 0,
    };
    try {
      if (editing) {
        await categoriesApi.update(editing.id, payload);
        message.success('已更新分类');
      } else {
        await categoriesApi.create(payload);
        message.success('已新建分类');
      }
      onSaved();
    } catch (e: unknown) {
      message.error(describeError(e, '保存分类失败'));
    }
  };

  return (
    <FormModal
      open={open}
      title={editing ? '编辑分类' : '新建分类'}
      form={form}
      onCancel={onCancel}
      onSubmit={onSubmit}
      okText={editing ? '保存' : '创建'}
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
        <Form.Item
          label="slug"
          extra="slug 由名称自动生成，保存后不可修改。"
        >
          <Input
            readOnly
            value={slugPreview || '—'}
            style={{ fontFamily: tokens.font.mono }}
          />
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
    </FormModal>
  );
}
