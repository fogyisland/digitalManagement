/**
 * Dashboard.
 *
 * Visual language:
 *   - 4 large number cards (total / images / videos / size)
 *   - recent 10 assets as a compact mono-typed row list
 *   - tokens only — no raw colours, no legacy CSS classes
 *
 * Data fetch goes through `useApi<DashboardData>` so it shares the loading
 * and error contract with the rest of the app. We still read `summary`
 * defensively (the legacy shape had extra fields we no longer render) and
 * trim the recent list to 10 for the compact row.
 */
import { useMemo } from 'react';
import { Space, Typography } from 'antd';
import {
  AppstoreOutlined,
  PictureOutlined,
  PlayCircleOutlined,
  HddOutlined,
} from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { useApi } from '@/api/hooks';
import { PageHeader, Panel, StateBlock, resolveDataStatus } from '@/components/ui';
import type { DashboardData } from '@/types';
import { tokens } from '@/theme/tokens';
import { formatBytes, formatDate } from '@/utils/format';
import { assetPreviewUrl } from '@/utils/assetUrls';
import { assetTypeLabel } from '@/components/library/labels';

const { Text, Title } = Typography;

interface NumberCard {
  key: string;
  label: string;
  value: string;
  hint: string;
  icon: React.ReactNode;
}

export default function Dashboard(): JSX.Element {
  const navigate = useNavigate();
  const state = useApi<DashboardData>('/stats/dashboard');

  const summary = state.data?.summary;
  const recentAssets = useMemo(
    () => (state.data?.recent_assets ?? []).slice(0, 10),
    [state.data?.recent_assets],
  );

  const cards: NumberCard[] = useMemo(() => {
    if (!summary) return [];
    return [
      {
        key: 'total',
        label: '总资产',
        value: summary.total_assets.toLocaleString(),
        hint: `图片 ${summary.image_count.toLocaleString()} · 视频 ${summary.video_count.toLocaleString()}`,
        icon: <AppstoreOutlined />,
      },
      {
        key: 'images',
        label: '图片',
        value: summary.image_count.toLocaleString(),
        hint: `${summary.total_assets > 0 ? Math.round((summary.image_count / summary.total_assets) * 100) : 0}% 占总量`,
        icon: <PictureOutlined />,
      },
      {
        key: 'videos',
        label: '视频',
        value: summary.video_count.toLocaleString(),
        hint: `${summary.total_assets > 0 ? Math.round((summary.video_count / summary.total_assets) * 100) : 0}% 占总量`,
        icon: <PlayCircleOutlined />,
      },
      {
        key: 'size',
        label: '存储占用',
        value: `${summary.storage_used_gb.toFixed(2)} GB`,
        hint: formatBytes(summary.total_size_bytes),
        icon: <HddOutlined />,
      },
    ];
  }, [summary]);

  const status = resolveDataStatus({
    loading: state.loading,
    error: state.error,
    hasData: !!summary,
    isEmpty: cards.length === 0,
  });

  if (status === 'loading') {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.space[5] }}>
        <PageHeader title="仪表盘" subtitle="正在读取资产库统计…" />
        <Panel>
          <StateBlock status="loading" rows={6} />
        </Panel>
      </div>
    );
  }

  if (status === 'error' || !summary) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.space[5] }}>
        <PageHeader title="仪表盘" subtitle="资产库整体状态" />
        <Panel>
          <StateBlock
            status="error"
            title="仪表盘数据加载失败"
            error={state.error}
            errorFallback="仪表盘数据不可用"
            onRetry={() => void state.reload()}
          />
        </Panel>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.space[5] }}>
      <PageHeader
        title="仪表盘"
        subtitle="资产库整体状态概览"
      />

      {/* Four large number cards */}
      <section
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
          gap: tokens.space[4],
        }}
      >
        {cards.map((c) => (
          <Panel key={c.key} accent>
            <Space size="small" align="center">
              <span
                aria-hidden
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  width: 32,
                  height: 32,
                  borderRadius: tokens.radius.sm,
                  background: tokens.color.accentSoft,
                  color: tokens.color.accent,
                  fontSize: 16,
                }}
              >
                {c.icon}
              </span>
              <Text
                style={{
                  color: tokens.color.textMuted,
                  fontSize: tokens.fontSize.sm,
                }}
              >
                {c.label}
              </Text>
            </Space>
            <div
              style={{
                marginTop: tokens.space[2],
                fontSize: tokens.fontSize['3xl'],
                fontWeight: tokens.fontWeight.semibold,
                color: tokens.color.text,
                lineHeight: 1.1,
                fontFamily: tokens.font.mono,
                letterSpacing: '-0.02em',
              }}
            >
              {c.value}
            </div>
            <Text style={{ color: tokens.color.textMuted, fontSize: tokens.fontSize.sm }}>
              {c.hint}
            </Text>
          </Panel>
        ))}
      </section>

      {/* Recent 10 assets — compact mono-typed row list */}
      <Panel>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginBottom: tokens.space[3],
          }}
        >
          <Title
            level={4}
            style={{ margin: 0, color: tokens.color.text, fontWeight: tokens.fontWeight.semibold }}
          >
            最近 10 条资产
          </Title>
          <a
            href="/library"
            onClick={(e) => {
              e.preventDefault();
              navigate('/library');
            }}
            style={{ color: tokens.color.accent, fontSize: tokens.fontSize.base, textDecoration: 'none' }}
          >
            查看全部 →
          </a>
        </div>

        {recentAssets.length === 0 ? (
          <Text style={{ color: tokens.color.textMuted, fontSize: tokens.fontSize.base }}>
            暂无最近上传的资产
          </Text>
        ) : (
          <Space direction="vertical" size="small" style={{ width: '100%' }}>
            {recentAssets.map((asset) => {
              const preview = assetPreviewUrl(asset);
              const isVideo = asset.asset_type === 'video';
              const title = asset.title || asset.original_name || '(无标题)';
              return (
                <div
                  key={asset.id}
                  className="dam-asset-row"
                  role="button"
                  tabIndex={0}
                  aria-label={`打开 ${title}`}
                  onClick={() => navigate(`/library/${asset.id}`)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      navigate(`/library/${asset.id}`);
                    }
                  }}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: tokens.space[3],
                    padding: `${tokens.space[2]}px ${tokens.space[3]}px`,
                    background: tokens.color.bgAlt,
                    borderRadius: tokens.radius.md,
                    cursor: 'pointer',
                  }}
                >
                  <div
                    aria-hidden
                    style={{
                      width: 36,
                      height: 36,
                      flexShrink: 0,
                      borderRadius: tokens.radius.sm,
                      background: tokens.color.bg,
                      overflow: 'hidden',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      color: tokens.color.textMuted,
                    }}
                  >
                    {preview ? (
                      <img
                        src={preview}
                        alt=""
                        loading="lazy"
                        style={{
                          width: '100%',
                          height: '100%',
                          objectFit: 'cover',
                        }}
                      />
                    ) : isVideo ? (
                      <PlayCircleOutlined />
                    ) : (
                      <PictureOutlined />
                    )}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <Text
                      strong
                      ellipsis
                      style={{
                        display: 'block',
                        color: tokens.color.text,
                        fontSize: tokens.fontSize.base,
                      }}
                      title={title}
                    >
                      {title}
                    </Text>
                    <Text
                      style={{
                        display: 'block',
                        color: tokens.color.textMuted,
                        fontSize: tokens.fontSize.xs,
                        fontFamily: tokens.font.mono,
                      }}
                    >
                      {assetTypeLabel(asset.asset_type)}
                      {' · '}
                      {formatBytes(asset.file_size)}
                      {' · '}
                      {formatDate(asset.created_at)}
                    </Text>
                  </div>
                </div>
              );
            })}
          </Space>
        )}
      </Panel>
    </div>
  );
}
