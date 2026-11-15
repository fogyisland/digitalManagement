import { useMemo, useState } from 'react';
import {
  App,
  Button,
  Form,
  Input,
  Space,
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
import {
  FormModal,
  PageHeader,
  Panel,
  StateBlock,
  resolveDataStatus,
} from '@/components/ui';
import AssetSidebar from '@/components/asset/AssetSidebar';
import type { Asset, Category } from '@/types';
import { useAuthStore } from '@/stores/authStore';
import { tokens } from '@/theme/tokens';
import { assetOriginalUrl, assetPreviewUrl } from '@/utils/assetUrls';
import { describeError } from '@/utils/errors';

/**
 * AssetDetail — single asset page (Task 13).
 *
 * Two-column layout:
 *   left  → image / video preview against the dark panel
 *   right → status/facts, description, category, tag chips and a mono-font
 *           metadata block (ComfyUI fields) — see `components/asset/
 *           AssetSidebar`, which was split out to keep this page under
 *           the repo's 500-line cap.
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
 *
 * Result states: exactly one of loading / error / empty / ready is rendered,
 * resolved by `resolveDataStatus`. The page used to test `loading` before
 * `error`, so a failed request (which left `loading` set) showed the
 * skeleton forever — the error text and its retry button were unreachable.
 */

/** The two fields the edit dialog is allowed to touch. */
interface EditFormValues {
  title: string;
  description?: string;
}

export default function AssetDetail(): JSX.Element {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { message } = App.useApp();
  const canWrite = useAuthStore((s) => s.canWrite());
  const [editOpen, setEditOpen] = useState<boolean>(false);
  const [downloading, setDownloading] = useState<boolean>(false);
  const [form] = Form.useForm<EditFormValues>();

  // Path is null until the router hands us an id — useApi treats null
  // as "skip the request" so this also covers the initial render race.
  const detailPath = id ? `/assets/${id}` : null;
  const detailState = useApi<Asset>(detailPath);

  const asset: Asset | null = detailState.data ?? null;
  const isVideo: boolean = asset?.asset_type === 'video';
  const heroUrl: string | null = useMemo(
    () => (asset ? assetPreviewUrl(asset) : null),
    [asset],
  );

  /**
   * The asset row only carries `category_id`; the readable name lives in
   * the categories endpoint. A failure there is not fatal — the raw id is
   * shown instead, so the panel never blocks on a second request.
   */
  const categoriesState = useApi<Category[]>('/categories');
  const categoryName: string | null = useMemo(() => {
    if (!asset?.category_id) return null;
    const hit = categoriesState.data?.find((c) => c.id === asset.category_id);
    return hit?.name ?? asset.category_id;
  }, [asset?.category_id, categoriesState.data]);

  const onCopy = async (text: string, label: string): Promise<void> => {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      message.success(`${label}已复制`);
    } catch (e: unknown) {
      message.error(describeError(e, '剪贴板不可用'));
    }
  };

  const onCopyUrl = (): void => {
    void onCopy(window.location.href, '页面地址');
  };

  const onDownload = async (): Promise<void> => {
    if (!asset || downloading) return;
    setDownloading(true);
    try {
      const r = await apiClient.post<{ download_url?: string }>(
        `/assets/${asset.id}/download`,
      );
      const url = r.data?.download_url;
      const fallback: string | null = assetOriginalUrl(asset);
      const target: string | null = url || fallback;
      if (target) window.open(target, '_blank', 'noopener');
    } catch (e: unknown) {
      message.error(describeError(e, '下载失败'));
    } finally {
      setDownloading(false);
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

  /**
   * `FormModal` validates before it calls this handler, and swallows a
   * validation rejection itself — so a failed rule never escapes as an
   * unhandled promise rejection. The handler also catches its own failure
   * and reports it through `describeError` (which reads the backend's
   * `detail`, not axios' generic "Request failed with status code 500").
   */
  const onSaveEdit = async (v: EditFormValues): Promise<void> => {
    if (!asset) return;
    try {
      await apiClient.put<Asset>(`/assets/${asset.id}`, {
        title: v.title,
        description: v.description ?? null,
      });
      message.success('已保存');
      setEditOpen(false);
      await detailState.reload();
    } catch (e: unknown) {
      message.error(describeError(e, '保存失败'));
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
      message.error(describeError(e, '删除失败'));
    }
  };

  /**
   * One status for the whole page. `resolveDataStatus` puts the error
   * first, so a failed request always reaches the error branch instead of
   * the skeleton.
   */
  const detailStatus = resolveDataStatus({
    loading: detailState.loading,
    error: detailState.error,
    hasData: !!asset,
    isEmpty: !asset,
  });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.space[5] }}>
      {/* Header — title + action group */}
      <PageHeader
        title={asset?.title || asset?.original_name || '资产详情'}
        subtitle={
          asset
            ? `${asset.original_name} · ${asset.mime_type || 'unknown'}`
            : '加载单个资产的详细信息'
        }
        extra={
          detailStatus === 'ready' ? (
            <Space size="small" wrap>
              <Button
                icon={<ArrowLeftOutlined />}
                onClick={() => navigate('/library')}
              >
                返回资产库
              </Button>
              <Button loading={downloading} onClick={() => void onDownload()}>
                下载
              </Button>
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
          ) : undefined
        }
      />

      {detailStatus === 'loading' && (
        <Panel>
          <StateBlock status="loading" rows={6} />
        </Panel>
      )}

      {detailStatus === 'error' && (
        <div>
          <StateBlock
            status="error"
            title="资产加载失败"
            error={detailState.error}
            errorFallback="无法加载该资产"
            onRetry={() => void detailState.reload()}
          />
          <div
            style={{
              marginTop: tokens.space[4],
              display: 'flex',
              justifyContent: 'center',
            }}
          >
            <Button icon={<ArrowLeftOutlined />} onClick={() => navigate('/library')}>
              返回资产库
            </Button>
          </div>
        </div>
      )}

      {detailStatus === 'empty' && (
        <Panel>
          <StateBlock
            status="empty"
            title="资产不存在或已被删除"
            description="它可能已被软删除，或者链接有误。"
            action={
              <Button
                icon={<ArrowLeftOutlined />}
                onClick={() => navigate('/library')}
              >
                返回资产库
              </Button>
            }
          />
        </Panel>
      )}

      {detailStatus === 'ready' && asset && (
        <>
          {/* Two-column body */}
          <section
            style={{
              display: 'grid',
              gridTemplateColumns: 'minmax(0, 2fr) minmax(280px, 1fr)',
              gap: tokens.space[5],
            }}
          >
            {/* Hero — preview pane */}
            <Panel
              as="section"
              flush
              tone="sunken"
              style={{
                minHeight: 360,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                overflow: 'hidden',
              }}
            >
              {heroUrl ? (
                isVideo ? (
                  <video
                    src={heroUrl}
                    controls
                    poster={asset.thumbnail_url || undefined}
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
                    fontSize: tokens.fontSize.base,
                    padding: tokens.space[6],
                  }}
                >
                  暂无可预览的文件
                </div>
              )}
            </Panel>

            {/* Sidebar — info + metadata */}
            <AssetSidebar
              asset={asset}
              categoryName={categoryName}
              onCopy={onCopy}
            />
          </section>

          {/* Bottom action bar */}
          <Panel as="section">
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: tokens.space[3],
                flexWrap: 'wrap',
              }}
            >
              <div
                style={{
                  color: tokens.color.textMuted,
                  fontFamily: tokens.font.mono,
                  fontSize: tokens.fontSize.xs,
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
            </div>
          </Panel>
        </>
      )}

      {/* Edit modal — title + description only; other fields aren't on
          the current DTO. The PUT is intentionally narrow to avoid
          touching fields the backend treats as derived. `FormModal` owns
          the validate → submit sequence, so a failed rule never becomes
          an unhandled promise rejection. */}
      <FormModal
        open={editOpen}
        title="编辑资产"
        form={form}
        width={560}
        okText="保存"
        onCancel={() => setEditOpen(false)}
        onSubmit={onSaveEdit}
      >
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
        </Form>
      </FormModal>
    </div>
  );
}
