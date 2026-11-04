'use strict';

/**
 * Asset domain logic: uploading, tagging and the three deletion states an
 * asset can be in (active / soft-deleted / permanently removed).
 *
 * The read side — the row's columns, the filter builder, the list and the
 * single-row read — lives in `asset-query.js`, which this module re-exports:
 * every caller still requires `lib/assets`, so the split is invisible from
 * the routes. The split exists because the two halves are edited for
 * different reasons (a list filter versus an upload path), and one file
 * holding both grew past the project's 500-line limit.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { nanoid } = require('nanoid');
const { slugify } = require('./util');
const { DEFAULT_TENANT_ID } = require('./tenant-schema');
const { isAllTenants } = require('./tenant');
const { toAsset, parseWebhookEvents } = require('./dto');
const webhookLib = require('./webhook');
const assetQuery = require('./asset-query');
const { detectAssetType, findAssetById } = assetQuery;

/**
 * Attach a comma separated list of tag names to an asset, creating the tags
 * that do not exist yet.
 *
 * @param {object} db
 * @param {string} assetId
 * @param {string|null|undefined} tagNames
 * @returns {Promise<string[]>} the tag ids that are now linked
 */
async function attachTags(db, tenantId, assetId, tagNames) {
  const names = String(tagNames || '')
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);
  if (!names.length) return [];

  const findTag = db.prepare('SELECT id FROM tags WHERE tenant_id = ? AND name = ?');
  const insertTag = db.prepare('INSERT INTO tags (id, tenant_id, name, slug) VALUES (?, ?, ?, ?)');
  const link = db.prepare(
    'INSERT IGNORE INTO asset_tags (tenant_id, asset_id, tag_id) VALUES (?, ?, ?)',
  );
  const bump = db.prepare(
    'UPDATE tags SET usage_count = usage_count + 1 WHERE tenant_id = ? AND id = ?',
  );

  const linked = [];
  for (const name of names) {
    let row = await findTag.get(tenantId, name);
    if (!row) {
      const id = nanoid();
      try {
        await insertTag.run(id, tenantId, name, slugify(name));
        row = { id };
      } catch (e) {
        // A concurrent insert won the race (UNIQUE name) — re-read it
        // inside the same tenant, where the row may now exist.
        row = await findTag.get(tenantId, name);
      }
    }
    if (!row) continue;
    const result = await link.run(tenantId, assetId, row.id);
    if (result.changes > 0) await bump.run(tenantId, row.id);
    linked.push(row.id);
  }
  return linked;
}

/**
 * Remove every tag link of an asset and keep `usage_count` in sync.
 *
 * @param {object} db
 * @param {string} assetId
 * @returns {Promise<void>}
 */
async function detachAllTags(db, assetId) {
  const rows = await db
    .prepare('SELECT tenant_id, tag_id FROM asset_tags WHERE asset_id = ?')
    .all(assetId);
  for (const row of rows) {
    // SQLite's two-argument `MAX()` is MySQL's `GREATEST()`.
    await db
      .prepare(
        'UPDATE tags SET usage_count = GREATEST(usage_count - 1, 0) WHERE tenant_id = ? AND id = ?',
      )
      .run(row.tenant_id, row.tag_id);
  }
  // An asset id is a nanoid — globally unique — so the links of one asset
  // cannot belong to two tenants. The tenant is on every row above anyway.
  // tenant-lint: allow the asset id already identifies one tenant's rows
  await db.prepare('DELETE FROM asset_tags WHERE asset_id = ?').run(assetId);
}

/**
 * Does this endpoint want to receive `event`?
 *
 * @param {string|null|undefined} csv the raw `events` column
 * @param {string} event
 * @returns {boolean}
 */
function endpointSubscribesTo(csv, event) {
  const subscribed = parseWebhookEvents(csv);
  if (subscribed.length === 0) return true; // no subscription = all events
  return subscribed.includes(event);
}

/**
 * Fan-out an asset event to every active webhook endpoint subscribed to it.
 *
 * Fire-and-forget: each dispatch runs on its own promise chain so the HTTP
 * request never blocks on a slow or dead receiver.
 *
 * @param {object} db
 * @param {string} event
 * @param {Record<string, any>} assetRow
 * @returns {Promise<void>}
 */
async function emitAssetEvent(db, event, assetRow) {
  const asset = toAsset(assetRow) || assetRow;
  let endpoints;
  try {
    const tenantId = (assetRow && assetRow.tenant_id) || DEFAULT_TENANT_ID;
    endpoints = await db
      .prepare(
        'SELECT id, url, secret, events, tenant_id FROM webhook_endpoints WHERE tenant_id = ? AND is_active = 1',
      )
      .all(tenantId);
  } catch (e) {
    console.error('[webhook] failed to list active endpoints', {
      event,
      assetId: asset && asset.id,
      err: e.message,
    });
    return;
  }
  if (!endpoints.length) return;
  for (const endpoint of endpoints) {
    if (!endpointSubscribesTo(endpoint.events, event)) continue;
    webhookLib
      .dispatch(db, endpoint, event, asset)
      .catch((e) => console.warn('[webhook] dispatch err', { event, endpointId: endpoint.id, err: e.message }));
  }
}

/**
 * Store an uploaded buffer as a new asset.
 *
 * @param {Object} params
 * @param {object} params.db
 * @param {string} params.storageDir
 * @param {{buffer: Buffer, originalname: string, mimetype: string, size: number}} params.file
 * @param {string|null} params.ownerId
 * @param {string} params.source
 * @param {Object} [params.extra]
 * @returns {Promise<{duplicate: boolean, asset: any}>}
 */
async function processUpload({ db, storageDir, file, ownerId, source, extra, tenantId }) {
  const effectiveTenantId = tenantId || DEFAULT_TENANT_ID;
  const scope = { tenantId: effectiveTenantId, isSuperadmin: false };
  const hash = crypto.createHash('sha256').update(file.buffer).digest('hex');
  const existing = await db
    .prepare('SELECT id, status FROM assets WHERE tenant_id = ? AND file_hash = ?')
    .get(effectiveTenantId, hash);
  if (existing) {
    // A file that only lives in the trash is brought back instead of being
    // reported as a duplicate: re-uploading something the user can see in
    // the trash should put it back in the library, not silently do nothing.
    if (existing.status === 'deleted') {
      const restored = await restoreAsset(db, scope, await findAssetById(db, scope, existing.id));
      return { duplicate: false, asset: restored, restored: true };
    }
    return {
      duplicate: true,
      asset: await findAssetById(db, scope, existing.id),
    };
  }

  const id = nanoid();
  const ext = path.extname(file.originalname) || '';
  const storageName = `${id}${ext}`;
  const storagePath = path.join('originals', storageName);
  fs.writeFileSync(path.join(storageDir, storagePath), file.buffer);

  let width = null;
  let height = null;
  let duration = null;
  let thumbnailPath = null;
  try {
    const sharp = require('sharp');
    if (file.mimetype.startsWith('image/')) {
      const meta = await sharp(file.buffer).metadata();
      width = meta.width ?? null;
      height = meta.height ?? null;
      const thumbName = `${id}.webp`;
      thumbnailPath = path.join('thumbnails', thumbName);
      await sharp(file.buffer)
        .resize(400, 400, { fit: 'cover' })
        .webp({ quality: 80 })
        .toFile(path.join(storageDir, thumbnailPath));
    }
  } catch (e) {
    console.warn('[thumb] failed (non-fatal):', e.message);
  }

  const assetType = detectAssetType(file.mimetype);
  const {
    source_tool = null,
    prompt = null,
    seed = null,
    model_name = null,
    job_id = null,
    metadata = null,
    title = null,
    description = null,
    category_id = null,
    tag_names = null,
  } = extra || {};
  const metadataJson = metadata !== null && metadata !== undefined ? JSON.stringify(metadata) : null;

  await db
    .prepare(
      `INSERT INTO assets (id, tenant_id, title, description, filename, original_name, mime_type, file_size, file_hash, asset_type,
       category_id, width, height, duration, storage_path, thumbnail_path, uploaded_by, source, status,
       source_tool, prompt, seed, model_name, job_id, metadata_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
    id,
    effectiveTenantId,
    title || file.originalname,
    description,
    storageName,
    file.originalname,
    file.mimetype,
    file.size,
    hash,
    assetType,
    category_id,
    width,
    height,
    duration,
    storagePath,
    thumbnailPath,
    ownerId || null,
    source || 'admin',
    'ready',
    source_tool,
    prompt,
    Number.isFinite(seed) ? seed : null,
    model_name,
    job_id,
    metadataJson,
  );

  if (tag_names) await attachTags(db, effectiveTenantId, id, tag_names);

  try {
    await require('./manifest').markAssetForManifestWrite(db, id, 'create', effectiveTenantId);
    setImmediate(() => {
      require('./manifest')
        .writeManifestIndex(db, storageDir)
        .catch((e) => console.warn('[manifest] write failed', e.message));
    });
  } catch (e) {
    console.warn('[manifest] mark failed', e.message);
  }

  const asset = await findAssetById(db, scope, id);
  await emitAssetEvent(db, 'asset.created', asset);
  return { duplicate: false, asset };
}

/**
 * Move an asset to the trash. The row and its files stay on disk so the
 * asset can be restored.
 *
 * @param {object} db
 * @param {any} asset
 * @returns {Promise<any>} the updated asset row
 */
async function softDeleteAsset(db, scope, asset) {
  if (isAllTenants(scope)) {
    // tenant-lint: allow a superadmin acts across every tenant
    await db
      .prepare(
        "UPDATE assets SET status = 'deleted', deleted_at = NOW(), updated_at = NOW() WHERE id = ?",
      )
      .run(asset.id);
  } else {
    await db
      .prepare(
        "UPDATE assets SET status = 'deleted', deleted_at = NOW(), updated_at = NOW() WHERE id = ? AND tenant_id = ?",
      )
      .run(asset.id, scope.tenantId);
  }
  const updated = await findAssetById(db, scope, asset.id);
  await emitAssetEvent(db, 'asset.deleted', updated);
  return updated;
}

/**
 * Bring a soft-deleted asset back.
 *
 * @param {object} db
 * @param {any} asset
 * @returns {Promise<any>} the updated asset row
 */
async function restoreAsset(db, scope, asset) {
  if (isAllTenants(scope)) {
    // tenant-lint: allow a superadmin acts across every tenant
    await db
      .prepare(
        "UPDATE assets SET status = 'ready', deleted_at = NULL, updated_at = NOW() WHERE id = ?",
      )
      .run(asset.id);
  } else {
    await db
      .prepare(
        "UPDATE assets SET status = 'ready', deleted_at = NULL, updated_at = NOW() WHERE id = ? AND tenant_id = ?",
      )
      .run(asset.id, scope.tenantId);
  }
  const updated = await findAssetById(db, scope, asset.id);
  await emitAssetEvent(db, 'asset.restored', updated);
  return updated;
}

/**
 * Erase an asset for good: files first, then the row and its tag links.
 *
 * @param {object} db
 * @param {string} storageDir
 * @param {any} asset
 * @returns {Promise<void>}
 */
async function permanentlyDeleteAsset(db, storageDir, scope, asset) {
  try {
    fs.unlinkSync(path.join(storageDir, asset.storage_path));
    if (asset.thumbnail_path) fs.unlinkSync(path.join(storageDir, asset.thumbnail_path));
  } catch (e) {
    console.warn('[delete] file removal failed:', e.message);
  }
  await detachAllTags(db, asset.id);
  if (isAllTenants(scope)) {
    // tenant-lint: allow a superadmin acts across every tenant
    await db.prepare('DELETE FROM assets WHERE id = ?').run(asset.id);
  } else {
    await db
      .prepare('DELETE FROM assets WHERE id = ? AND tenant_id = ?')
      .run(asset.id, scope.tenantId);
  }
  // Send the event with the snapshot we read BEFORE the delete — downstream
  // consumers may want the metadata of what was removed.
  await emitAssetEvent(db, 'asset.deleted', asset);
}

module.exports = {
  // The read half, re-exported so every caller keeps requiring this module
  // and nothing but the file layout changed.
  ...assetQuery,
  attachTags,
  detachAllTags,
  emitAssetEvent,
  parseWebhookEvents,
  endpointSubscribesTo,
  processUpload,
  softDeleteAsset,
  restoreAsset,
  permanentlyDeleteAsset,
};
