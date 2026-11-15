import { Button, Checkbox, Tooltip, Typography } from 'antd';
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
import { assetTypeLabel, statusBadgeColor, statusLabel } from './labels';

const { Text } = Typography;

export interface LibraryCardProps {
  asset: Asset;
  isSelected: boolean;
  onToggle: (id: string) => void;
  onOpen: (id: string) => void;
  onDownload: (asset: Asset) => void;
  onDelete: (asset: Asset) => void;
}

/**
 * A single asset in the library grid.
 *
 * ## Interaction model
 *
 * The card used to be a `div` with `role="button"` that contained a
 * `Checkbox` and two action buttons. Nesting real controls inside a
 * `role="button"` element is invalid — assistive technology reads the
 * whole card as one button and the inner controls become unreachable.
 *
 * It now uses the "stretched overlay" pattern: the card is a plain `div`,
 * an absolutely positioned transparent `button` covers it and carries the
 * card's accessible name, and the checkbox and action bar sit above that
 * overlay in the stacking order. Every control is a real control, each one
 * is separately focusable, and the whole card still opens on click.
 */
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
  const title = asset.title || asset.original_name || '(无标题)';

  return (
    <div
      className="dam-asset-card"
      data-selected={isSelected}
      style={{
        position: 'relative',
        background: tokens.color.panel,
        borderRadius: tokens.radius.lg,
        overflow: 'hidden',
        cursor: 'pointer',
      }}
    >
      {/* The card's single primary action. */}
      <button
        type="button"
        className="dam-asset-card-overlay"
        aria-label={`打开 ${title}`}
        onClick={() => onOpen(asset.id)}
      />

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
            zIndex: 3,
          }}
        />
      )}

      {/* Selection checkbox — sits above the overlay so it stays clickable. */}
      <div
        style={{
          position: 'absolute',
          top: tokens.space[2],
          left: tokens.space[2],
          zIndex: 2,
          background: tokens.color.overlayChip,
          borderRadius: tokens.radius.sm,
          padding: 4,
          backdropFilter: 'blur(2px)',
        }}
      >
        <Checkbox
          checked={isSelected}
          aria-label={`选择 ${title}`}
          // Stopping the click here is what keeps the card from opening
          // when the user only meant to tick the box. The toggle happens
          // in `onChange` — doing it in an extra wrapper `onClick` as well
          // would call it twice and cancel itself out.
          onClick={(e) => e.stopPropagation()}
          onChange={() => onToggle(asset.id)}
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
          <img
            src={url}
            alt={title}
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
            aria-hidden
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
            aria-hidden
            style={{
              position: 'absolute',
              top: tokens.space[2],
              right: tokens.space[2],
              padding: '2px 8px',
              fontSize: tokens.fontSize.xs,
              color: tokens.color.text,
              background: tokens.color.overlay,
              borderRadius: tokens.radius.sm,
              pointerEvents: 'none',
            }}
          >
            视频
          </span>
        )}
        {asset.status !== 'ready' && (
          <span
            aria-hidden
            style={{
              position: 'absolute',
              bottom: tokens.space[2],
              right: tokens.space[2],
              padding: '2px 8px',
              fontSize: tokens.fontSize.xs,
              color: statusBadgeColor(asset.status),
              background: tokens.color.overlay,
              borderRadius: tokens.radius.sm,
              pointerEvents: 'none',
            }}
          >
            {statusLabel(asset.status)}
          </span>
        )}
        <div
          className="dam-card-actions"
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            bottom: 0,
            padding: tokens.space[2],
            background: `linear-gradient(to top, ${tokens.color.overlaySoft}, transparent)`,
            display: 'flex',
            justifyContent: 'flex-end',
            gap: tokens.space[2],
            zIndex: 2,
          }}
        >
          <Tooltip title="下载原始文件">
            <Button
              size="small"
              icon={<DownloadOutlined />}
              aria-label={`下载 ${title} 的原始文件`}
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
              aria-label={`删除 ${title}`}
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
          transition: `padding-left ${tokens.motion.fast} ease`,
        }}
      >
        <Text
          strong
          ellipsis
          style={{
            display: 'block',
            color: tokens.color.text,
            fontSize: tokens.fontSize.md,
            lineHeight: 1.4,
          }}
          title={title}
        >
          {title}
        </Text>
        <div
          style={{
            marginTop: 4,
            display: 'flex',
            gap: tokens.space[3],
            color: tokens.color.textMuted,
            fontSize: tokens.fontSize.sm,
            fontFamily: tokens.font.mono,
          }}
        >
          <span>{assetTypeLabel(asset.asset_type)}</span>
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
