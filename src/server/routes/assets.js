'use strict';

/**
 * Asset routes.
 *
 * Contract (mirrored by `frontend/src/api/assets.ts`):
 *   GET    /assets                    ?q=&asset_type=&category_id=&tag_names=
 *                                     &uploader_id=&source_tool=&job_id=&status=
 *                                     &include_deleted=&order_by=&page=&page_size=
 *                                     -> PageResponse<Asset>
 *   GET    /assets/:id                -> Asset
 *   GET    /assets/:id/manifest       -> AssetManifest
 *   POST   /assets/upload             multipart "files" -> {items: Asset[], count}
 *   PUT    /assets/:id                -> Asset
 *   DELETE /assets/:id                -> 204   (soft delete; ?permanent=true erases)
 *   POST   /assets/:id/restore        -> Asset
 *   POST   /assets/:id/download       -> {download_url, filename, size, mime_type}
 *   POST   /assets/import-url         {url, title?, source_tool?, ...} -> Asset
 *   POST   /assets/from-comfyui/:job_id {url?, title?, ...} -> Asset
 *
 * Deletion is destructive in two different ways and the API makes that
 * explicit: the default is a soft delete (the row and its files stay, the
 * asset can be restored), `?permanent=true` erases the row and the files.
 *
 * Route order matters: the concrete paths (`/assets/upload`,
 * `/assets/from-comfyui/:job_id`) are registered BEFORE the `:id` variants
 * so a literal segment is never swallowed by the parameterised one.
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { nanoid } = require('nanoid');
const { getConfig } = require('../config');
const { authRequired } = require('../lib/auth');
const { resolveWriteTenant } = require('../lib/tenant');
const { toAsset, storageUrl } = require('../lib/dto');
const {
  listAssets,
  findAssetById,
  attachTags,
  softDeleteAsset,
  restoreAsset,
  permanentlyDeleteAsset,
  processUpload,
  emitAssetEvent,
} = require('../lib/assets');
const { fetchRemoteFile } = require('../lib/net');
const { safeParse, parseBoolean } = require('../lib/util');
const { asyncHandler } = require('../lib/http');

/**
 * Build the `extra` payload passed to `processUpload` from a request body.
 *
 * @param {Record<string, any>} body
 * @returns {Record<string, any>}
 */
function uploadExtras(body) {
  const rawSeed = body.seed;
  // The metadata payload is accepted under either name: `metadata` is the
  // canonical multipart field, `metadata_json` is the name the DTO uses on
  // the wire. Both carry a JSON string.
  const rawMetadata = body.metadata || body.metadata_json;
  return {
    source_tool: body.source_tool || null,
    prompt: body.prompt || null,
    seed:
      rawSeed !== undefined && rawSeed !== null && rawSeed !== '' ? parseInt(rawSeed, 10) : null,
    model_name: body.model_name || null,
    job_id: body.job_id || null,
    metadata: rawMetadata ? safeParse(rawMetadata) : null,
    title: body.title || null,
    description: body.description || null,
    category_id: body.category_id || null,
    tag_names: body.tag_names || null,
  };
}

/**
 * @param {{db: object, uploader: import('multer').Multer}} deps
 * @returns {import('express').Router}
 */
function createAssetsRouter({ db, uploader }) {
  const router = express.Router();

  // --- Concrete paths first -------------------------------------------------

  router.post(
    '/assets/upload',
    authRequired(db),
    uploader.array('files', 20),
    asyncHandler(async (req, res) => {
      if (!req.files || !req.files.length) {
        return res.status(400).json({ detail: 'No files' });
      }
      const extras = uploadExtras(req.body || {});
      const storageDir = getConfig().storageDir;
      // A write lands in one concrete tenant — see `resolveWriteTenant`.
      const tenantId = await resolveWriteTenant(db, req.tenantScope, req);
      const results = [];
      for (let index = 0; index < req.files.length; index += 1) {
        const file = req.files[index];
        const perFile = { ...extras };
        // A shared title across a batch would produce indistinguishable rows,
        // so each file gets its own numbered variant.
        if (extras.title && req.files.length > 1) {
          perFile.title = `${extras.title} (${index + 1})`;
        }
        const result = await processUpload({
          db,
          storageDir,
          file,
          ownerId: req.user.id,
          source: 'admin',
          extra: perFile,
          tenantId,
        });
        results.push(result.asset);
      }
      return res.status(201).json({ items: results.map(toAsset), count: results.length });
    }),
  );

  router.post('/assets/import-url', authRequired(db), asyncHandler(async (req, res) => {
    const body = req.body || {};
    if (!body.url) return res.status(400).json({ detail: 'url required' });
    let downloaded;
    try {
      downloaded = await fetchRemoteFile(body.url, getConfig().maxFileSize);
    } catch (e) {
      const status = e && e.status ? e.status : 502;
      return res.status(status).json({ detail: e.message });
    }
    const result = await processUpload({
      db,
      storageDir: getConfig().storageDir,
      file: {
        buffer: downloaded.buffer,
        originalname: downloaded.originalname,
        mimetype: downloaded.mimetype,
        size: downloaded.buffer.length,
      },
      ownerId: req.user.id,
      source: 'import-url',
      extra: {
        ...uploadExtras(body),
        source_tool: body.source_tool || 'import-url',
      },
      tenantId: await resolveWriteTenant(db, req.tenantScope, req),
    });
    return res.status(201).json(toAsset(result.asset));
  }));

  router.post('/assets/from-comfyui/:job_id', authRequired(db), asyncHandler(async (req, res) => {
    const jobId = String(req.params.job_id || '').trim();
    if (!jobId) return res.status(400).json({ detail: 'job_id required' });
    const body = req.body || {};
    // A write lands in one concrete tenant — see `resolveWriteTenant`.
    const tenantId = await resolveWriteTenant(db, req.tenantScope, req);

    const existing = await db
      .prepare(
        "SELECT id FROM assets WHERE tenant_id = ? AND job_id = ? AND status != 'deleted' ORDER BY created_at DESC",
      )
      .get(tenantId, jobId);
    if (existing) {
      return res.json(toAsset(await findAssetById(db, req.tenantScope, existing.id)));
    }

    // With a `url` the real output is downloaded now; without one the asset
    // is registered as a placeholder that waits for the ComfyUI output.
    if (body.url) {
      let downloaded;
      try {
        downloaded = await fetchRemoteFile(body.url, getConfig().maxFileSize);
      } catch (e) {
        const status = e && e.status ? e.status : 502;
        return res.status(status).json({ detail: e.message });
      }
      const result = await processUpload({
        db,
        storageDir: getConfig().storageDir,
        file: {
          buffer: downloaded.buffer,
          originalname: downloaded.originalname,
          mimetype: downloaded.mimetype,
          size: downloaded.buffer.length,
        },
        ownerId: req.user.id,
        source: 'comfyui',
        extra: { ...uploadExtras(body), job_id: jobId, source_tool: body.source_tool || 'comfyui' },
        tenantId,
      });
      return res.status(201).json(toAsset(result.asset));
    }

    const asset = await createPlaceholderAsset(db, {
      tenantId,
      jobId,
      ownerId: req.user.id,
      title: body.title || null,
      prompt: body.prompt || null,
      seed: body.seed,
      model_name: body.model_name || null,
      metadata: body.metadata ? safeParse(body.metadata) : null,
    });
    return res.status(201).json(toAsset(asset));
  }));

  // --- Parameterised paths ---------------------------------------------------

  router.get('/assets', authRequired(db), asyncHandler(async (req, res) => {
    try {
      const { items, total, page, page_size: pageSize } = await listAssets(
        db,
        req.tenantScope,
        req.query,
      );
      return res.json({
        items: items.map(toAsset),
        total: Number(total),
        page,
        page_size: pageSize,
        total_pages: Math.ceil(total / (pageSize > 0 ? pageSize : 1)),
      });
    } catch (e) {
      if (e && e.status === 400) {
        return res.status(400).json({ detail: e.message });
      }
      throw e;
    }
  }));

  router.get('/assets/:id', authRequired(db), asyncHandler(async (req, res) => {
    const asset = await findAssetById(db, req.tenantScope, req.params.id);
    if (!asset) return res.status(404).json({ detail: 'Not found' });
    return res.json(toAsset(asset));
  }));

  router.get('/assets/:id/manifest', authRequired(db), asyncHandler(async (req, res) => {
    const asset = await findAssetById(db, req.tenantScope, req.params.id);
    if (!asset) {
      return res.status(404).json({ code: 'NOT_FOUND', message: 'Asset not found', request_id: nanoid() });
    }
    const extension = path.extname(asset.original_name || '') || '';
    const baseUrl = getConfig().appBaseUrl;
    // The file is served through the signed URL route, so the link carries
    // the signature that proves the server issued it for this asset.
    const signedUrl = storageUrl(
      path.posix.join('originals', `${asset.id}${extension}`),
      asset.tenant_id,
    );
    return res.json({
      id: asset.id,
      title: asset.title,
      asset_type: asset.asset_type,
      source_tool: asset.source_tool,
      job_id: asset.job_id,
      prompt: asset.prompt,
      seed: asset.seed,
      model_name: asset.model_name,
      metadata: asset.metadata_json ? safeParse(asset.metadata_json) : null,
      original_path: `originals/${asset.id}${extension}`,
      thumbnail_path: asset.thumbnail_path || null,
      public_url: signedUrl ? `${baseUrl}${signedUrl}` : null,
      created_at: asset.created_at,
    });
  }));

  router.put('/assets/:id', authRequired(db), asyncHandler(async (req, res) => {
    const asset = await findAssetById(db, req.tenantScope, req.params.id);
    if (!asset) return res.status(404).json({ detail: 'Not found' });
    const { title, description, category_id, tag_names, status } = req.body || {};
    if (status !== undefined && status !== null && !['ready', 'processing', 'failed'].includes(String(status))) {
      return res.status(400).json({ detail: `Unsupported status: ${status}` });
    }
    // The row was read through the tenant scope above, so its own tenant is
    // the condition — the update can never reach another tenant's asset even
    // if an id were guessed.
    await db
      .prepare(
        `UPDATE assets SET title = COALESCE(?, title), description = ?, category_id = ?, status = COALESCE(?, status),
         updated_at = NOW() WHERE id = ? AND tenant_id = ?`,
      )
      .run(
        title || null,
        description !== undefined ? description : asset.description,
        category_id !== undefined ? category_id : asset.category_id,
        status || null,
        asset.id,
        asset.tenant_id,
      );
    if (tag_names !== undefined && tag_names !== null) {
      await attachTags(db, req.tenantScope.tenantId, asset.id, tag_names);
    }
    const updated = await findAssetById(db, req.tenantScope, asset.id);
    await emitAssetEvent(db, 'asset.updated', updated);
    return res.json(toAsset(updated));
  }));

  router.delete('/assets/:id', authRequired(db), asyncHandler(async (req, res) => {
    const asset = await findAssetById(db, req.tenantScope, req.params.id);
    if (!asset) return res.status(404).json({ detail: 'Not found' });
    if (parseBoolean(req.query.permanent)) {
      await permanentlyDeleteAsset(db, getConfig().storageDir, req.tenantScope, asset);
    } else {
      await softDeleteAsset(db, req.tenantScope, asset);
    }
    return res.status(204).end();
  }));

  router.post('/assets/:id/restore', authRequired(db), asyncHandler(async (req, res) => {
    const asset = await findAssetById(db, req.tenantScope, req.params.id);
    if (!asset) return res.status(404).json({ detail: 'Not found' });
    if (asset.status !== 'deleted') {
      return res.status(400).json({ detail: 'Asset is not in the trash' });
    }
    const restored = await restoreAsset(db, req.tenantScope, asset);
    return res.json(toAsset(restored));
  }));

  router.post('/assets/:id/download', authRequired(db), asyncHandler(async (req, res) => {
    const asset = await findAssetById(db, req.tenantScope, req.params.id);
    if (!asset) return res.status(404).json({ detail: 'Not found' });
    const absolute = path.join(getConfig().storageDir, asset.storage_path);
    if (!fs.existsSync(absolute)) {
      return res.status(410).json({ detail: 'The stored file is no longer available' });
    }
    return res.json({
      download_url: storageUrl(asset.storage_path, asset.tenant_id),
      filename: asset.original_name || asset.filename,
      size: asset.file_size,
      mime_type: asset.mime_type,
    });
  }));

  return router;
}

/**
 * Register a ComfyUI job that has not produced a file yet.
 *
 * The row points at a small JSON descriptor on disk so that the asset has a
 * real file behind it — the storage layout stays consistent and the asset
 * can be rendered without special cases.
 *
 * @param {object} db
 * @param {{jobId: string, ownerId: string, title: string|null, prompt: string|null,
 *          seed: number|null|undefined, model_name: string|null, metadata: unknown|null}} input
 * @returns {Promise<any>} the created asset row
 */
async function createPlaceholderAsset(db, input) {
  const storageDir = getConfig().storageDir;
  const tenantId = input.tenantId || 'default';
  const id = nanoid();
  const relativePath = path.join('placeholders', `${id}.json`);
  const descriptor = {
    placeholder: true,
    job_id: input.jobId,
    title: input.title,
    prompt: input.prompt,
    seed: input.seed ?? null,
    model_name: input.model_name,
    metadata: input.metadata ?? null,
    registered_at: new Date().toISOString(),
  };
  fs.mkdirSync(path.join(storageDir, 'placeholders'), { recursive: true });
  fs.writeFileSync(path.join(storageDir, relativePath), JSON.stringify(descriptor, null, 2));

  const fileHash = crypto.createHash('sha256').update(`comfyui-placeholder:${input.jobId}`).digest('hex');
  await db
    .prepare(
      `INSERT INTO assets (id, tenant_id, title, filename, original_name, mime_type, file_size, file_hash, asset_type,
       storage_path, thumbnail_path, uploaded_by, source, status, source_tool, prompt, seed, model_name, job_id, metadata_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
    id,
    tenantId,
    input.title || `ComfyUI job ${input.jobId}`,
    `${id}.json`,
    input.jobId,
    'application/x-dam-placeholder',
    0,
    fileHash,
    'other',
    relativePath,
    null,
    input.ownerId,
    'comfyui',
    'processing',
    'comfyui',
    input.prompt,
    Number.isFinite(input.seed) ? input.seed : null,
    input.model_name,
    input.jobId,
    input.metadata ? JSON.stringify(input.metadata) : null,
  );
  return await findAssetById(db, { tenantId, isSuperadmin: false }, id);
}

module.exports = createAssetsRouter;
