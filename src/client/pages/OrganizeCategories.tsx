/**
 * Categories column for Organize (Task 16).
 *
 * Renders the category tree. The tree is projected client-side from the
 * flat Category[] returned by `GET /categories`, grouped by `parent_id`.
 * All mutations go through the shared `categoriesApi` (POST/PUT/DELETE) —
 * the parent Organize page wires reload.
 *
 * The create/edit dialog is *not* rendered here: the page owns its open
 * state and asks for it through the `onCreate` / `onEdit` callbacks.
 * It used to be a self-incrementing counter handed down from the page,
 * which coupled two components through a value neither of them owned.
 */

import { useCallback, useMemo } from 'react';
import {
  App,
  Button,
  Popconfirm,
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
import { categoriesApi } from '@/api/categories';
import { StateBlock, resolveDataStatus } from '@/components/ui';
import type { Category } from '@/types';
import { tokens } from '@/theme/tokens';
import { describeError } from '@/utils/errors';

interface CategoryNodeMeta {
  _category: Category;
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
    onCreate: (parentId: string | null) => void;
    onEdit: (cat: Category) => void;
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
            onClick={() => callbacks.onCreate(cat.id)}
            aria-label={`新增 ${cat.name} 的子分类`}
          />
        </Tooltip>
        <Tooltip title="编辑">
          <Button
            size="small"
            type="text"
            icon={<EditOutlined />}
            onClick={() => callbacks.onEdit(cat)}
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
  /** `undefined` until the list has loaded successfully. */
  categories?: Category[];
  loading: boolean;
  error?: Error;
  onReload: () => Promise<void>;
  /** 新建分类；`parentId` 为 null 表示顶级分类。 */
  onCreate: (parentId: string | null) => void;
  /** 编辑一个已有分类。 */
  onEdit: (category: Category) => void;
}

export default function OrganizeCategories(props: OrganizeCategoriesProps): JSX.Element {
  const { categories, loading, error, onReload, onCreate, onEdit } = props;
  const { message } = App.useApp();

  const list = useMemo(() => categories ?? [], [categories]);

  const onDelete = useCallback(
    async (cat: Category): Promise<void> => {
      try {
        await categoriesApi.remove(cat.id);
        message.success(`已删除「${cat.name}」`);
        await onReload();
      } catch (e: unknown) {
        message.error(describeError(e, '删除分类失败'));
      }
    },
    [message, onReload],
  );

  // Tree data is built with the action renderer bound to the current
  // callbacks. Every dependency here is stable — `onCreate` / `onEdit`
  // come from the page as memoised callbacks — so the memo actually hits
  // instead of being invalidated on every render.
  const treeNodes = useMemo<DataNode[]>(() => {
    const baseNodes = buildCategoryTree(list);
    const decorate = (nodes: DataNode[]): DataNode[] =>
      nodes.map((n) => {
        const cat = (n as DataNode & CategoryNodeMeta)._category;
        const decoratedChildren = n.children && n.children.length > 0 ? decorate(n.children) : undefined;
        const decorated: DataNode = {
          ...n,
          title: cat ? renderCategoryTitle(cat, { onCreate, onEdit, onDelete }) : n.title,
          children: decoratedChildren,
        };
        return decorated;
      });
    return decorate(baseNodes);
  }, [list, onCreate, onEdit, onDelete]);

  // `useApi` flips `loading` inside an effect, so the very first frame has
  // neither data nor an error. Treat that as "still loading" instead of
  // flashing the empty state for one frame.
  const pending = loading || (!categories && !error);
  const status = resolveDataStatus({
    loading: pending,
    error,
    hasData: !!categories,
    isEmpty: list.length === 0,
  });

  if (status === 'loading') {
    return <StateBlock status="loading" rows={5} />;
  }

  if (status === 'error') {
    return (
      <StateBlock
        status="error"
        title="加载分类失败"
        error={error}
        errorFallback="无法加载分类"
        onRetry={() => void onReload()}
      />
    );
  }

  if (status === 'empty') {
    return (
      <StateBlock
        status="empty"
        title="暂无分类"
        description="分类用于给资产归类，支持多级嵌套。"
        action={
          <Button type="primary" icon={<PlusOutlined />} onClick={() => onCreate(null)}>
            新增根分类
          </Button>
        }
      />
    );
  }

  return (
    <>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: tokens.space[3],
        }}
      >
        <span style={{ color: tokens.color.textMuted, fontSize: 12 }}>
          共 {list.length} 个分类
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
    </>
  );
}
