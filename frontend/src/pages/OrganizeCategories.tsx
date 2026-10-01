/**
 * Categories column for Organize (Task 16).
 *
 * Renders the category tree plus a hook for the create/edit Modal
 * (extracted to CategoryModal.tsx to keep this file under the
 * 500-line cap). The tree is projected client-side from the flat
 * Category[] returned by `GET /categories`, grouped by `parent_id`.
 * All mutations go through the shared `apiClient` (POST/PUT/DELETE) —
 * the parent Organize page wires reload.
 */

import { useEffect, useMemo, useState } from 'react';
import {
  App,
  Button,
  Empty,
  Popconfirm,
  Skeleton,
  Space,
  Tooltip,
  Tree as AntTree,
} from 'antd';
import type { DataNode } from 'antd/es/tree';
import {
  DeleteOutlined,
  EditOutlined,
  FolderOutlined,
  PlusOutlined,
  ReloadOutlined,
} from '@ant-design/icons';
import { apiClient } from '@/api/client';
import type { Category } from '@/types/dto';
import { tokens } from '@/theme/tokens';
import CategoryModal from './CategoryModal';

interface CategoryNodeMeta {
  _category: Category;
}

const PANEL_STYLE: React.CSSProperties = {
  background: tokens.color.panel,
  border: `1px solid ${tokens.color.border}`,
  borderRadius: tokens.radius.lg,
  padding: tokens.space[4],
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

/** Project a flat Category[] into AntD `treeData`, sorted to mirror the
 *  server's ORDER BY (sort_order, name). The original Category is
 *  stashed on `_category` so the renderer can read fields without a
 *  second lookup. */
function buildCategoryTree(categories: Category[]): DataNode[] {
  const byParent = new Map<string | null, Category[]>();
  for (const c of categories) {
    const key = c.parent_id ?? null;
    const list = byParent.get(key);
    if (list) list.push(c);
    else byParent.set(key, [c]);
  }
  for (const list of byParent.values()) {
    list.sort(
      (a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name, 'zh-Hans-CN'),
    );
  }
  const build = (parentKey: string | null): DataNode[] => {
    const nodes = byParent.get(parentKey) ?? [];
    return nodes.map<DataNode>((c) => {
      const children = build(c.id);
      const node = {
        key: c.id,
        title: c.name,
        children: children.length ? children : undefined,
      } as DataNode & CategoryNodeMeta;
      node._category = c;
      return node;
    });
  };
  return build(null);
}

/** Row renderer used as `DataNode.title`. AntD's Tree renders whatever
 *  is on the node, so the title function lives here and is wired up
 *  via `useMemo` below with the live modal callbacks. */
function renderCategoryTitle(
  cat: Category,
  callbacks: {
    openCreate: (parentId: string | null) => void;
    openEdit: (cat: Category) => void;
    onDelete: (cat: Category) => Promise<void>;
  },
): JSX.Element {
  return (
    <Space size={6} wrap style={{ width: '100%', justifyContent: 'space-between' }}>
      <Space size={6} style={{ minWidth: 0 }}>
        <FolderOutlined style={{ color: tokens.color.accent }} aria-hidden />
        <span style={{ color: tokens.color.text }}>{cat.name}</span>
        {cat.description ? (
          <span style={{ color: tokens.color.textMuted, fontSize: 12 }}>
            · {cat.description}
          </span>
        ) : null}
        <span
          style={{
            fontFamily: tokens.font.mono,
            fontSize: 11,
            color: tokens.color.textMuted,
            background: tokens.color.bgAlt,
            border: `1px solid ${tokens.color.border}`,
            padding: '0 6px',
            borderRadius: tokens.radius.sm,
          }}
        >
          {cat.slug}
        </span>
      </Space>
      <Space size={0} onClick={(e) => e.stopPropagation()}>
        <Tooltip title="新增子分类">
          <Button
            size="small"
            type="text"
            icon={<PlusOutlined />}
            onClick={() => callbacks.openCreate(cat.id)}
            aria-label={`新增 ${cat.name} 的子分类`}
          />
        </Tooltip>
        <Tooltip title="编辑">
          <Button
            size="small"
            type="text"
            icon={<EditOutlined />}
            onClick={() => callbacks.openEdit(cat)}
            aria-label={`编辑 ${cat.name}`}
          />
        </Tooltip>
        <Popconfirm
          title="删除该分类？"
          description="子分类将提升一级，资产将变为未分类。"
          okText="删除"
          cancelText="取消"
          okButtonProps={{ danger: true }}
          onConfirm={() => void callbacks.onDelete(cat)}
        >
          <Button
            size="small"
            type="text"
            danger
            icon={<DeleteOutlined />}
            aria-label={`删除 ${cat.name}`}
          />
        </Popconfirm>
      </Space>
    </Space>
  );
}

interface OrganizeCategoriesProps {
  categories: Category[];
  loading: boolean;
  error?: Error;
  onReload: () => Promise<void>;
  /** Incrementing counter — when it changes, the modal opens in
   *  "create root" mode. Provided by the parent so the header
   *  "新增根分类" button can drive the modal from outside. */
  createRootTick?: number;
}

export default function OrganizeCategories(props: OrganizeCategoriesProps): JSX.Element {
  const { categories, loading, error, onReload, createRootTick } = props;
  const { message } = App.useApp();

  const [modalOpen, setModalOpen] = useState<boolean>(false);
  const [editing, setEditing] = useState<Category | null>(null);
  const [parentForCreate, setParentForCreate] = useState<string | null>(null);
  const [lastHandledTick, setLastHandledTick] = useState<number>(0);

  const openCreate = (parentId: string | null): void => {
    setEditing(null);
    setParentForCreate(parentId);
    setModalOpen(true);
  };

  const openEdit = (cat: Category): void => {
    setEditing(cat);
    setParentForCreate(null);
    setModalOpen(true);
  };

  const closeModal = (): void => {
    setModalOpen(false);
    setEditing(null);
    setParentForCreate(null);
  };

  const onSaved = (): void => {
    closeModal();
    void onReload();
  };

  const onDelete = async (cat: Category): Promise<void> => {
    try {
      await apiClient.request<void>({ url: `/categories/${cat.id}`, method: 'DELETE' });
      message.success(`已删除「${cat.name}」`);
      await onReload();
    } catch (e: unknown) {
      message.error(extractErrorMessage(e, '删除分类失败'));
    }
  };

  // Tree data is built with the action renderer bound to current
  // state (openCreate / openEdit / onDelete), so each row's buttons
  // drive the modal correctly.
  const treeNodes = useMemo<DataNode[]>(() => {
    const baseNodes = buildCategoryTree(categories);
    const decorate = (nodes: DataNode[]): DataNode[] =>
      nodes.map((n) => {
        const cat = (n as DataNode & CategoryNodeMeta)._category;
        const decoratedChildren = n.children && n.children.length > 0 ? decorate(n.children) : undefined;
        const decorated: DataNode = {
          ...n,
          title: cat ? renderCategoryTitle(cat, { openCreate, openEdit, onDelete }) : n.title,
          children: decoratedChildren,
        };
        return decorated;
      });
    return decorate(baseNodes);
  }, [categories, openCreate, openEdit, onDelete]);

  // Open the modal in root-create mode when the parent bumps the tick.
  useEffect(() => {
    if (createRootTick === undefined) return;
    if (createRootTick === lastHandledTick) return;
    setLastHandledTick(createRootTick);
    openCreate(null);
  }, [createRootTick, lastHandledTick]);

  const modal = (
    <CategoryModal
      open={modalOpen}
      editing={editing}
      categories={categories}
      parentForCreate={parentForCreate}
      onCancel={closeModal}
      onSaved={onSaved}
    />
  );

  if (error) {
    return (
      <>
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
          <span>加载分类失败：{error.message}</span>
          <Button size="small" onClick={() => void onReload()}>
            重试
          </Button>
        </div>
        {modal}
      </>
    );
  }

  if (loading && categories.length === 0) {
    return (
      <>
        <div style={PANEL_STYLE}>
          <Skeleton active paragraph={{ rows: 5 }} />
        </div>
        {modal}
      </>
    );
  }

  if (categories.length === 0) {
    return (
      <>
        <div style={PANEL_STYLE}>
          <Empty description={<span style={{ color: tokens.color.textMuted }}>暂无分类</span>}>
            <Button type="primary" icon={<PlusOutlined />} onClick={() => openCreate(null)}>
              新增根分类
            </Button>
          </Empty>
        </div>
        {modal}
      </>
    );
  }

  return (
    <>
      <div style={PANEL_STYLE}>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: tokens.space[3],
          }}
        >
          <span style={{ color: tokens.color.textMuted, fontSize: 12 }}>
            共 {categories.length} 个分类
          </span>
          <Tooltip title="刷新">
            <Button
              size="small"
              type="text"
              icon={<ReloadOutlined />}
              onClick={() => void onReload()}
              aria-label="刷新分类"
            />
          </Tooltip>
        </div>
        <AntTree
          treeData={treeNodes}
          defaultExpandAll
          showLine={{ showLeafIcon: false }}
          selectable={false}
          blockNode
        />
      </div>
      {modal}
    </>
  );
}
