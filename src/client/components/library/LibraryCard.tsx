import { Button, Checkbox, Tooltip, Typography } from 'antd';
import {
  DeleteOutlined,
  DownloadOutlined,
  FileImageOutlined,
  PlayCircleOutlined,
} from '@ant-design/icons';
import type { Asset, AssetStatus } from '@/types';
import { tokens } from '@/theme/tokens';
import { formatBytes } from '@/utils/format';
import { assetPreviewUrl } from '@/utils/assetUrls';

const { Text } = Typography;

export interface LibraryCardProps {
  asset: Asset;
  isSelected: boolean;
  onToggle: (id: string) => void;
  onOpen: (id: string) => void;
  onDownload: (asset: Asset) => void;
  onDelete: (asset: Asset) => void;
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

export default function LibraryCard({
  asset,
  isSelected,
  onToggle,
  onOpen,
  onDownload,
  onDelete,
}: LibraryCardProps): JSX.Element {
  const isVideo = asset.asset_type === 'video';
  const url = assetPreviewUrl(asset);

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
