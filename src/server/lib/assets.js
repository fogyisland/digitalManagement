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
 * The sha256 of a file on disk.
 *
 * A file that is too big to hold in memory is hashed by reading it, not by
 * loading it — the same reason the chunked upload merges its parts on disk.
 *
 * @param {string} filePath
 * @returns {Promise<string>} lowercase hex digest
 */
function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

/**
 * Store an uploaded buffer as a new asset.
 *
 * The file arrives either as a buffer (the multipart doors) or as a path on
 * disk (the chunked door, whose whole point is a file that does not fit in
 * memory). The path form never loads the file into memory.
 *
 * @param {Object} params
 * @param {object} params.db
 * @param {string} params.storageDir
 * @param {{buffer?: Buffer, path?: string, originalname: string, mimetype: string, size: number}} params.file
 * @param {string|null} params.ownerId
 * @param {string} params.source
 * @param {Object} [params.extra]
 * @returns {Promise<{duplicate: boolean, asset: any}>}
 */
async function processUpload({ db, storageDir, file, ownerId, source, extra, tenantId }) {
  const effectiveTenantId = tenantId || DEFAULT_TENANT_ID;
  const scope = { tenantId: effectiveTenantId, isSuperadmin: false };
  const sourcePath = file.path || null;
  const hash = sourcePath
    ? await hashFile(sourcePath)
    : crypto.createHash('sha256').update(file.buffer).digest('hex');
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
  const destination = path.join(storageDir, storagePath);
  if (sourcePath) {
    // The file is already on disk — it is moved into place, not read.
    fs.copyFileSync(sourcePath, destination);
  } else {
    fs.writeFileSync(destination, file.buffer);
  }

  let width = null;
  let height = null;
  let duration = null;
  let thumbnailPath = null;
  try {
    const sharp = require('sharp');
    if (file.mimetype.startsWith('image/')) {
      // Sharp reads a path or a buffer; the path form keeps the pixels out
      // of this process's memory.
      const pixels = sourcePath || file.buffer;
      const meta = await sharp(pixels).metadata();
      width = meta.width ?? null;
      height = meta.height ?? null;
      const thumbName = `${id}.webp`;
      thumbnailPath = path.join('thumbnails', thumbName);
      await sharp(pixels)
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

  // The category has to be one of this tenant's — see `resolveCategoryId`.
  const safeCategoryId = await resolveCategoryId(db, effectiveTenantId, category_id);

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
    safeCategoryId,
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
 * The category an asset belongs to, if it is one of this tenant's.
 *
 * A category id that names another tenant's category would be a dangling
 * reference: the asset would point at a category its own tenant cannot see,
 * and the other tenant's delete would not clean the reference up. So the id is
 * checked against the tenant the asset belongs to, and an id that is not one
 * of its own is dropped rather than written.
 *
 * @param {object} db
 * @param {string} tenantId the tenant the asset belongs to
 * @param {unknown} categoryId the id that was asked for
 * @returns {Promise<string|null>}
 */
async function resolveCategoryId(db, tenantId, categoryId) {
  if (categoryId === undefined || categoryId === null || categoryId === '') return null;
  const row = await db
    .prepare('SELECT id FROM categories WHERE id = ? AND tenant_id = ?')
    .get(String(categoryId), tenantId);
  return row ? row.id : null;
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
  // The row was read through the tenant scope, so the update is conditioned on
  // the asset's **own** tenant: a write lands in the tenant the asset belongs
  // to — not in the wildcard, and not in a tenant the caller chose. A platform
  // administrator who reaches this far has reached one specific asset, and
  // that asset's tenant is where the change belongs.
  await db
    .prepare(
      "UPDATE assets SET status = 'deleted', deleted_at = NOW(), updated_at = NOW() WHERE id = ? AND tenant_id = ?",
    )
    .run(asset.id, asset.tenant_id);
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
  // Conditioned on the asset's own tenant, like the delete above.
  await db
    .prepare(
      "UPDATE assets SET status = 'ready', deleted_at = NULL, updated_at = NOW() WHERE id = ? AND tenant_id = ?",
    )
    .run(asset.id, asset.tenant_id);
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
  // Conditioned on the asset's own tenant, like the delete above.
  await db
    .prepare('DELETE FROM assets WHERE id = ? AND tenant_id = ?')
    .run(asset.id, asset.tenant_id);
  // Send the event with the snapshot we read BEFORE the delete — downstream
  // consumers may want the metadata of what was removed.
  await emitAssetEvent(db, 'asset.deleted', asset);
}

/**
 * Change an asset's metadata.
 *
 * The HTTP route and the MCP tool both change an asset, and they must change
 * it the same way — so the change lives here rather than in either caller.
 *
 * The row was read through the tenant scope, so the update is conditioned on
 * the asset's **own** tenant: a caller can never reach another tenant's asset
 * even if it guessed an id.
 *
 * @param {object} db
 * @param {{tenantId: string, isSuperadmin: boolean}} scope
 * @param {any} asset the asset row, already read through the scope
 * @param {{title?: string, description?: string, category_id?: string, tag_names?: string, status?: string}} body
 * @returns {Promise<any>} the updated asset row
 */
async function updateAsset(db, scope, asset, body) {
  const { title, description, category_id, tag_names, status } = body || {};
  if (
    status !== undefined &&
    status !== null &&
    !['ready', 'processing', 'failed'].includes(String(status))
  ) {
    throw Object.assign(new Error(`Unsupported status: ${status}`), { status: 400 });
  }
  await db
    .prepare(
      `UPDATE assets SET title = COALESCE(?, title), description = ?, category_id = ?, status = COALESCE(?, status),
       updated_at = NOW() WHERE id = ? AND tenant_id = ?`,
    )
    .run(
      title || null,
      description !== undefined ? description : asset.description,
      // The category has to be one of this asset's tenant — see
      // `resolveCategoryId`.
      await resolveCategoryId(
        db,
        asset.tenant_id,
        category_id !== undefined ? category_id : asset.category_id,
      ),
      status || null,
      asset.id,
      asset.tenant_id,
    );
  if (tag_names !== undefined && tag_names !== null) {
    // The tags land in the asset's own tenant — the row was read through the
    // scope above, so this is the tenant the asset belongs to and not the one
    // the request happens to speak for.
    await attachTags(db, asset.tenant_id, asset.id, tag_names);
  }
  const updated = await findAssetById(db, scope, asset.id);
  await emitAssetEvent(db, 'asset.updated', updated);
  return updated;
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
  updateAsset,
  softDeleteAsset,
  restoreAsset,
  permanentlyDeleteAsset,
  resolveCategoryId,
};
