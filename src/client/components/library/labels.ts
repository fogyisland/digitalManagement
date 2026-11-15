import type { AssetStatus, AssetType } from '@/types';
import { tokens } from '@/theme/tokens';

/**
 * Shared labels and tones for the library surfaces.
 *
 * `LibraryCard` and `LibraryRow` both render an asset's type and status, and
 * they used to drift apart (one showed the raw `image` / `ready` enum, the
 * other a Chinese word). One table, one look.
 */

const ASSET_TYPE_LABELS: Record<AssetType, string> = {
  image: '图片',
  video: '视频',
  other: '其他',
};

export function assetTypeLabel(type: AssetType | string | undefined): string {
  if (!type) return '未知';
  return ASSET_TYPE_LABELS[type as AssetType] ?? String(type);
}

const STATUS_LABELS: Record<AssetStatus, string> = {
  ready: '就绪',
  processing: '处理中',
  failed: '失败',
  deleted: '已删除',
};

export function statusLabel(status: AssetStatus | string | undefined): string {
  if (!status) return '未知';
  return STATUS_LABELS[status as AssetStatus] ?? String(status);
}

const STATUS_COLORS: Record<AssetStatus, string> = {
  ready: tokens.color.success,
  processing: tokens.color.jobBadge,
  failed: tokens.color.danger,
  deleted: tokens.color.textMuted,
};

export function statusBadgeColor(status: AssetStatus | string | undefined): string {
  if (!status) return tokens.color.textMuted;
  return STATUS_COLORS[status as AssetStatus] ?? tokens.color.textMuted;
}
