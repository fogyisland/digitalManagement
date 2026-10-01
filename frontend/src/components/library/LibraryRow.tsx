import { Button, Checkbox, Space, Typography } from 'antd';
import {
  DeleteOutlined,
  DownloadOutlined,
  FileImageOutlined,
  PlayCircleOutlined,
} from '@ant-design/icons';
import type { Asset } from '@/types/dto';
import { tokens } from '@/theme/tokens';
import { formatBytes } from '@/utils/format';

const { Text } = Typography;

export interface LibraryRowProps {
  asset: Asset;
  isSelected: boolean;
  onToggle: (id: string) => void;
  onOpen: (id: string) => void;
  onDownload: (asset: Asset) => void;
  onDelete: (asset: Asset) => void;
}

/**
 * Backend exposes `thumbnail_path` (relative to STORAGE_DIR, e.g.
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

export default function LibraryRow({
  asset,
  isSelected,
  onToggle,
  onOpen,
  onDownload,
  onDelete,
}: LibraryRowProps): JSX.Element {
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
