import type { AssetStatus } from '@/types';
import type { PillTone } from '@/components/ui';
import { tokens } from '@/theme/tokens';

/**
 * Shared presentation rules for an asset's status.
 *
 * `AssetDetail` and `Jobs` both render an asset's status and both used to
 * carry a byte-identical copy of the same two switches — so a status could
 * read "就绪" on one page and "ready" on the other. One table, one look.
 */

const STATUS_LABELS: Partial<Record<AssetStatus, string>> = {
  ready: '就绪',
  processing: '处理中',
  failed: '失败',
  deleted: '已删除',
};

/** Chinese label for an asset status. */
export function statusLabel(status: AssetStatus): string {
  return STATUS_LABELS[status] ?? status;
}

const STATUS_COLORS: Partial<Record<AssetStatus, string>> = {
  ready: tokens.color.success,
  processing: tokens.color.jobBadge,
  failed: tokens.color.danger,
  deleted: tokens.color.textMuted,
};

/** Token colour that stands for an asset status. */
export function statusColor(status: AssetStatus): string {
  return STATUS_COLORS[status] ?? tokens.color.textMuted;
}

const STATUS_TONES: Partial<Record<AssetStatus, PillTone>> = {
  ready: 'success',
  processing: 'accent',
  failed: 'danger',
  deleted: 'neutral',
};

/** `Pill` tone that stands for an asset status. */
export function statusTone(status: AssetStatus): PillTone {
  return STATUS_TONES[status] ?? 'neutral';
}
