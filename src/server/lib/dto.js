'use strict';

/**
 * Canonical DTO serializers — the single source of truth for the shapes the
 * HTTP API returns.
 *
 * Every route that returns a database row MUST pass it through one of these
 * functions. The shapes produced here are mirrored 1:1 by
 * `frontend/src/types/index.ts`; the front↔back contract test
 * (`frontend/tests/contract.test.js`) fails the build if the two drift.
 */

const { signedStorageUrl } = require('./storage-url');

/**
 * Build a browser-reachable URL for a file stored under STORAGE_DIR.
 *
 * The URL is **signed**: it carries an expiry and an HMAC over the asset's
 * tenant and its path, so the storage route can tell that the server issued
 * it. The signature is what lets a browser's `<img src>` reach the file at
 * all — an image request cannot carry an `Authorization` header — and it is
 * also what stops the URL from working for another tenant's file.
 *
 * @param {string|null|undefined} relativePath e.g. "thumbnails/abc.webp"
 * @param {string|null|undefined} tenantId the tenant that owns the file
 * @returns {string|null}
 */
function storageUrl(relativePath, tenantId) {
  if (!relativePath) return null;
  const normalized = String(relativePath).split(/[\\/]+/).filter(Boolean).join('/');
  if (!normalized) return null;
  return signedStorageUrl(normalized, tenantId);
}

/**
 * Split the `GROUP_CONCAT` tag list produced by the asset queries.
 *
 * @param {string|null|undefined} csv
 * @returns {string[]}
 */
function parseTagNames(csv) {
  if (!csv) return [];
  return String(csv)
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
}

/**
 * Serialize an `assets` row (plus the `tag_names_csv` alias) into the
 * canonical asset shape.
 *
 * @param {Record<string, any>|null|undefined} row
 * @returns {import('../../frontend/src/types/index').Asset|null}
 */
function toAsset(row) {
  if (!row) return null;
  // The signature is computed over the asset's own tenant, so the URL only
  // ever opens the file it was issued for.
  const thumbnailUrl = storageUrl(row.thumbnail_path, row.tenant_id);
  const originalUrl = storageUrl(row.storage_path, row.tenant_id);
  return {
    id: row.id,
    title: row.title,
    description: row.description ?? null,
    filename: row.filename,
    original_name: row.original_name,
    mime_type: row.mime_type,
    file_size: row.file_size,
    file_hash: row.file_hash,
    asset_type: row.asset_type,
    category_id: row.category_id ?? null,
    width: row.width ?? null,
    height: row.height ?? null,
    duration: row.duration ?? null,
    storage_path: row.storage_path,
    thumbnail_path: row.thumbnail_path ?? null,
    thumbnail_url: thumbnailUrl,
    preview_url: thumbnailUrl || originalUrl,
    original_url: originalUrl,
    status: row.status,
    deleted_at: row.deleted_at ?? null,
    uploaded_by: row.uploaded_by ?? null,
    source: row.source,
    source_tool: row.source_tool ?? null,
    prompt: row.prompt ?? null,
    seed: row.seed ?? null,
    model_name: row.model_name ?? null,
    job_id: row.job_id ?? null,
    metadata_json: row.metadata_json ?? null,
    tag_names: parseTagNames(row.tag_names_csv),
    tenant_id: row.tenant_id ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/**
 * Serialize a `users` row into the canonical user shape.
 *
 * `status` and `is_superuser` are derived, not stored: the database only
 * knows `is_active` and `role`, and the UI needs a single vocabulary.
 *
 * @param {Record<string, any>|null|undefined} row
 * @returns {import('../../frontend/src/types/index').User|null}
 */
function toUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    email: row.email ?? null,
    display_name: row.display_name ?? null,
    role: row.role,
    status: row.is_active ? 'active' : 'disabled',
    is_superuser: row.role === 'admin',
    tenant_id: row.tenant_id ?? null,
    last_login_at: row.last_login_at ?? null,
    created_at: row.created_at,
  };
}

/**
 * Serialize an `api_keys` row into the canonical shape.
 *
 * `scopes` is stored as a CSV string in the database but exposed as an array
 * so the frontend never has to re-parse it.
 *
 * @param {Record<string, any>|null|undefined} row
 * @returns {import('../../frontend/src/types/index').ApiKey|null}
 */
function toApiKey(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    key_prefix: row.key_prefix,
    key_masked: `${row.key_prefix}************************`,
    scopes: String(row.scopes || '')
      .split(',')
      .map((scope) => scope.trim())
      .filter((scope) => scope.length > 0),
    is_active: !!row.is_active,
    last_used_at: row.last_used_at ?? null,
    expires_at: row.expires_at ?? null,
    created_at: row.created_at,
  };
}

/**
 * @param {Record<string, any>|null|undefined} row
 * @returns {import('../../frontend/src/types/index').Tag|null}
 */
function toTag(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    color: row.color ?? null,
    usage_count: row.usage_count ?? 0,
    created_at: row.created_at,
  };
}

/**
 * @param {Record<string, any>|null|undefined} row
 * @returns {import('../../frontend/src/types/index').Category|null}
 */
function toCategory(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    parent_id: row.parent_id ?? null,
    description: row.description ?? null,
    sort_order: row.sort_order ?? 0,
    created_at: row.created_at,
  };
}

/**
 * Serialize a `tenants` row into the canonical shape.
 *
 * The tenant is the thing that holds the others apart, so its shape is the
 * one the platform administrator picks from: the id (what a request names),
 * the slug and the name (what a human reads).
 *
 * @param {Record<string, any>|null|undefined} row
 * @returns {import('../../frontend/src/types/index').Tenant|null}
 */
function toTenant(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    status: row.status,
    created_at: row.created_at,
  };
}

/**
 * Split the CSV stored in `webhook_endpoints.events`.
 *
 * An empty result means "subscribed to every event" — see
 * `emitAssetEvent` in `backend/src/lib/assets.js`.
 *
 * @param {string|null|undefined} csv
 * @returns {string[]}
 */
function parseWebhookEvents(csv) {
  if (!csv) return [];
  return String(csv)
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
}

/**
 * Serialize a `webhook_endpoints` row into the canonical shape.
 *
 * `events` is stored as a CSV string in the database but exposed as an
 * array so the frontend never has to re-parse it. An empty array means
 * "subscribed to every event" — see `emitAssetEvent` in
 * `backend/src/lib/assets.js`.
 *
 * @param {Record<string, any>|null|undefined} row
 * @returns {import('../../frontend/src/types/index').WebhookEndpoint|null}
 */
function toWebhook(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    is_active: !!row.is_active,
    events: parseWebhookEvents(row.events),
    created_at: row.created_at,
  };
}

/**
 * Wrap a page of rows in the canonical pagination envelope.
 *
 * @template T
 * @param {T[]} items
 * @param {number} total
 * @param {number} page
 * @param {number} pageSize
 * @returns {{items: T[], total: number, page: number, page_size: number, total_pages: number}}
 */
function toPage(items, total, page, pageSize) {
  const size = pageSize > 0 ? pageSize : 1;
  return {
    items,
    total,
    page,
    page_size: pageSize,
    total_pages: Math.ceil(total / size),
  };
}

module.exports = {
  storageUrl,
  parseTagNames,
  parseWebhookEvents,
  toAsset,
  toUser,
  toApiKey,
  toTag,
  toCategory,
  toTenant,
  toWebhook,
  toPage,
};
