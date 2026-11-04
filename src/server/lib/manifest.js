'use strict';
const fs = require('fs');
const path = require('path');
const { nanoid } = require('nanoid');

function getManifestPath(storageDir) {
  return path.join(storageDir, 'manifests', 'index.json');
}

function deriveOriginalPath(asset) {
  if (asset.original_name && asset.id) {
    return `originals/${asset.id}${path.extname(asset.original_name) || ''}`;
  }
  return null;
}

function safeParse(s) {
  try { return JSON.parse(s); } catch { return null; }
}

async function writeManifestIndex(db, storageDir) {
  fs.mkdirSync(path.join(storageDir, 'manifests'), { recursive: true });
  // The manifest is the storage directory's own index, not a tenant's API:
  // it covers the whole library and records each row's `tenant_id`, so a
  // consumer can filter by tenant without the file being per-tenant.
  const assets = await db.prepare(`
    SELECT tenant_id, id, title, asset_type, file_size, original_name, mime_type,
           width, height, duration, source_tool, prompt, seed,
           model_name, job_id, metadata_json, created_at, updated_at, status
    FROM assets
    WHERE status != 'deleted' AND tenant_id IS NOT NULL
    ORDER BY created_at DESC
  `).all();

  const payload = {
    version: 1,
    updated_at: new Date().toISOString(),
    count: assets.length,
    assets: assets.map((a) => ({
      id: a.id,
      tenant_id: a.tenant_id,
      title: a.title,
      asset_type: a.asset_type,
      file_size: a.file_size,
      original_name: a.original_name,
      mime_type: a.mime_type,
      width: a.width,
      height: a.height,
      duration: a.duration,
      source_tool: a.source_tool,
      prompt: a.prompt,
      seed: a.seed,
      model_name: a.model_name,
      job_id: a.job_id,
      metadata: a.metadata_json ? safeParse(a.metadata_json) : null,
      status: a.status,
      original_path: deriveOriginalPath(a),
      thumbnail_path: a.thumbnail_path || null,
      created_at: a.created_at,
      updated_at: a.updated_at,
    })),
  };
  const file = getManifestPath(storageDir);
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2));
  fs.renameSync(tmp, file);
  return { count: assets.length };
}

/**
 * Record that an asset needs the manifest index rewritten.
 *
 * @param {object} db
 * @param {string|null|undefined} assetId
 * @param {string} op
 * @param {string} [tenantId] the tenant the asset belongs to
 * @returns {Promise<void>}
 */
async function markAssetForManifestWrite(db, assetId, op, tenantId) {
  await db
    .prepare(
      'INSERT INTO manifest_writes (id, tenant_id, asset_id, op, status) VALUES (?, ?, ?, ?, ?)',
    )
    .run(nanoid(), tenantId || 'default', assetId || null, op, 'pending');
}

/**
 * Replay the manifest writes that are still pending.
 *
 * @param {object} db
 * @param {string} storageDir
 * @returns {Promise<number>} how many writes were replayed
 */
async function replayPendingManifestWrites(db, storageDir) {
  // The index covers every tenant, so every live tenant's pending writes are
  // replayed. The rows themselves are tenant-owned — `tenant_id` is selected
  // and never null, which is what keeps the bookkeeping honest.
  const pending = await db
    .prepare(
      "SELECT id, tenant_id FROM manifest_writes WHERE tenant_id IS NOT NULL AND status = 'pending' ORDER BY created_at ASC LIMIT 1000",
    )
    .all();
  if (!pending.length) return 0;
  let n = 0;
  for (const row of pending) {
    try {
      await writeManifestIndex(db, storageDir);
      await db
        .prepare(
          "UPDATE manifest_writes SET status='done', attempts=attempts+1 WHERE tenant_id = ? AND id = ?",
        )
        .run(row.tenant_id, row.id);
      n++;
    } catch (e) {
      await db
        .prepare(
          "UPDATE manifest_writes SET status='failed', attempts=attempts+1, last_error=? WHERE tenant_id = ? AND id = ?",
        )
        .run(String(e.message || e), row.tenant_id, row.id);
    }
  }
  return n;
}

module.exports = {
  getManifestPath,
  writeManifestIndex,
  markAssetForManifestWrite,
  replayPendingManifestWrites,
};
