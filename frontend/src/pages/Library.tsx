import { useEffect, useMemo, useState } from 'react';
import {
  App,
  Button,
  Checkbox,
  Empty,
  Input,
  Pagination,
  Segmented,
  Select,
  Skeleton,
  Space,
  Spin,
  Tooltip,
  Typography,
} from 'antd';
import {
  AppstoreOutlined,
  BarsOutlined,
  DeleteOutlined,
  DownloadOutlined,
  FileImageOutlined,
  PlayCircleOutlined,
  SearchOutlined,
} from '@ant-design/icons';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { apiClient } from '@/api/client';
import { useApi } from '@/api/hooks';
import type {
  Asset,
  AssetStatus,
  AssetType,
  Category,
  PageResp,
} from '@/types/dto';
import { tokens } from '@/theme/tokens';
import { formatBytes } from '@/utils/format';

const { Text, Title } = Typography;

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

/**
 * The backend exposes `thumbnail_path` (relative to STORAGE_DIR, e.g.
 * `thumbnails/abc.jpg`) and `storage_path` (e.g. `originals/abc.png`).
 * Static is served at `/storage/*` by `express.static` so we just join.
 */
function previewUrl(asset: Pick<Asset, 'thumbnail_path' | 'storage_path'>): string | null {
  const raw = asset.thumbnail_path || asset.storage_path;
  if (!raw) return null;
  if (/^https?:\/\//.test(raw)) return raw;
  const normalized = raw.startsWith('/') ? raw : `/storage/${raw}`;
  return normalized.replace(/^\/api\/v1\/storage\//, '/storage/');
}

const ASSET_TYPE_FILTERS: { value: AssetType; label: string }[] = [
  { value: 'image', label: '图片' },
  { value: 'video', label: '视频' },
  { value: 'other', label: '其他' },
];

// `/api/v1/assets/source-tools` does not exist in this milestone; the
// reasonable hardcoded set covers every value `processUpload` writes.
const SOURCE_TOOL_OPTIONS = [
  { value: 'comfyui', label: 'ComfyUI' },
  { value: 'manual', label: '手动上传' },
  { value: 'admin', label: '管理后台' },
];

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

function statusBadgeColor(status: AssetStatus): string {
  switch (status) {
    case 'ready':
      return tokens.color.success;
    case 'processing':
      return tokens.color.jobBadge;
    case 'failed':
      return tokens.color.danger;
    case 'deleted':
      return tokens.color.textMuted;
    default:
      return tokens.color.textMuted;
  }
}

function statusLabel(status: AssetStatus): string {
  switch (status) {
    case 'ready':
      return '就绪';
    case 'processing':
      return '处理中';
    case 'failed':
      return '失败';
    case 'deleted':
      return '已删除';
    default:
      return status;
  }
}

interface CardProps {
  asset: Asset;
  isSelected: boolean;
  onToggle: (id: string) => void;
  onOpen: (id: string) => void;
  onDownload: (asset: Asset) => void;
  onDelete: (asset: Asset) => void;
}

function LibraryCard({
  asset,
  isSelected,
  onToggle,
  onOpen,
  onDownload,
  onDelete,
}: CardProps): JSX.Element {
  const isVideo = asset.asset_type === 'video';
  const url = previewUrl(asset);

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onOpen(asset.id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen(asset.id);
        }
      }}
      style={{
        position: 'relative',
        background: tokens.color.panel,
        border: `1px solid ${
          isSelected ? tokens.color.accent : tokens.color.border
        }`,
        borderRadius: tokens.radius.lg,
        overflow: 'hidden',
        cursor: 'pointer',
        transition: 'border-color 120ms ease, transform 120ms ease',
        boxShadow: isSelected
          ? `inset 0 0 0 1px ${tokens.color.accent}`
          : 'none',
        outline: 'none',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.borderColor = isSelected
          ? tokens.color.accent
          : tokens.color.borderStrong;
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.borderColor = isSelected
          ? tokens.color.accent
          : tokens.color.border;
      }}
    >
      {/* left accent stripe for selected — the page's one memorable beat */}
      {isSelected && (
        <span
          aria-hidden
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            width: 2,
            height: '100%',
            background: tokens.color.accent,
            pointerEvents: 'none',
          }}
        />
      )}
      <div
        onClick={(e) => {
          e.stopPropagation();
          onToggle(asset.id);
        }}
        style={{
          position: 'absolute',
          top: tokens.space[2],
          left: tokens.space[2],
          zIndex: 2,
          background: 'rgba(13, 17, 23, 0.72)',
          borderRadius: tokens.radius.sm,
          padding: 4,
          backdropFilter: 'blur(2px)',
        }}
      >
        <Checkbox
          checked={isSelected}
          onChange={() => onToggle(asset.id)}
          onClick={(e) => e.stopPropagation()}
        />
      </div>

      <div
        style={{
          position: 'relative',
          aspectRatio: '4 / 3',
          background: tokens.color.bgAlt,
          overflow: 'hidden',
        }}
      >
        {url ? (
          // eslint-disable-next-line jsx-a11y/alt-text -- preview fallback below covers missing alt
          <img
            src={url}
            alt={asset.title}
            loading="lazy"
            style={{
              width: '100%',
              height: '100%',
              objectFit: 'cover',
              display: 'block',
            }}
          />
        ) : (
          <div
            style={{
              width: '100%',
              height: '100%',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: tokens.color.textMuted,
              fontSize: 36,
            }}
          >
            {isVideo ? <PlayCircleOutlined /> : <FileImageOutlined />}
          </div>
        )}
        {isVideo && (
          <span
            style={{
              position: 'absolute',
              top: tokens.space[2],
              right: tokens.space[2],
              padding: '2px 8px',
              fontSize: 11,
              color: tokens.color.text,
              background: 'rgba(13, 17, 23, 0.78)',
              borderRadius: tokens.radius.sm,
            }}
          >
            视频
          </span>
        )}
        {asset.status !== 'ready' && (
          <span
            style={{
              position: 'absolute',
              bottom: tokens.space[2],
              right: tokens.space[2],
              padding: '2px 8px',
              fontSize: 11,
              color: statusBadgeColor(asset.status),
              background: 'rgba(13, 17, 23, 0.78)',
              borderRadius: tokens.radius.sm,
            }}
          >
            {statusLabel(asset.status)}
          </span>
        )}
        <div
          className="library-card-actions"
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            bottom: 0,
            padding: tokens.space[2],
            background: 'linear-gradient(to top, rgba(13, 17, 23, 0.92), rgba(13, 17, 23, 0))',
            display: 'flex',
            justifyContent: 'flex-end',
            gap: tokens.space[2],
            opacity: 0,
            transition: 'opacity 140ms ease',
          }}
        >
          <Tooltip title="下载原始文件">
            <Button
              size="small"
              icon={<DownloadOutlined />}
              onClick={(e) => {
                e.stopPropagation();
                onDownload(asset);
              }}
            />
          </Tooltip>
          <Tooltip title="删除">
            <Button
              size="small"
              danger
              icon={<DeleteOutlined />}
              onClick={(e) => {
                e.stopPropagation();
                onDelete(asset);
              }}
            />
          </Tooltip>
        </div>
      </div>

      <div
        style={{
          padding: `${tokens.space[3]}px ${tokens.space[3]}px ${tokens.space[3]}px ${tokens.space[3] + (isSelected ? 4 : 0)}px`,
          transition: 'padding-left 120ms ease',
        }}
      >
        <Text
          strong
          ellipsis
          style={{
            display: 'block',
            color: tokens.color.text,
            fontSize: 14,
            lineHeight: 1.4,
          }}
          title={asset.title}
        >
          {asset.title}
        </Text>
        <div
          style={{
            marginTop: 4,
            display: 'flex',
            gap: tokens.space[3],
            color: tokens.color.textMuted,
            fontSize: 12,
            fontFamily: tokens.font.mono,
          }}
        >
          <span>{asset.asset_type}</span>
          <span>{formatBytes(asset.file_size)}</span>
          {asset.width && asset.height && (
            <span>
              {asset.width}×{asset.height}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

interface RowProps {
  asset: Asset;
  isSelected: boolean;
  onToggle: (id: string) => void;
  onOpen: (id: string) => void;
  onDownload: (asset: Asset) => void;
  onDelete: (asset: Asset) => void;
}

function LibraryRow({
  asset,
  isSelected,
  onToggle,
  onOpen,
  onDownload,
  onDelete,
}: RowProps): JSX.Element {
  const isVideo = asset.asset_type === 'video';
  const url = previewUrl(asset);

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: tokens.space[3],
        padding: `${tokens.space[2]}px ${tokens.space[3]}px`,
        background: isSelected ? 'rgba(245, 165, 36, 0.06)' : tokens.color.panel,
        border: `1px solid ${
          isSelected ? tokens.color.accent : tokens.color.border
        }`,
        borderRadius: tokens.radius.md,
        cursor: 'pointer',
        transition: 'background 120ms ease, border-color 120ms ease',
      }}
      onClick={() => onOpen(asset.id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen(asset.id);
        }
      }}
      role="button"
      tabIndex={0}
    >
      <Checkbox
        checked={isSelected}
        onClick={(e) => e.stopPropagation()}
        onChange={() => onToggle(asset.id)}
      />
      <div
        style={{
          width: 48,
          height: 48,
          flexShrink: 0,
          background: tokens.color.bgAlt,
          borderRadius: tokens.radius.sm,
          overflow: 'hidden',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: tokens.color.textMuted,
        }}
      >
        {url ? (
          <img
            src={url}
            alt={asset.title}
            loading="lazy"
            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
          />
        ) : isVideo ? (
          <PlayCircleOutlined />
        ) : (
          <FileImageOutlined />
        )}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <Text
          strong
          ellipsis
          style={{ display: 'block', color: tokens.color.text }}
        >
          {asset.title}
        </Text>
        <Text
          style={{
            display: 'block',
            color: tokens.color.textMuted,
            fontSize: 12,
            fontFamily: tokens.font.mono,
          }}
        >
          {asset.asset_type} · {formatBytes(asset.file_size)}
          {asset.source_tool ? ` · ${asset.source_tool}` : ''}
        </Text>
      </div>
      <Space size="small">
        <Button
          size="small"
          icon={<DownloadOutlined />}
          onClick={(e) => {
            e.stopPropagation();
            onDownload(asset);
          }}
        />
        <Button
          size="small"
          danger
          icon={<DeleteOutlined />}
          onClick={(e) => {
            e.stopPropagation();
            onDelete(asset);
          }}
        />
      </Space>
    </div>
  );
}

export default function Library(): JSX.Element {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { modal, message } = App.useApp();

  // q lives in the URL so the global header search lands here too.
  const initialQ = searchParams.get('q') ?? '';

  const [keywordInput, setKeywordInput] = useState<string>(initialQ);
  const [q, setQ] = useState<string>(initialQ);
  const [assetType, setAssetType] = useState<AssetType | undefined>(undefined);
  const [categoryId, setCategoryId] = useState<string | undefined>(undefined);
  const [sourceTool, setSourceTool] = useState<string | undefined>(undefined);
  const [view, setView] = useState<ViewMode>('grid');
  const [page, setPage] = useState<number>(1);
  const [pageSize, setPageSize] = useState<number>(24);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const categoriesState = useApi<Category[] | CategoryNode[]>(
    '/categories',
  );
  const categories = useMemo(
    () => flattenCategories(categoriesState.data),
    [categoriesState.data],
  );

  const assetsState = useApi<PageResp<Asset>>(
    buildQuery({ q, assetType, categoryId, sourceTool, page, pageSize }),
  );

  // Reset selection whenever the result set changes underneath us.
  useEffect(() => {
    setSelected(new Set());
  }, [assetsState.data]);

  // Sync q back to the URL when the user submits a search.
  const onSearch = (value: string) => {
    const trimmed = value.trim();
    setQ(trimmed);
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
        const fallback = previewUrl(asset);
        if (fallback) window.open(fallback, '_blank', 'noopener');
      }
    } catch (e: unknown) {
      const detail =
        e && typeof e === 'object' && 'message' in e
          ? String((e as { message: unknown }).message)
          : '下载失败';
      message.error(detail);
    }
  };

  const performDelete = async (ids: string[]) => {
    if (ids.length === 0) return;
    // /api/v1/assets/batch does not exist yet; fall back to per-item delete
    // and tolerate partial failures so a single bad id does not abort the rest.
    const results = await Promise.allSettled(
      ids.map((id) => apiClient.delete(`/assets/${id}`)),
    );
    const ok = results.filter((r) => r.status === 'fulfilled').length;
    const failed = ids.length - ok;
    if (ok > 0) message.success(`已删除 ${ok} 项`);
    if (failed > 0) message.warning(`${failed} 项删除失败`);
    await assetsState.reload();
  };

  const onDeleteOne = (asset: Asset) => {
    modal.confirm({
      title: '删除该资产？',
      content: (
        <span>
          <Text>「{asset.title}」将被永久删除。</Text>
          {selected.size > 1 && (
            <div style={{ marginTop: 6, color: tokens.color.textMuted }}>
              该操作不影响其他已选项。
            </div>
          )}
        </span>
      ),
      okText: '删除',
      cancelText: '取消',
      okButtonProps: { danger: true },
      onOk: () => performDelete([asset.id]),
    });
  };

  const onDeleteSelected = () => {
    if (selected.size === 0) return;
    modal.confirm({
      title: `批量删除 ${selected.size} 项资产？`,
      content: '此操作不可撤销，文件将从磁盘移除。',
      okText: '全部删除',
      cancelText: '取消',
      okButtonProps: { danger: true },
      onOk: () => performDelete(Array.from(selected)),
    });
  };

  const onReset = () => {
    setKeywordInput('');
    setQ('');
    setAssetType(undefined);
    setCategoryId(undefined);
    setSourceTool(undefined);
    setPage(1);
    const next = new URLSearchParams(searchParams);
    next.delete('q');
    setSearchParams(next, { replace: true });
  };

  const total = assetsState.data?.total ?? 0;
  const items = assetsState.data?.items ?? [];

  // Hover affordance for cards: reveal action bar without forcing every
  // card to have a focus ring. CSS-in-JS keeps it inside the token system.
  const gridStyle: React.CSSProperties = {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
    gap: tokens.space[4],
  };

  return (
    <div className="library-root">
      <style>{`
        .library-root .library-card-actions { opacity: 0; }
        .library-root [role="button"]:hover .library-card-actions,
        .library-root [role="button"]:focus-visible .library-card-actions {
          opacity: 1;
        }
        .library-root [role="button"]:focus-visible {
          outline: 2px solid ${tokens.color.accent};
          outline-offset: 2px;
        }
      `}</style>

      <header
        style={{
          display: 'flex',
          alignItems: 'flex-end',
          justifyContent: 'space-between',
          marginBottom: tokens.space[5],
          gap: tokens.space[4],
          flexWrap: 'wrap',
        }}
      >
        <div>
          <Title
            level={2}
            style={{
              margin: 0,
              color: tokens.color.text,
              fontWeight: 600,
              letterSpacing: '-0.01em',
            }}
          >
            资产库
          </Title>
          <Text style={{ color: tokens.color.textMuted, fontSize: 13 }}>
            共 {total.toLocaleString()} 项资产
            {selected.size > 0 && (
              <span style={{ color: tokens.color.accent, marginLeft: 8 }}>
                · 已选 {selected.size}
              </span>
            )}
          </Text>
        </div>
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
      </header>

      <section
        style={{
          background: tokens.color.panel,
          border: `1px solid ${tokens.color.border}`,
          borderRadius: tokens.radius.lg,
          padding: tokens.space[4],
          marginBottom: tokens.space[4],
        }}
      >
        <Space size={[tokens.space[3], tokens.space[3]]} wrap style={{ width: '100%' }}>
          <Input.Search
            allowClear
            placeholder="按标题、文件名、描述搜索"
            value={keywordInput}
            onChange={(e) => setKeywordInput(e.target.value)}
            onSearch={onSearch}
            enterButton={<SearchOutlined />}
            style={{ width: 280 }}
          />
          <Select
            placeholder="类型"
            allowClear
            value={assetType}
            onChange={(v: AssetType | undefined) => {
              setAssetType(v);
              onFilterChange();
            }}
            style={{ width: 130 }}
            options={ASSET_TYPE_FILTERS}
          />
          <Select
            placeholder="分类"
            allowClear
            showSearch
            value={categoryId}
            onChange={(v: string | undefined) => {
              setCategoryId(v);
              onFilterChange();
            }}
            optionFilterProp="label"
            style={{ width: 180 }}
            loading={categoriesState.loading}
            options={categories.map((c) => ({ value: c.id, label: c.name }))}
          />
          <Select
            placeholder="来源"
            allowClear
            value={sourceTool}
            onChange={(v: string | undefined) => {
              setSourceTool(v);
              onFilterChange();
            }}
            style={{ width: 150 }}
            options={SOURCE_TOOL_OPTIONS}
          />
          <Button onClick={onReset}>重置</Button>
        </Space>
      </section>

      <section>
        {assetsState.loading ? (
          <Skeleton
            active
            paragraph={{ rows: view === 'grid' ? 6 : 4 }}
            style={{ padding: tokens.space[4] }}
          />
        ) : items.length === 0 ? (
          <div
            style={{
              background: tokens.color.panel,
              border: `1px solid ${tokens.color.border}`,
              borderRadius: tokens.radius.lg,
              padding: tokens.space[6],
              textAlign: 'center',
            }}
          >
            <Empty
              description={
                <span style={{ color: tokens.color.textMuted }}>
                  没有匹配的资产
                </span>
              }
            />
          </div>
        ) : view === 'grid' ? (
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
        )}

        {assetsState.error && !assetsState.loading && (
          <div
            style={{
              marginTop: tokens.space[4],
              padding: tokens.space[3],
              background: 'rgba(248, 81, 73, 0.08)',
              border: `1px solid ${tokens.color.danger}`,
              borderRadius: tokens.radius.md,
              color: tokens.color.danger,
              display: 'flex',
              alignItems: 'center',
              gap: tokens.space[3],
            }}
          >
            <span>加载失败：{assetsState.error.message}</span>
            <Button size="small" onClick={() => void assetsState.reload()}>
              重试
            </Button>
          </div>
        )}

        {total > 0 && (
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

      {/* Suspense fallback hint while route transitions land */}
      {assetsState.loading && items.length > 0 && (
        <div
          aria-hidden
          style={{
            position: 'fixed',
            top: 72,
            right: tokens.space[5],
            color: tokens.color.textMuted,
          }}
        >
          <Spin size="small" />
        </div>
      )}
    </div>
  );
}