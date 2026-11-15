import { Button, Checkbox, Space, Typography } from 'antd';
import {
  DeleteOutlined,
  DownloadOutlined,
  FileImageOutlined,
  PlayCircleOutlined,
} from '@ant-design/icons';
import type { Asset } from '@/types';
import { tokens } from '@/theme/tokens';
import { formatBytes } from '@/utils/format';
import { assetPreviewUrl } from '@/utils/assetUrls';
import { assetTypeLabel } from './labels';

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
 * One asset in the library's list view.
 *
 * Uses the same "stretched overlay" pattern as `LibraryCard`: the row is a
 * plain element, a transparent button carries the row's accessible name and
 * opens the asset, and the checkbox and the action buttons sit above it.
 */
export default function LibraryRow({
  asset,
  isSelected,
  onToggle,
  onOpen,
  onDownload,
  onDelete,
}: LibraryRowProps): JSX.Element {
  const isVideo = asset.asset_type === 'video';
  const url = assetPreviewUrl(asset);
  const title = asset.title || asset.original_name || '(无标题)';

  return (
    <div
      className="dam-asset-row"
      data-selected={isSelected}
      style={{
        position: 'relative',
        display: 'flex',
        alignItems: 'center',
        gap: tokens.space[3],
        padding: `${tokens.space[2]}px ${tokens.space[3]}px`,
        background: isSelected ? tokens.color.accentFaint : tokens.color.panel,
        borderRadius: tokens.radius.md,
        cursor: 'pointer',
      }}
    >
      <button
        type="button"
        className="dam-asset-card-overlay"
        aria-label={`打开 ${title}`}
        onClick={() => onOpen(asset.id)}
      />

      <span style={{ position: 'relative', zIndex: 2, display: 'inline-flex' }}>
        <Checkbox
          checked={isSelected}
          aria-label={`选择 ${title}`}
          onClick={(e) => e.stopPropagation()}
          onChange={() => onToggle(asset.id)}
        />
      </span>

      <div
        aria-hidden
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
            alt=""
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
          title={title}
        >
          {title}
        </Text>
        <Text
          style={{
            display: 'block',
            color: tokens.color.textMuted,
            fontSize: tokens.fontSize.sm,
            fontFamily: tokens.font.mono,
          }}
        >
          {assetTypeLabel(asset.asset_type)} · {formatBytes(asset.file_size)}
          {asset.source_tool ? ` · ${asset.source_tool}` : ''}
        </Text>
      </div>

      <Space size="small" style={{ position: 'relative', zIndex: 2 }}>
        <Button
          size="small"
          icon={<DownloadOutlined />}
          aria-label={`下载 ${title} 的原始文件`}
          onClick={(e) => {
            e.stopPropagation();
            onDownload(asset);
          }}
        />
        <Button
          size="small"
          danger
          icon={<DeleteOutlined />}
          aria-label={`删除 ${title}`}
          onClick={(e) => {
            e.stopPropagation();
            onDelete(asset);
          }}
        />
      </Space>
    </div>
  );
}
