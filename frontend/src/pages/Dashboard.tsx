/**
 * Dashboard — Task 18.
 *
 * Visual language:
 *   - 4 large number cards (total / images / videos / size)
 *   - recent 10 assets as a compact mono-typed row list
 *   - no gradient glows, no all-caps eyebrows; uses `tokens` only
 *
 * Data fetch goes through `useApi<DashboardData>` so it shares the
 * cache + loading contract with Library/Organize/Jobs. We still read
 * `summary` defensively (the legacy shape had extra fields we no longer
 * render) and trim the recent list to 10 for the compact row.
 */
import { useMemo } from 'react';
import { Skeleton, Space, Typography } from 'antd';
import {
  AppstoreOutlined,
  PictureOutlined,
  PlayCircleOutlined,
  HddOutlined,
} from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { useApi } from '@/api/hooks';
import type { DashboardData } from '@/types';
import { tokens } from '@/theme/tokens';
import { formatBytes, formatDate } from '@/utils/format';
import { assetPreviewUrl } from '@/utils/assetUrls';

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

  if (state.loading && !state.data) {
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

  if (state.error || !summary) {
    return (
      <div
        style={{
          padding: tokens.space[5],
          background: tokens.color.panel,
          border: `1px solid ${tokens.color.border}`,
          borderRadius: tokens.radius.lg,
          color: tokens.color.danger,
        }}
      >
        加载失败：{state.error?.message ?? '仪表盘数据不可用'}
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.space[5] }}>
      <header>
        <Title
          level={2}
          style={{
            margin: 0,
            color: tokens.color.text,
            fontWeight: 600,
            letterSpacing: '-0.01em',
          }}
        >
          仪表盘
        </Title>
        <Text style={{ color: tokens.color.textMuted, fontSize: 13 }}>
          资产库整体状态 · 数据更新于 {formatDate(new Date().toISOString())}
        </Text>
      </header>

      {/* Four large number cards */}
      <section
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
          gap: tokens.space[4],
        }}
      >
        {cards.map((c) => (
          <div
            key={c.key}
            style={{
              background: tokens.color.panel,
              border: `1px solid ${tokens.color.border}`,
              borderLeft: `2px solid ${tokens.color.accent}`,
              borderRadius: tokens.radius.lg,
              padding: tokens.space[4],
              display: 'flex',
              flexDirection: 'column',
              gap: tokens.space[2],
            }}
          >
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
                  background: 'rgba(245, 165, 36, 0.12)',
                  color: tokens.color.accent,
                  fontSize: 16,
                }}
              >
                {c.icon}
              </span>
              <Text
                style={{
                  color: tokens.color.textMuted,
                  fontSize: 12,
                  textTransform: 'none',
                  letterSpacing: 0,
                }}
              >
                {c.label}
              </Text>
            </Space>
            <div
              style={{
                fontSize: 32,
                fontWeight: 600,
                color: tokens.color.text,
                lineHeight: 1.1,
                fontFamily: tokens.font.mono,
                letterSpacing: '-0.02em',
              }}
            >
              {c.value}
            </div>
            <Text style={{ color: tokens.color.textMuted, fontSize: 12 }}>
              {c.hint}
            </Text>
          </div>
        ))}
      </section>

      {/* Recent 10 assets — compact mono-typed row list */}
      <section
        style={{
          background: tokens.color.panel,
          border: `1px solid ${tokens.color.border}`,
          borderRadius: tokens.radius.lg,
          padding: tokens.space[4],
        }}
      >
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
            style={{ margin: 0, color: tokens.color.text, fontWeight: 600 }}
          >
            最近 10 条资产
          </Title>
          <a
            href="/library"
            onClick={(e) => {
              e.preventDefault();
              navigate('/library');
            }}
            style={{ color: tokens.color.accent, fontSize: 13, textDecoration: 'none' }}
          >
            查看全部 →
          </a>
        </div>

        {recentAssets.length === 0 ? (
          <Text style={{ color: tokens.color.textMuted, fontSize: 13 }}>
            暂无最近上传的资产
          </Text>
        ) : (
          <Space direction="vertical" size="small" style={{ width: '100%' }}>
            {recentAssets.map((asset) => {
              const preview = assetPreviewUrl(asset);
              const isVideo = asset.asset_type === 'video';
              return (
                <div
                  key={asset.id}
                  role="button"
                  tabIndex={0}
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
                    border: `1px solid ${tokens.color.border}`,
                    borderRadius: tokens.radius.md,
                    cursor: 'pointer',
                    transition: 'border-color 120ms ease, background 120ms ease',
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.borderColor = tokens.color.borderStrong;
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.borderColor = tokens.color.border;
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
                        alt={asset.title}
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
                        fontSize: 13,
                      }}
                      title={asset.title}
                    >
                      {asset.title || asset.original_name || '(无标题)'}
                    </Text>
                    <Text
                      style={{
                        display: 'block',
                        color: tokens.color.textMuted,
                        fontSize: 11,
                        fontFamily: tokens.font.mono,
                      }}
                    >
                      {asset.asset_type}
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
      </section>
    </div>
  );
}
