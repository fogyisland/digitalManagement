'use strict';

/**
 * Asset domain logic: querying, uploading, tagging and the three deletion
 * states an asset can be in (active / soft-deleted / permanently removed).
 *
 * The query builder here is the *only* place that knows the asset list
 * contract — the frontend mirrors these parameter names in
 * `frontend/src/api/assets.ts`.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { nanoid } = require('nanoid');
const { slugify, parsePositiveInt, parseBoolean } = require('./util');
const { toAsset, parseWebhookEvents } = require('./dto');
const webhookLib = require('./webhook');

const MAX_PAGE_SIZE = 200;

/**
 * Column list for asset reads. The `tag_names_csv` alias is a correlated
 * subquery so a list of N assets still costs exactly one SQL statement.
 */
const ASSET_COLUMNS = `
  a.id, a.title, a.description, a.filename, a.original_name, a.mime_type,
  a.file_size, a.file_hash, a.asset_type, a.category_id, a.width, a.height,
  a.duration, a.storage_path, a.thumbnail_path, a.status, a.deleted_at,
  a.uploaded_by, a.source, a.source_tool, a.prompt, a.seed, a.model_name,
  a.job_id, a.metadata_json, a.created_at, a.updated_at,
  (SELECT GROUP_CONCAT(t.name, ',')
     FROM asset_tags at
     JOIN tags t ON t.id = at.tag_id
    WHERE at.asset_id = a.id) AS tag_names_csv
`;

/** Whitelist for the `order_by` parameter — never interpolate raw input. */
const ORDER_BY = {
  created_at_desc: 'a.created_at DESC',
  created_at_asc: 'a.created_at ASC',
  size_desc: 'a.file_size DESC',
  size_asc: 'a.file_size ASC',
  title_asc: 'a.title COLLATE NOCASE ASC',
  title_desc: 'a.title COLLATE NOCASE DESC',
};

/** Valid asset status values — the single vocabulary shared with the UI. */
const ASSET_STATUSES = ['ready', 'processing', 'failed', 'deleted'];

/**
 * @param {string|null|undefined} mime
 * @returns {'image'|'video'|'other'}
 */
function detectAssetType(mime) {
  if (!mime) return 'other';
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  return 'other';
}

/**
 * Build the WHERE clause for an asset listing.
 *
 * Parameters (the asset list contract):
 *   q               — free-text search over title / description / original_name
 *   asset_type      — image | video | other
 *   category_id     — exact category
 *   tag_names       — comma separated tag names; every listed tag must match
 *   uploader_id     — exact uploader
 *   source_tool     — exact source tool
 *   job_id          — exact upstream job id
 *   status          — one of ASSET_STATUSES
 *   include_deleted — when false (default) soft-deleted rows are hidden
 *
 * @param {Record<string, any>} query
 * @returns {{whereSql: string, params: any[]}}
 */
function buildAssetWhere(query) {
  const where = [];
  const params = [];

  const q = query.q ? String(query.q).trim() : '';
  if (q) {
    where.push('(a.title LIKE ? OR a.description LIKE ? OR a.original_name LIKE ?)');
    const like = `%${q}%`;
    params.push(like, like, like);
  }

  if (query.asset_type) {
    where.push('a.asset_type = ?');
    params.push(String(query.asset_type));
  }

  if (query.category_id) {
    where.push('a.category_id = ?');
    params.push(String(query.category_id));
  }

  if (query.uploader_id) {
    where.push('a.uploaded_by = ?');
    params.push(String(query.uploader_id));
  }

  if (query.source_tool) {
    where.push('a.source_tool = ?');
    params.push(String(query.source_tool));
  }

  if (query.job_id) {
    where.push('a.job_id = ?');
    params.push(String(query.job_id));
  }

  const tagNames = String(query.tag_names || '')
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);
  for (const tagName of tagNames) {
    where.push(
      'EXISTS (SELECT 1 FROM asset_tags at JOIN tags t ON t.id = at.tag_id WHERE at.asset_id = a.id AND t.name = ?)',
    );
    params.push(tagName);
  }

  if (query.status) {
    const status = String(query.status);
    if (!ASSET_STATUSES.includes(status)) {
      throw Object.assign(new Error(`Unsupported status: ${status}`), { status: 400 });
    }
    where.push('a.status = ?');
    params.push(status);
  } else if (!parseBoolean(query.include_deleted)) {
    where.push("a.status != 'deleted'");
  }

  return { whereSql: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
}

/**
 * List assets with the canonical pagination envelope.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {Record<string, any>} query
 * @returns {{items: any[], total: number, page: number, page_size: number}}
 */
function listAssets(db, query) {
  const page = parsePositiveInt(query.page, 1, 100000);
  const pageSize = parsePositiveInt(query.page_size, 20, MAX_PAGE_SIZE);
  const { whereSql, params } = buildAssetWhere(query);
  const total = db
    .prepare(`SELECT COUNT(*) AS c FROM assets a ${whereSql}`)
    .get(...params).c;
  const orderSql = ORDER_BY[String(query.order_by || '')] || ORDER_BY.created_at_desc;
  const offset = (page - 1) * pageSize;
  const items = db
    .prepare(
      `SELECT ${ASSET_COLUMNS} FROM assets a ${whereSql} ORDER BY ${orderSql} LIMIT ? OFFSET ?`,
    )
    .all(...params, pageSize, offset);
  return { items, total, page, page_size: pageSize };
}

/**
 * Read a single asset row (with the tag alias) or null.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} id
 * @returns {any|null}
 */
function findAssetById(db, id) {
  return (
    db.prepare(`SELECT ${ASSET_COLUMNS} FROM assets a WHERE a.id = ?`).get(String(id)) || null
  );
}

/**
 * Attach a comma separated list of tag names to an asset, creating the tags
 * that do not exist yet.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} assetId
 * @param {string|null|undefined} tagNames
 * @returns {string[]} the tag ids that are now linked
 */
function attachTags(db, assetId, tagNames) {
  const names = String(tagNames || '')
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);
  if (!names.length) return [];

  const findTag = db.prepare('SELECT id FROM tags WHERE name = ?');
  const insertTag = db.prepare('INSERT INTO tags (id, name, slug) VALUES (?, ?, ?)');
  const link = db.prepare('INSERT OR IGNORE INTO asset_tags (asset_id, tag_id) VALUES (?, ?)');
  const bump = db.prepare('UPDATE tags SET usage_count = usage_count + 1 WHERE id = ?');

  const linked = [];
  for (const name of names) {
    let row = findTag.get(name);
    if (!row) {
      const id = nanoid();
      try {
        insertTag.run(id, name, slugify(name));
        row = { id };
      } catch (e) {
        // A concurrent insert won the race (UNIQUE name) — re-read it.
        row = findTag.get(name);
      }
    }
    if (!row) continue;
    const result = link.run(assetId, row.id);
    if (result.changes > 0) bump.run(row.id);
    linked.push(row.id);
  }
  return linked;
}

/**
 * Remove every tag link of an asset and keep `usage_count` in sync.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} assetId
 */
function detachAllTags(db, assetId) {
  const rows = db.prepare('SELECT tag_id FROM asset_tags WHERE asset_id = ?').all(assetId);
  for (const row of rows) {
    db.prepare('UPDATE tags SET usage_count = MAX(usage_count - 1, 0) WHERE id = ?').run(row.tag_id);
  }
  db.prepare('DELETE FROM asset_tags WHERE asset_id = ?').run(assetId);
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
 * @param {import('better-sqlite3').Database} db
 * @param {string} event
 * @param {Record<string, any>} assetRow
 */
function emitAssetEvent(db, event, assetRow) {
  const asset = toAsset(assetRow) || assetRow;
  let endpoints;
  try {
    endpoints = db
      .prepare('SELECT id, url, secret, events FROM webhook_endpoints WHERE is_active = 1')
      .all();
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
 * @param {import('better-sqlite3').Database} params.db
 * @param {string} params.storageDir
 * @param {{buffer: Buffer, originalname: string, mimetype: string, size: number}} params.file
 * @param {string|null} params.ownerId
 * @param {string} params.source
 * @param {Object} [params.extra]
 * @returns {Promise<{duplicate: boolean, asset: any}>}
 */
async function processUpload({ db, storageDir, file, ownerId, source, extra }) {
  const hash = crypto.createHash('sha256').update(file.buffer).digest('hex');
  const existing = db.prepare('SELECT id, status FROM assets WHERE file_hash = ?').get(hash);
  if (existing) {
    // A file that only lives in the trash is brought back instead of being
    // reported as a duplicate: re-uploading something the user can see in
    // the trash should put it back in the library, not silently do nothing.
    if (existing.status === 'deleted') {
      const restored = restoreAsset(db, findAssetById(db, existing.id));
      return { duplicate: false, asset: restored, restored: true };
    }
    return {
      duplicate: true,
      asset: findAssetById(db, existing.id),
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

  db.prepare(
    `INSERT INTO assets (id, title, description, filename, original_name, mime_type, file_size, file_hash, asset_type,
       category_id, width, height, duration, storage_path, thumbnail_path, uploaded_by, source, status,
       source_tool, prompt, seed, model_name, job_id, metadata_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
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

  if (tag_names) attachTags(db, id, tag_names);

  try {
    require('./manifest').markAssetForManifestWrite(db, id, 'create');
    setImmediate(() => {
      require('./manifest')
        .writeManifestIndex(db, storageDir)
        .catch((e) => console.warn('[manifest] write failed', e.message));
    });
  } catch (e) {
    console.warn('[manifest] mark failed', e.message);
  }

  const asset = findAssetById(db, id);
  emitAssetEvent(db, 'asset.created', asset);
  return { duplicate: false, asset };
}

/**
 * Move an asset to the trash. The row and its files stay on disk so the
 * asset can be restored.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {any} asset
 * @returns {any} the updated asset row
 */
function softDeleteAsset(db, asset) {
  db.prepare(
    "UPDATE assets SET status = 'deleted', deleted_at = datetime('now'), updated_at = datetime('now') WHERE id = ?",
  ).run(asset.id);
  const updated = findAssetById(db, asset.id);
  emitAssetEvent(db, 'asset.deleted', updated);
  return updated;
}

/**
 * Bring a soft-deleted asset back.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {any} asset
 * @returns {any} the updated asset row
 */
function restoreAsset(db, asset) {
  db.prepare(
    "UPDATE assets SET status = 'ready', deleted_at = NULL, updated_at = datetime('now') WHERE id = ?",
  ).run(asset.id);
  const updated = findAssetById(db, asset.id);
  emitAssetEvent(db, 'asset.restored', updated);
  return updated;
}

/**
 * Erase an asset for good: files first, then the row and its tag links.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} storageDir
 * @param {any} asset
 */
function permanentlyDeleteAsset(db, storageDir, asset) {
  try {
    fs.unlinkSync(path.join(storageDir, asset.storage_path));
    if (asset.thumbnail_path) fs.unlinkSync(path.join(storageDir, asset.thumbnail_path));
  } catch (e) {
    console.warn('[delete] file removal failed:', e.message);
  }
  detachAllTags(db, asset.id);
  db.prepare('DELETE FROM assets WHERE id = ?').run(asset.id);
  // Send the event with the snapshot we read BEFORE the delete — downstream
  // consumers may want the metadata of what was removed.
  emitAssetEvent(db, 'asset.deleted', asset);
}

module.exports = {
  ASSET_COLUMNS,
  ASSET_STATUSES,
  MAX_PAGE_SIZE,
  detectAssetType,
  buildAssetWhere,
  listAssets,
  findAssetById,
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
