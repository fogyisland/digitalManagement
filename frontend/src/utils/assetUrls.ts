import type { Asset } from '@/types';

/**
 * Asset URL helpers.
 *
 * The backend already resolves the storage paths into browser URLs:
 * `toAsset()` in `backend/src/lib/dto.js` turns `thumbnail_path` and
 * `storage_path` into `/storage/...` URLs. The frontend therefore only has
 * to *pick* one of them — rebuilding `/storage/...` by hand in five places
 * is exactly the kind of duplication that drifts away from the contract.
 */

/** The fields a preview lookup needs. */
export type AssetUrlSource = Pick<
  Asset,
  'thumbnail_url' | 'preview_url' | 'original_url'
>;

/**
 * The best image URL for an asset: thumbnail first, then the preview
 * fallback, then the original file.
 *
 * @returns an absolute path under `/storage`, or `null` when the asset has
 *          no file behind it.
 */
export function assetPreviewUrl(asset: AssetUrlSource): string | null {
  return asset.thumbnail_url || asset.preview_url || asset.original_url || null;
}

/**
 * The original file's URL — used for downloads and full-size viewing.
 */
export function assetOriginalUrl(asset: AssetUrlSource): string | null {
  return asset.original_url || asset.preview_url || asset.thumbnail_url || null;
}
