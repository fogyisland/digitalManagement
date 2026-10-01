import { useMemo, useState } from 'react';
import {
  App,
  Button,
  Empty,
  Form,
  Input,
  Skeleton,
  Space,
  Switch,
} from 'antd';
import {
  ArrowLeftOutlined,
  CopyOutlined,
  EditOutlined,
  LinkOutlined,
} from '@ant-design/icons';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { apiClient } from '@/api/client';
import { useApi } from '@/api/hooks';
import type { Asset, AssetStatus } from '@/types/dto';
import { useAuthStore } from '@/stores/authStore';
import { tokens } from '@/theme/tokens';
import { formatBytes, formatDate } from '@/utils/format';

/**
 * AssetDetail — single asset page (Task 13).
 *
 * Two-column layout:
 *   left  → image / video preview against the dark panel
 *   right → title, description, category, mono-font metadata block (ComfyUI
 *           fields), tag chips, action bar.
 *
 * Action bar carries Edit, Copy URL, and — when a job_id is present — a
 * deep-link to the Jobs page filtered by that job id.
 *
 * Bug fix (Task 13): the previous implementation called
 * `assetsApi.get(Number(id))` against a legacy client that expected a
 * numeric id and an API whose PK was an integer; the backend now uses
 * nanoid strings, so the call became `WHERE id = NaN` and every card
 * click 404'd. We now drive the load via `useApi<Asset>('/assets/:id')`
 * (path relative to the apiClient baseURL `/api/v1`), with `null` when
 * no id is present, and never cast through `Number()`.
 */

interface MetadataJson {
  [key: string]: unknown;
}

/**
 * Backend stores ComfyUI's structured payload in `metadata_json` as a
 * JSON-encoded TEXT column. Returns null on absent / empty / invalid
 * input so the caller can render a "no metadata" hint instead of a
 * raw blob.
 */
function parseMetadata(raw: string | null | undefined): MetadataJson | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as MetadataJson;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Storage join — matches the Library card's URL helper. The backend
 * serves `/storage/*` statically; we normalize legacy `/api/v1/storage/`
 * prefixes and absolute URLs.
 */
function previewUrl(
  asset: Pick<Asset, 'thumbnail_path' | 'storage_path'>,
): string | null {
  const raw = asset.thumbnail_path || asset.storage_path;
  if (!raw) return null;
  if (/^https?:\/\//.test(raw)) return raw;
  const normalized = raw.startsWith('/') ? raw : `/storage/${raw}`;
  return normalized.replace(/^\/api\/v1\/storage\//, '/storage/');
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

function statusColor(status: AssetStatus): string {
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

export default function AssetDetail(): JSX.Element {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { message } = App.useApp();
  const canWrite = useAuthStore((s) => s.canWrite());
  const [editOpen, setEditOpen] = useState<boolean>(false);
  const [savingEdit, setSavingEdit] = useState<boolean>(false);
  const [form] = Form.useForm<{ title: string; description?: string }>();

  // Path is null until the router hands us an id — useApi treats null
  // as "skip the request" so this also covers the initial render race.
  const detailPath = id ? `/assets/${id}` : null;
  const detailState = useApi<Asset>(detailPath);

  const asset: Asset | null = detailState.data ?? null;
  const isVideo: boolean = asset?.asset_type === 'video';
  const heroUrl: string | null = useMemo(
    () => (asset ? previewUrl(asset) : null),
    [asset],
  );
  const metadata: MetadataJson | null = useMemo(
    () => parseMetadata(asset?.metadata_json),
    [asset?.metadata_json],
  );

  const onCopy = async (text: string, label: string): Promise<void> => {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      message.success(`${label}已复制`);
    } catch (e: unknown) {
      const detail =
        e && typeof e === 'object' && 'message' in e
          ? String((e as { message: unknown }).message)
          : '剪贴板不可用';
      message.error(detail);
    }
  };

  const onCopyUrl = (): void => {
    void onCopy(window.location.href, '页面地址');
  };

  const onDownload = async (): Promise<void> => {
    if (!asset) return;
    try {
      const r = await apiClient.post<{ download_url?: string }>(
        `/assets/${asset.id}/download`,
      );
      const url = r.data?.download_url;
      const fallback: string | null = previewUrl(asset);
      const target: string | null = url || fallback;
      if (target) window.open(target, '_blank', 'noopener');
    } catch (e: unknown) {
      const detail =
        e && typeof e === 'object' && 'message' in e
          ? String((e as { message: unknown }).message)
          : '下载失败';
      message.error(detail);
    }
  };

  const openEdit = (): void => {
    if (!asset) return;
    form.setFieldsValue({
      title: asset.title,
      description: asset.description ?? '',
    });
    setEditOpen(true);
  };

  const onSaveEdit = async (): Promise<void> => {
    if (!asset) return;
    const v = await form.validateFields();
    setSavingEdit(true);
    try {
      await apiClient.put<Asset>(`/assets/${asset.id}`, {
        title: v.title,
        description: v.description ?? null,
      });
      message.success('已保存');
      setEditOpen(false);
      await detailState.reload();
    } catch (e: unknown) {
      const detail =
        e && typeof e === 'object' && 'message' in e
          ? String((e as { message: unknown }).message)
          : '保存失败';
      message.error(detail);
    } finally {
      setSavingEdit(false);
    }
  };

  const onDelete = async (): Promise<void> => {
    if (!asset) return;
    const confirmed = window.confirm(
      `确定删除「${asset.title}」？此操作将软删除资产（可在回收站恢复）。`,
    );
    if (!confirmed) return;
    try {
      await apiClient.delete(`/assets/${asset.id}`);
      message.success('已删除');
      navigate('/library', { replace: true });
    } catch (e: unknown) {
      const detail =
        e && typeof e === 'object' && 'message' in e
          ? String((e as { message: unknown }).message)
          : '删除失败';
      message.error(detail);
    }
  };

  if (detailState.loading && !asset) {
    return (
      <div
        style={{
          padding: tokens.space[5],
          background: tokens.color.panel,
          border: `1px solid ${tokens.color.border}`,
          borderRadius: tokens.radius.lg,
        }}
      >
        <Skeleton active paragraph={{ rows: 6 }} />
      </div>
    );
  }

  if (detailState.error || !asset) {
    return (
      <div
        style={{
          padding: tokens.space[6],
          background: tokens.color.panel,
          border: `1px solid ${tokens.color.border}`,
          borderRadius: tokens.radius.lg,
          textAlign: 'center',
        }}
      >
        <Empty
          description={
            <span style={{ color: tokens.color.textMuted }}>
              {detailState.error
                ? `加载失败：${detailState.error.message}`
                : '资产不存在或已被删除'}
            </span>
          }
        >
          <Space>
            <Button
              icon={<ArrowLeftOutlined />}
              onClick={() => navigate('/library')}
            >
              返回资产库
            </Button>
            {detailState.error && (
              <Button onClick={() => void detailState.reload()}>重试</Button>
            )}
          </Space>
        </Empty>
      </div>
    );
  }

  const metaPairs: { key: string; label: string; value: string }[] = [];
  if (asset.prompt) metaPairs.push({ key: 'prompt', label: 'prompt', value: asset.prompt });
  if (asset.seed != null) metaPairs.push({ key: 'seed', label: 'seed', value: String(asset.seed) });
  if (asset.model_name) metaPairs.push({ key: 'model', label: 'model_name', value: asset.model_name });
  if (asset.job_id) metaPairs.push({ key: 'job', label: 'job_id', value: asset.job_id });
  if (asset.source_tool) metaPairs.push({ key: 'tool', label: 'source_tool', value: asset.source_tool });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.space[5] }}>
      {/* Header — back button + title + action group */}
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: tokens.space[4],
          flexWrap: 'wrap',
        }}
      >
        <Space size="middle" align="center">
          <Button
            icon={<ArrowLeftOutlined />}
            onClick={() => navigate('/library')}
          >
            返回
          </Button>
          <div>
            <h1
              style={{
                margin: 0,
                color: tokens.color.text,
                fontSize: 22,
                fontWeight: 600,
                letterSpacing: '-0.01em',
                lineHeight: 1.3,
              }}
            >
              {asset.title || asset.original_name}
            </h1>
            <div
              style={{
                marginTop: 4,
                color: tokens.color.textMuted,
                fontFamily: tokens.font.mono,
                fontSize: 12,
              }}
            >
              {asset.original_name} · {asset.mime_type || 'unknown'}
            </div>
          </div>
        </Space>
        <Space size="small">
          <Button onClick={onDownload}>下载</Button>
          {canWrite && (
            <Button icon={<EditOutlined />} onClick={openEdit}>
              编辑
            </Button>
          )}
          {canWrite && (
            <Button danger onClick={() => void onDelete()}>
              删除
            </Button>
          )}
        </Space>
      </header>

      {/* Two-column body */}
      <section
        style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(0, 2fr) minmax(280px, 1fr)',
          gap: tokens.space[5],
        }}
      >
        {/* Hero — preview pane */}
        <div
          style={{
            background: tokens.color.bgAlt,
            border: `1px solid ${tokens.color.border}`,
            borderRadius: tokens.radius.lg,
            overflow: 'hidden',
            minHeight: 360,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          {heroUrl ? (
            isVideo ? (
              <video
                src={heroUrl}
                controls
                poster={asset.thumbnail_path || undefined}
                style={{
                  width: '100%',
                  maxHeight: '70vh',
                  display: 'block',
                  background: tokens.color.bg,
                }}
              />
            ) : (
              <img
                src={heroUrl}
                alt={asset.title || asset.original_name}
                style={{
                  width: '100%',
                  maxHeight: '70vh',
                  objectFit: 'contain',
                  display: 'block',
                  background: tokens.color.bg,
                }}
              />
            )
          ) : (
            <div
              style={{
                color: tokens.color.textMuted,
                fontSize: 13,
                padding: tokens.space[6],
              }}
            >
              暂无可预览的文件
            </div>
          )}
        </div>

        {/* Sidebar — info + metadata */}
        <aside style={{ display: 'flex', flexDirection: 'column', gap: tokens.space[4] }}>
          {/* Status / facts — the page's one memorable beat uses the
              dam-section-rule (2px left-border in amber). */}
          <div
            className="dam-section-rule"
            style={{
              background: tokens.color.panel,
              border: `1px solid ${tokens.color.border}`,
              borderLeft: `2px solid ${tokens.color.accent}`,
              borderRadius: tokens.radius.md,
              padding: tokens.space[4],
            }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: tokens.space[3],
                marginBottom: tokens.space[3],
              }}
            >
              <span
                style={{
                  display: 'inline-block',
                  width: 8,
                  height: 8,
                  borderRadius: 4,
                  background: statusColor(asset.status),
                }}
                aria-hidden
              />
              <span
                style={{
                  color: tokens.color.text,
                  fontWeight: 500,
                  fontSize: 13,
                }}
              >
                {statusLabel(asset.status)}
              </span>
              <span style={{ color: tokens.color.textMuted, fontSize: 12 }}>
                · {formatDate(asset.created_at)}
              </span>
            </div>

            <dl
              style={{
                margin: 0,
                display: 'grid',
                gridTemplateColumns: 'auto 1fr',
                columnGap: tokens.space[3],
                rowGap: tokens.space[2],
                fontSize: 13,
              }}
            >
              <dt style={{ color: tokens.color.textMuted }}>格式</dt>
              <dd style={{ margin: 0, color: tokens.color.text }}>
                {asset.mime_type || '—'}
              </dd>
              <dt style={{ color: tokens.color.textMuted }}>体积</dt>
              <dd style={{ margin: 0, color: tokens.color.text }}>
                {formatBytes(asset.file_size)}
              </dd>
              {asset.width != null && asset.height != null && (
                <>
                  <dt style={{ color: tokens.color.textMuted }}>尺寸</dt>
                  <dd style={{ margin: 0, color: tokens.color.text }}>
                    {asset.width} × {asset.height}
                  </dd>
                </>
              )}
              {asset.duration != null && asset.duration > 0 && (
                <>
                  <dt style={{ color: tokens.color.textMuted }}>时长</dt>
                  <dd style={{ margin: 0, color: tokens.color.text }}>
                    {asset.duration.toFixed(2)}s
                  </dd>
                </>
              )}
              <dt style={{ color: tokens.color.textMuted }}>来源</dt>
              <dd style={{ margin: 0, color: tokens.color.text }}>
                {asset.source_tool || asset.source || '—'}
              </dd>
            </dl>
          </div>

          {/* Description */}
          {asset.description && (
            <div
              style={{
                background: tokens.color.panel,
                border: `1px solid ${tokens.color.border}`,
                borderRadius: tokens.radius.md,
                padding: tokens.space[4],
              }}
            >
              <div
                style={{
                  color: tokens.color.textMuted,
                  fontSize: 12,
                  textTransform: 'none',
                  letterSpacing: 0,
                  marginBottom: tokens.space[2],
                }}
              >
                描述
              </div>
              <div
                style={{
                  color: tokens.color.text,
                  fontSize: 13,
                  lineHeight: 1.6,
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                }}
              >
                {asset.description}
              </div>
            </div>
          )}

          {/* Metadata block — mono font, ComfyUI-shaped fields */}
          {(metaPairs.length > 0 || metadata) && (
            <div
              style={{
                background: tokens.color.panel,
                border: `1px solid ${tokens.color.border}`,
                borderRadius: tokens.radius.md,
                padding: tokens.space[4],
              }}
            >
              <div
                style={{
                  color: tokens.color.textMuted,
                  fontSize: 12,
                  textTransform: 'none',
                  letterSpacing: 0,
                  marginBottom: tokens.space[3],
                }}
              >
                生成参数
              </div>
              {metaPairs.length > 0 && (
                <dl
                  style={{
                    margin: 0,
                    display: 'grid',
                    gridTemplateColumns: 'auto 1fr',
                    columnGap: tokens.space[3],
                    rowGap: tokens.space[2],
                    fontFamily: tokens.font.mono,
                    fontSize: 12,
                  }}
                >
                  {metaPairs.map((p) => (
                    <Pair
                      key={p.key}
                      label={p.label}
                      value={p.value}
                      copyable={p.key !== 'seed'}
                      onCopy={onCopy}
                    />
                  ))}
                </dl>
              )}
              {metadata && (
                <pre
                  style={{
                    margin: metaPairs.length > 0 ? `${tokens.space[3]}px 0 0 0` : 0,
                    padding: tokens.space[3],
                    background: tokens.color.bgAlt,
                    border: `1px solid ${tokens.color.border}`,
                    borderRadius: tokens.radius.sm,
                    color: tokens.color.text,
                    fontFamily: tokens.font.mono,
                    fontSize: 12,
                    lineHeight: 1.5,
                    overflowX: 'auto',
                    maxHeight: 240,
                    whiteSpace: 'pre',
                  }}
                >
                  {JSON.stringify(metadata, null, 2)}
                </pre>
              )}
            </div>
          )}
        </aside>
      </section>

      {/* Bottom action bar */}
      <footer
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: tokens.space[3],
          padding: `${tokens.space[3]}px ${tokens.space[4]}px`,
          background: tokens.color.panel,
          border: `1px solid ${tokens.color.border}`,
          borderRadius: tokens.radius.md,
          flexWrap: 'wrap',
        }}
      >
        <div
          style={{
            color: tokens.color.textMuted,
            fontFamily: tokens.font.mono,
            fontSize: 11,
            wordBreak: 'break-all',
          }}
        >
          id: {asset.id}
        </div>
        <Space size="small" wrap>
          <Button
            icon={<CopyOutlined />}
            onClick={onCopyUrl}
            aria-label="复制页面地址"
          >
            复制 URL
          </Button>
          {asset.job_id && (
            <Link
              to={`/jobs?job_id=${encodeURIComponent(asset.job_id)}`}
              style={{ textDecoration: 'none' }}
            >
              <Button icon={<LinkOutlined />}>在 Jobs 中反查</Button>
            </Link>
          )}
        </Space>
      </footer>

      {/* Edit modal — title + description only; other fields aren't on
          the current DTO. The PATCH is intentionally narrow to avoid
          touching fields the backend treats as derived. */}
      <EditModal
        open={editOpen}
        onCancel={() => setEditOpen(false)}
        onSubmit={onSaveEdit}
        form={form}
        saving={savingEdit}
      />
    </div>
  );
}

interface PairProps {
  label: string;
  value: string;
  copyable: boolean;
  onCopy: (text: string, label: string) => Promise<void>;
}

function Pair({ label, value, copyable, onCopy }: PairProps): JSX.Element {
  return (
    <>
      <dt style={{ color: tokens.color.textMuted }}>{label}</dt>
      <dd
        style={{
          margin: 0,
          color: tokens.color.text,
          display: 'flex',
          alignItems: 'center',
          gap: tokens.space[2],
          minWidth: 0,
        }}
      >
        <span
          style={{
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            minWidth: 0,
          }}
          title={value}
        >
          {value}
        </span>
        {copyable && (
          <Button
            size="small"
            type="text"
            icon={<CopyOutlined />}
            onClick={() => void onCopy(value, label)}
            aria-label={`复制 ${label}`}
          />
        )}
      </dd>
    </>
  );
}

interface EditModalProps {
  open: boolean;
  saving: boolean;
  form: ReturnType<typeof Form.useForm<{ title: string; description?: string }>>[0];
  onCancel: () => void;
  onSubmit: () => Promise<void>;
}

function EditModal({
  open,
  saving,
  form,
  onCancel,
  onSubmit,
}: EditModalProps): JSX.Element {
  return (
    <div
      aria-hidden={!open}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(13, 17, 23, 0.72)',
        display: open ? 'flex' : 'none',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000,
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="编辑资产"
        style={{
          width: 'min(560px, 92vw)',
          background: tokens.color.panel,
          border: `1px solid ${tokens.color.border}`,
          borderRadius: tokens.radius.lg,
          padding: tokens.space[5],
          boxShadow: '0 24px 48px rgba(0, 0, 0, 0.4)',
        }}
      >
        <h2
          style={{
            margin: 0,
            marginBottom: tokens.space[4],
            color: tokens.color.text,
            fontSize: 16,
            fontWeight: 600,
          }}
        >
          编辑资产
        </h2>
        <Form form={form} layout="vertical">
          <Form.Item
            name="title"
            label="标题"
            rules={[{ required: true, max: 255 }]}
          >
            <Input placeholder="为这个资产起个标题" maxLength={255} />
          </Form.Item>
          <Form.Item name="description" label="描述">
            <Input.TextArea
              rows={4}
              placeholder="补充一些上下文，方便后续检索"
              maxLength={2000}
              showCount
            />
          </Form.Item>
          <Form.Item label=" " colon={false}>
            <Space>
              <Switch disabled checked={false} aria-label="公开" />
              <span style={{ color: tokens.color.textMuted, fontSize: 12 }}>
                公开（占位，下一里程碑接入）
              </span>
            </Space>
          </Form.Item>
        </Form>
        <div
          style={{
            display: 'flex',
            justifyContent: 'flex-end',
            gap: tokens.space[2],
            marginTop: tokens.space[4],
          }}
        >
          <Button onClick={onCancel} disabled={saving}>
            取消
          </Button>
          <Button
            type="primary"
            onClick={() => void onSubmit()}
            loading={saving}
          >
            保存
          </Button>
        </div>
      </div>
    </div>
  );
}
