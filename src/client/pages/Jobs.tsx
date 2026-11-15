/**
 * Jobs — ComfyUI task listing (Task 15).
 *
 * Dense single-column list of assets sourced from the ComfyUI pipeline
 * (`source_tool = 'comfyui'`). Each row is mono-typed by job id with a
 * magenta `JOB` square as the only memorable beat; clicking the row
 * jumps into AssetDetail.
 *
 * Deep-link contract: `?job_id=<id>` pre-fills the search box. When the
 * resulting page contains exactly one match, the page auto-navigates
 * to that asset and clears the param — mirrors AssetDetail's "在 Jobs
 * 中反查" link.
 */

import { useEffect, useMemo, useState } from 'react';
import {
  App,
  Button,
  Input,
  Pagination,
  Select,
  Space,
  Tooltip,
  Typography,
} from 'antd';
import {
  CopyOutlined,
  ReloadOutlined,
  SearchOutlined,
} from '@ant-design/icons';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useApi } from '@/api/hooks';
import {
  PageHeader,
  Panel,
  Pill,
  StateBlock,
  resolveDataStatus,
} from '@/components/ui';
import type { Asset, AssetStatus, PageResponse } from '@/types';
import { tokens } from '@/theme/tokens';
import { formatDate } from '@/utils/format';
import { statusLabel, statusTone } from '@/utils/assetStatus';
import { describeError } from '@/utils/errors';

const { Text } = Typography;

const STATUS_OPTIONS: { value: AssetStatus; label: string }[] = [
  { value: 'ready', label: '就绪' },
  { value: 'processing', label: '处理中' },
  { value: 'failed', label: '失败' },
  { value: 'deleted', label: '已删除' },
];

const SOURCE_TOOL_OPTIONS = [
  { value: 'comfyui', label: 'ComfyUI' },
  { value: 'manual', label: '手动上传' },
  { value: 'admin', label: '管理后台' },
];

const PAGE_SIZE_OPTIONS = [12, 24, 48, 96];

/**
 * Build the `/assets` query path. The backend's `source_tool` filter
 * already excludes non-ComfyUI rows; the param stays in the payload so
 * a future "show all sources" toggle can drop it without a refactor.
 */
function buildPath(params: {
  q: string;
  status?: AssetStatus;
  sourceTool: string;
  page: number;
  pageSize: number;
}): string {
  const search = new URLSearchParams();
  if (params.q) search.set('q', params.q);
  if (params.status) search.set('status', params.status);
  if (params.sourceTool) search.set('source_tool', params.sourceTool);
  search.set('page', String(params.page));
  search.set('page_size', String(params.pageSize));
  return `/assets?${search.toString()}`;
}

interface JobRowProps {
  asset: Asset;
  onOpen: (id: string) => void;
  onCopy: (text: string, label: string) => Promise<void>;
}

const JOB_BADGE_STYLE: React.CSSProperties = {
  width: 36,
  height: 36,
  flexShrink: 0,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: tokens.color.jobBadge,
  color: tokens.color.text,
  fontFamily: tokens.font.mono,
  fontSize: 11,
  fontWeight: 600,
  letterSpacing: '0.05em',
  borderRadius: tokens.radius.sm,
};

const ROW_STYLE: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: tokens.space[4],
  padding: `${tokens.space[3]}px ${tokens.space[4]}px`,
  background: tokens.color.panel,
  border: `1px solid ${tokens.color.border}`,
  borderRadius: tokens.radius.md,
  cursor: 'pointer',
  transition: 'border-color 120ms ease, background 120ms ease',
  minHeight: 60,
};

function JobRow({ asset, onOpen, onCopy }: JobRowProps): JSX.Element {
  const jobId = asset.job_id ?? '';
  const title = asset.title || asset.original_name || '(无标题)';
  const description = asset.description ?? '';

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
      style={ROW_STYLE}
      onMouseEnter={(e) => {
        e.currentTarget.style.borderColor = tokens.color.borderStrong;
        e.currentTarget.style.background = tokens.color.panelAlt;
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.borderColor = tokens.color.border;
        e.currentTarget.style.background = tokens.color.panel;
      }}
    >
      <div aria-hidden style={JOB_BADGE_STYLE}>JOB</div>

      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
        <Space size={6} align="center" wrap>
          <Text strong ellipsis style={{ color: tokens.color.text, fontSize: 14, maxWidth: 480 }} title={title}>
            {title}
          </Text>
          {jobId && (
            <span
              style={{
                fontFamily: tokens.font.mono,
                fontSize: 12,
                color: tokens.color.textMuted,
                background: tokens.color.bgAlt,
                border: `1px solid ${tokens.color.border}`,
                padding: '1px 6px',
                borderRadius: tokens.radius.sm,
                maxWidth: 280,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
              title={jobId}
            >
              {jobId}
            </span>
          )}
        </Space>
        {description ? (
          <Text ellipsis style={{ display: 'block', color: tokens.color.textMuted, fontSize: 12, lineHeight: 1.5 }} title={description}>
            {description}
          </Text>
        ) : null}
        <Text style={{ color: tokens.color.textMuted, fontSize: 11, fontFamily: tokens.font.mono }}>
          {formatDate(asset.created_at)}
        </Text>
      </div>

      <Space size="small" align="center">
        <Pill value={statusLabel(asset.status)} tone={statusTone(asset.status)} />
        {jobId && (
          <Tooltip title="复制 job_id">
            <Button
              size="small"
              type="text"
              icon={<CopyOutlined />}
              onClick={(e) => {
                e.stopPropagation();
                void onCopy(jobId, 'job_id');
              }}
              aria-label="复制 job_id"
            />
          </Tooltip>
        )}
      </Space>
    </div>
  );
}

export default function Jobs(): JSX.Element {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { message } = App.useApp();

  // Pre-fill q when ?job_id= is provided; the param is consumed on
  // mount so a manual reload doesn't keep auto-redirecting.
  const deepLinkJobId = searchParams.get('job_id') ?? '';
  const [keywordInput, setKeywordInput] = useState<string>(deepLinkJobId);
  const [q, setQ] = useState<string>(deepLinkJobId);
  const [statusFilter, setStatusFilter] = useState<AssetStatus | undefined>(undefined);
  const [sourceTool, setSourceTool] = useState<string>('comfyui');
  const [page, setPage] = useState<number>(1);
  const [pageSize, setPageSize] = useState<number>(24);

  // Strip ?job_id once we've absorbed it; otherwise refreshes would
  // keep forcing us back into AssetDetail.
  const [consumed, setConsumed] = useState<boolean>(deepLinkJobId === '');
  useEffect(() => {
    if (consumed) return;
    if (!deepLinkJobId) {
      setConsumed(true);
      return;
    }
    const next = new URLSearchParams(searchParams);
    next.delete('job_id');
    setSearchParams(next, { replace: true });
    setConsumed(true);
  }, [consumed, deepLinkJobId, searchParams, setSearchParams]);

  const listPath = useMemo(
    () => buildPath({ q, status: statusFilter, sourceTool, page, pageSize }),
    [q, statusFilter, sourceTool, page, pageSize],
  );

  const jobsState = useApi<PageResponse<Asset>>(listPath);

  const total = jobsState.data?.total ?? 0;
  const items = jobsState.data?.items ?? [];

  // Deep-link auto-redirect: when the search yields an exact match for
  // the requested job id, jump straight to AssetDetail.
  useEffect(() => {
    if (!deepLinkJobId || jobsState.loading || jobsState.error) return;
    const exact = items.find((a) => a.job_id === deepLinkJobId);
    if (exact) navigate(`/library/${exact.id}`, { replace: true });
  }, [deepLinkJobId, jobsState.loading, jobsState.error, items, navigate]);

  const onSearch = (value: string): void => {
    setQ(value.trim());
    setPage(1);
  };

  const onStatusChange = (v: AssetStatus | undefined): void => {
    setStatusFilter(v);
    setPage(1);
  };

  const onSourceToolChange = (v: string | undefined): void => {
    setSourceTool(v ?? 'comfyui');
    setPage(1);
  };

  const onReset = (): void => {
    setKeywordInput('');
    setQ('');
    setStatusFilter(undefined);
    setSourceTool('comfyui');
    setPage(1);
  };

  const onCopy = async (text: string, label: string): Promise<void> => {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      message.success(`${label}已复制`);
    } catch (e: unknown) {
      message.error(describeError(e, '剪贴板不可用'));
    }
  };

  const onOpen = (id: string): void => {
    navigate(`/library/${id}`);
  };

  /**
   * Exactly one of the four result states is rendered. The page used to
   * test `loading` before `error`, so a failed request (which left
   * `loading` set) showed the skeleton forever and the error text with
   * its retry button was unreachable.
   */
  const listStatus = resolveDataStatus({
    loading: jobsState.loading,
    error: jobsState.error,
    hasData: !!jobsState.data,
    isEmpty: items.length === 0,
  });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.space[5] }}>
      <PageHeader
        title="任务"
        subtitle={
          <>
            ComfyUI 流水线产生的资产列表 · 共 {total.toLocaleString()} 项
          </>
        }
      />

      <Panel>
        <Space size={[tokens.space[3], tokens.space[3]]} wrap style={{ width: '100%' }}>
          <Input.Search
            allowClear
            aria-label="按 job_id 或标题搜索"
            placeholder="按 job_id 或标题搜索"
            value={keywordInput}
            onChange={(e) => setKeywordInput(e.target.value)}
            onSearch={onSearch}
            // The submit button carries only an icon, so it needs its
            // own accessible name.
            enterButton={<Button aria-label="搜索" icon={<SearchOutlined />} />}
            style={{ width: 280 }}
          />
          <Select
            placeholder="状态"
            allowClear
            value={statusFilter}
            onChange={(v: AssetStatus | undefined) => onStatusChange(v)}
            style={{ width: 130 }}
            options={STATUS_OPTIONS}
          />
          <Select
            value={sourceTool}
            onChange={(v: string | undefined) => onSourceToolChange(v)}
            style={{ width: 150 }}
            options={SOURCE_TOOL_OPTIONS}
          />
          <Button onClick={onReset}>重置</Button>
          <Button icon={<ReloadOutlined />} onClick={() => void jobsState.reload()}>
            刷新
          </Button>
        </Space>
      </Panel>

      <section>
        {listStatus === 'loading' && (
          <Panel>
            <StateBlock status="loading" rows={6} />
          </Panel>
        )}

        {listStatus === 'error' && (
          <StateBlock
            status="error"
            title="任务列表加载失败"
            error={jobsState.error}
            errorFallback="无法加载任务列表"
            onRetry={() => void jobsState.reload()}
          />
        )}

        {listStatus === 'empty' && (
          <Panel>
            <StateBlock
              status="empty"
              title={q ? `没有匹配「${q}」的任务` : '暂无 ComfyUI 任务'}
              description={
                q
                  ? '换个关键字，或清除筛选条件后再试。'
                  : '从 ComfyUI 导入流水线，或手动上传一个资产。'
              }
              action={
                q ? (
                  <Button onClick={onReset}>清除筛选</Button>
                ) : (
                  <Button onClick={() => navigate('/import')}>前往导入</Button>
                )
              }
            />
          </Panel>
        )}

        {listStatus === 'ready' && (
          <Space direction="vertical" size="small" style={{ width: '100%' }}>
            {items.map((asset) => (
              <JobRow key={asset.id} asset={asset} onOpen={onOpen} onCopy={onCopy} />
            ))}
          </Space>
        )}

        {/* The pager only exists for a rendered list — showing "共 N 项"
            under an empty state read as a contradiction. */}
        {listStatus === 'ready' && total > 0 && (
          <div style={{ marginTop: tokens.space[5], display: 'flex', justifyContent: 'flex-end' }}>
            <Pagination
              current={page}
              pageSize={pageSize}
              total={total}
              showSizeChanger
              showTotal={(t) => `共 ${t} 项`}
              pageSizeOptions={PAGE_SIZE_OPTIONS}
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
