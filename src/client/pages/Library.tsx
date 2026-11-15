import { useEffect, useMemo, useState } from 'react';
import {
  App,
  Button,
  Pagination,
  Segmented,
  Space,
  Typography,
} from 'antd';
import {
  AppstoreOutlined,
  BarsOutlined,
  DeleteOutlined,
} from '@ant-design/icons';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { apiClient } from '@/api/client';
import { assetsApi } from '@/api/assets';
import { useApi } from '@/api/hooks';
import LibraryCard from '@/components/library/LibraryCard';
import LibraryFilters, {
  type LibraryFiltersHandlers,
  type LibraryFiltersState,
} from '@/components/library/LibraryFilters';
import LibraryRow from '@/components/library/LibraryRow';
import { PageHeader, Panel, StateBlock } from '@/components/ui';
import type {
  Asset,
  AssetType,
  Category,
  PageResponse,
} from '@/types';
import { assetPreviewUrl } from '@/utils/assetUrls';
import { describeError } from '@/utils/errors';
import { tokens } from '@/theme/tokens';

const { Text } = Typography;

type ViewMode = 'grid' | 'list';

interface CategoryNode extends Category {
  children?: CategoryNode[];
}

/**
 * Flatten a possibly-nested category tree into a select-friendly list.
 * Backend currently returns a flat array (no `tree` route exists), but we
 * walk defensively so the filter still works when that changes.
 */
function flattenCategories(input: unknown): Category[] {
  const out: Category[] = [];
  const walk = (nodes: unknown) => {
    if (!Array.isArray(nodes)) return;
    for (const n of nodes) {
      if (n && typeof n === 'object') {
        out.push(n as Category);
        const children = (n as CategoryNode).children;
        if (children && children.length) walk(children);
      }
    }
  };
  walk(input);
  return out;
}

// Filter option lists (ASSET_TYPE_FILTERS, SOURCE_TOOL_OPTIONS) and the
// `<LibraryFilters>` JSX live in `frontend/src/components/library/LibraryFilters.tsx`
// to keep this page under the CLAUDE.md 500-LOC cap.

function buildQuery(params: {
  q?: string;
  assetType?: AssetType;
  categoryId?: string;
  sourceTool?: string;
  page: number;
  pageSize: number;
}): string {
  const search = new URLSearchParams();
  if (params.q) search.set('q', params.q);
  if (params.assetType) search.set('asset_type', params.assetType);
  if (params.categoryId) search.set('category_id', params.categoryId);
  if (params.sourceTool) search.set('source_tool', params.sourceTool);
  search.set('page', String(params.page));
  search.set('page_size', String(params.pageSize));
  return `/assets?${search.toString()}`;
}

// `LibraryCard` and `LibraryRow` (plus their `statusBadgeColor`,
// `statusLabel` helpers) live in
// `frontend/src/components/library/{LibraryCard,LibraryRow}.tsx` to keep
// this page under the CLAUDE.md 500-LOC cap. Preview URLs come from the
// shared `@/utils/assetUrls` helper, not from a local copy.

export default function Library(): JSX.Element {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { modal, message } = App.useApp();

  /**
   * The keyword lives in the URL, so the global header search and the
   * filter bar agree on one source of truth. It used to be a separate
   * state initialised from the URL — which meant the header search did
   * nothing while the user was already sitting on this page, because the
   * component never remounted to pick the new query up.
   */
  const appliedQ = searchParams.get('q') ?? '';

  const [keywordInput, setKeywordInput] = useState<string>(appliedQ);
  const [assetType, setAssetType] = useState<AssetType | undefined>(undefined);
  const [categoryId, setCategoryId] = useState<string | undefined>(undefined);
  const [sourceTool, setSourceTool] = useState<string | undefined>(undefined);
  const [view, setView] = useState<ViewMode>('grid');
  const [page, setPage] = useState<number>(1);
  const [pageSize, setPageSize] = useState<number>(24);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // Keep the visible input in step with the applied keyword — this is what
  // makes the header search update the box as well as the result set.
  useEffect(() => {
    setKeywordInput(appliedQ);
  }, [appliedQ]);

  const categoriesState = useApi<Category[] | CategoryNode[]>(
    '/categories',
  );
  const categories = useMemo(
    () => flattenCategories(categoriesState.data),
    [categoriesState.data],
  );

  const assetsState = useApi<PageResponse<Asset>>(
    buildQuery({ q: appliedQ, assetType, categoryId, sourceTool, page, pageSize }),
  );

  // Reset selection whenever the result set changes underneath us.
  useEffect(() => {
    setSelected(new Set());
  }, [assetsState.data]);

  const onSearch = (value: string) => {
    const trimmed = value.trim();
    setKeywordInput(trimmed);
    setPage(1);
    const next = new URLSearchParams(searchParams);
    if (trimmed) next.set('q', trimmed);
    else next.delete('q');
    setSearchParams(next, { replace: true });
  };

  const onFilterChange = (): void => {
    setPage(1);
  };

  const onToggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const onOpen = (id: string) => {
    navigate(`/library/${id}`);
  };

  const onDownload = async (asset: Asset) => {
    try {
      const r = await apiClient.post<{ download_url?: string }>(
        `/assets/${asset.id}/download`,
      );
      const url = r.data?.download_url;
      if (url) {
        window.open(url, '_blank', 'noopener');
      } else {
        const fallback = assetPreviewUrl(asset);
        if (fallback) window.open(fallback, '_blank', 'noopener');
      }
    } catch (e: unknown) {
      message.error(describeError(e, '下载失败'));
    }
  };

  const performDelete = async (ids: string[]) => {
    if (ids.length === 0) return;
    // The backend has no `/assets/batch` route, so the delete goes out one
    // asset at a time. `Promise.allSettled` tolerates partial failures so a
    // single bad id does not abort the rest.
    //
    // `permanent` is left off: the backend soft-deletes by default, which
    // moves the asset to the recycle bin and keeps the file on disk.
    const results = await Promise.allSettled(
      ids.map((id) => assetsApi.remove(id)),
    );
    const ok = results.filter((r) => r.status === 'fulfilled').length;
    const failed = ids.length - ok;
    if (ok > 0) message.success(`已移入回收站 ${ok} 项`);
    if (failed > 0) message.warning(`${failed} 项删除失败`);
    await assetsState.reload();
  };

  const onDeleteOne = (asset: Asset) => {
    modal.confirm({
      title: '删除该资产？',
      content: (
        <span>
          <Text>「{asset.title}」将移入回收站。</Text>
          <div style={{ marginTop: 6, color: tokens.color.textMuted }}>
            文件仍然保留，可随时从回收站恢复。
          </div>
        </span>
      ),
      okText: '移入回收站',
      cancelText: '取消',
      okButtonProps: { danger: true },
      onOk: () => performDelete([asset.id]),
    });
  };

  const onDeleteSelected = () => {
    if (selected.size === 0) return;
    modal.confirm({
      title: `批量删除 ${selected.size} 项资产？`,
      content: '所选资产将移入回收站，文件仍然保留，可随时从回收站恢复。',
      okText: '全部移入回收站',
      cancelText: '取消',
      okButtonProps: { danger: true },
      onOk: () => performDelete(Array.from(selected)),
    });
  };

  const onReset = () => {
    setKeywordInput('');
    setAssetType(undefined);
    setCategoryId(undefined);
    setSourceTool(undefined);
    setPage(1);
    const next = new URLSearchParams(searchParams);
    next.delete('q');
    setSearchParams(next, { replace: true });
  };

  // Bundle filter state + handlers for `<LibraryFilters>` (extracted from
  // this page to keep the file under the CLAUDE.md 500-LOC cap).
  const filterState: LibraryFiltersState = {
    keywordInput,
    assetType,
    categoryId,
    sourceTool,
  };

  const filterHandlers: LibraryFiltersHandlers = {
    onKeywordInputChange: (v) => setKeywordInput(v),
    onSearch: (v) => onSearch(v),
    onAssetTypeChange: (v) => {
      setAssetType(v);
      onFilterChange();
    },
    onCategoryIdChange: (v) => {
      setCategoryId(v);
      onFilterChange();
    },
    onSourceToolChange: (v) => {
      setSourceTool(v);
      onFilterChange();
    },
    onReset: () => onReset(),
  };

  const total = assetsState.data?.total ?? 0;
  const items = assetsState.data?.items ?? [];

  // Hover affordance for cards: reveal the action bar without forcing every
  // card to carry a permanent focus ring.
  const gridStyle: React.CSSProperties = {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
    gap: tokens.space[4],
  };

  /**
   * Exactly one of the three result states is rendered. Before, the empty
   * state and the error banner could appear together, so a failed request
   * read as "no results" with a red strip under it.
   */
  const resultStatus: 'loading' | 'empty' | 'error' | 'ready' =
    assetsState.error
      ? 'error'
      : assetsState.loading && !assetsState.data
        ? 'loading'
        : items.length === 0
          ? 'empty'
          : 'ready';

  return (
    <div className="library-root" style={{ display: 'flex', flexDirection: 'column', gap: tokens.space[5] }}>
      <PageHeader
        title="资产库"
        subtitle={
          <>
            共 {total.toLocaleString()} 项资产
            {selected.size > 0 && (
              <span style={{ color: tokens.color.accent, marginLeft: 8 }}>
                · 已选 {selected.size}
              </span>
            )}
          </>
        }
        extra={
          <Space size="middle" wrap>
            {selected.size > 0 && (
              <Button
                danger
                icon={<DeleteOutlined />}
                onClick={onDeleteSelected}
              >
                删除选中 ({selected.size})
              </Button>
            )}
            <Segmented
              value={view}
              onChange={(v) => setView(v as ViewMode)}
              options={[
                { value: 'grid', label: '网格', icon: <AppstoreOutlined /> },
                { value: 'list', label: '列表', icon: <BarsOutlined /> },
              ]}
            />
          </Space>
        }
      />

      <LibraryFilters
        state={filterState}
        handlers={filterHandlers}
        categories={categories}
        categoriesLoading={categoriesState.loading}
      />

      <section className="dam-results" data-busy={assetsState.loading && !!assetsState.data}>
        {resultStatus === 'loading' && (
          <StateBlock status="loading" rows={view === 'grid' ? 6 : 4} />
        )}

        {resultStatus === 'error' && (
          <StateBlock
            status="error"
            title="资产列表加载失败"
            error={assetsState.error}
            errorFallback="无法加载资产列表"
            onRetry={() => void assetsState.reload()}
          />
        )}

        {resultStatus === 'empty' && (
          <Panel>
            <StateBlock
              status="empty"
              title="没有匹配的资产"
              description="调整筛选条件或清空搜索关键字后再试。"
              action={
                <Button onClick={onReset}>重置筛选</Button>
              }
            />
          </Panel>
        )}

        {resultStatus === 'ready' && (
          view === 'grid' ? (
            <div style={gridStyle}>
              {items.map((asset) => (
                <LibraryCard
                  key={asset.id}
                  asset={asset}
                  isSelected={selected.has(asset.id)}
                  onToggle={onToggle}
                  onOpen={onOpen}
                  onDownload={onDownload}
                  onDelete={onDeleteOne}
                />
              ))}
            </div>
          ) : (
            <Space direction="vertical" size="small" style={{ width: '100%' }}>
              {items.map((asset) => (
                <LibraryRow
                  key={asset.id}
                  asset={asset}
                  isSelected={selected.has(asset.id)}
                  onToggle={onToggle}
                  onOpen={onOpen}
                  onDownload={onDownload}
                  onDelete={onDeleteOne}
                />
              ))}
            </Space>
          )
        )}

        {total > 0 && resultStatus !== 'error' && (
          <div
            style={{
              marginTop: tokens.space[5],
              display: 'flex',
              justifyContent: 'flex-end',
            }}
          >
            <Pagination
              current={page}
              pageSize={pageSize}
              total={total}
              showSizeChanger
              showTotal={(t) => `共 ${t} 项`}
              pageSizeOptions={[12, 24, 48, 96]}
              onChange={(p, ps) => {
                setPage(p);
                setPageSize(ps);
              }}
            />
          </div>
        )}
      </section>
    </div>
  );
}
