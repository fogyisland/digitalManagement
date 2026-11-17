/**
 * Organize — unified category + tag management (Task 16).
 *
 * Two-column workspace:
 *   - Left:  category tree (CRUD via POST/PUT/DELETE /categories)
 *   - Right: tag card cloud (CRUD via POST/PUT/DELETE /tags)
 *
 * The category dialog is owned by this page. The tree asks for it through
 * the `onCreate` / `onEdit` callbacks; the page holds the open state and
 * renders the dialog itself. It used to be a self-incrementing counter
 * shared between the two components — an implicit contract that both
 * sides had to keep in sync.
 */

import { useCallback, useMemo, useState } from 'react';
import { Button, Typography } from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import { useApi } from '@/api/hooks';
import { Hint, PageHeader, Panel, resolveDataStatus } from '@/components/ui';
import { useTenantWrite } from '@/hooks/useTenantWrite';
import type { Category, Tag } from '@/types';
import { tokens } from '@/theme/tokens';
import CategoryModal from './CategoryModal';
import OrganizeCategories from './OrganizeCategories';
import OrganizeTags from './OrganizeTags';

const { Title } = Typography;

/** 分类弹窗的打开意图——由树上的按钮或页头按钮发起。 */
interface CategoryModalState {
  /** 编辑中的分类；为 null 表示新建。 */
  editing: Category | null;
  /** 新建时的父分类；null 表示顶级分类。 */
  parentForCreate: string | null;
}

export default function Organize(): JSX.Element {
  const categoriesState = useApi<Category[]>('/categories');
  const tagsState = useApi<Tag[]>('/tags');

  // 平台管理员没选租户时，写入没有落点——后端会拒（`TENANT_REQUIRED`）。
  // 与其把一个注定失败的按钮摆在那儿，不如把它按住，并说清楚要怎么做。
  const { canWrite, hint } = useTenantWrite();

  const categories = categoriesState.data;
  const tags = tagsState.data;

  const categoryList = useMemo(() => categories ?? [], [categories]);

  const [categoryModal, setCategoryModal] = useState<CategoryModalState | null>(null);

  const openCreate = useCallback((parentId: string | null): void => {
    setCategoryModal({ editing: null, parentForCreate: parentId });
  }, []);

  const openEdit = useCallback((category: Category): void => {
    setCategoryModal({ editing: category, parentForCreate: null });
  }, []);

  const closeCategoryModal = useCallback((): void => {
    setCategoryModal(null);
  }, []);

  // `useApi` hands back a fresh state object on every render, but its
  // `reload` is memoised — destructure it so the callbacks below keep a
  // stable identity and the tree memo in OrganizeCategories actually hits.
  const { reload: fetchCategories } = categoriesState;
  const { reload: fetchTags } = tagsState;

  const reloadCategories = useCallback(async (): Promise<void> => {
    await fetchCategories();
  }, [fetchCategories]);

  const reloadTags = useCallback(async (): Promise<void> => {
    await fetchTags();
  }, [fetchTags]);

  const categoriesStatus = resolveDataStatus({
    loading: categoriesState.loading,
    error: categoriesState.error,
    hasData: !!categories,
    isEmpty: (categories?.length ?? 0) === 0,
  });
  const tagsStatus = resolveDataStatus({
    loading: tagsState.loading,
    error: tagsState.error,
    hasData: !!tags,
    isEmpty: (tags?.length ?? 0) === 0,
  });

  /**
   * 加载中（或失败）时不给具体数字——副标题里的 "0 个" 会和下面的
   * 骨架屏互相矛盾。
   */
  const countLabel = (status: 'loading' | 'error' | 'empty' | 'ready', count: number): string =>
    status === 'loading' || status === 'error' ? '—' : String(count);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.space[5] }}>
      <PageHeader
        title="分类与标签"
        subtitle={
          <>
            分类 {countLabel(categoriesStatus, categories?.length ?? 0)} 个 ·
            标签 {countLabel(tagsStatus, tags?.length ?? 0)} 个
          </>
        }
        extra={
          <Hint title={hint}>
            <Button
              type="primary"
              icon={<PlusOutlined />}
              disabled={!canWrite}
              onClick={() => openCreate(null)}
              aria-label="新增根分类"
            >
              新增根分类
            </Button>
          </Hint>
        }
      />

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(0, 1.4fr) minmax(0, 1fr)',
          gap: tokens.space[5],
          alignItems: 'start',
        }}
      >
        {/* === Categories column === */}
        <Panel as="section" style={{ display: 'flex', flexDirection: 'column', gap: tokens.space[3] }}>
          <Title level={4} style={{ margin: 0, color: tokens.color.text, fontWeight: 600 }}>
            分类
          </Title>
          <OrganizeCategories
            categories={categories}
            loading={categoriesState.loading}
            error={categoriesState.error}
            onReload={reloadCategories}
            onCreate={openCreate}
            onEdit={openEdit}
            canWrite={canWrite}
            hint={hint}
          />
        </Panel>

        {/* === Tags column === */}
        <Panel as="section" style={{ display: 'flex', flexDirection: 'column', gap: tokens.space[3] }}>
          <Title level={4} style={{ margin: 0, color: tokens.color.text, fontWeight: 600 }}>
            标签
          </Title>
          <OrganizeTags
            tags={tags}
            loading={tagsState.loading}
            error={tagsState.error}
            onReload={reloadTags}
            canWrite={canWrite}
            hint={hint}
          />
        </Panel>
      </div>

      <CategoryModal
        open={categoryModal !== null}
        editing={categoryModal?.editing ?? null}
        categories={categoryList}
        parentForCreate={categoryModal?.parentForCreate ?? null}
        onCancel={closeCategoryModal}
        onSaved={() => {
          closeCategoryModal();
          void reloadCategories();
        }}
      />
    </div>
  );
}
