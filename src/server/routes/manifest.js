'use strict';

/**
 * The manifest index.
 *
 * The manifest is the library's own listing — the JSON index an external
 * tool reads to learn what the DAM holds. It used to be a static file under
 * the storage root (`storage/manifests/index.json`), served by the static
 * mount, which meant anybody who could name the file could read a listing
 * of every tenant's assets: their titles, their prompts, their seeds, their
 * file names.
 *
 * It is served here instead, to an authenticated caller, and it carries the
 * caller's own tenant only. The file on disk is still written on boot — it
 * is the index the storage layer maintains, and the local tools read it —
 * but the HTTP surface that exposes it is this route.
 *
 * Contract:
 *   GET /manifest -> {version, updated_at, count, assets[]}
 */

const express = require('express');
const { authRequired } = require('../lib/auth');
const { isAllTenants } = require('../lib/tenant');
const { safeParse } = require('../lib/util');
const { asyncHandler } = require('../lib/http');

/**
 * @param {{db: object}} deps
 * @returns {import('express').Router}
 */
function createManifestRouter({ db }) {
  const router = express.Router();

  router.get('/manifest', authRequired(db), asyncHandler(async (req, res) => {
    const scope = req.tenantScope;
    // The listing is the caller's tenant's. A platform administrator's scope
    // covers every tenant — unless they named one in `X-Tenant`, which
    // narrows the scope to it. The question is therefore "how far does this
    // scope reach", not "who is the caller".
    const rows = isAllTenants(scope)
      ? await db
          .prepare(
            `SELECT id, tenant_id, title, asset_type, file_size, original_name, mime_type,
                    width, height, duration, source_tool, prompt, seed, model_name,
                    job_id, metadata_json, storage_path, thumbnail_path, created_at,
                    updated_at, status
               FROM assets
              WHERE status != 'deleted' AND tenant_id IS NOT NULL
              ORDER BY created_at DESC`,
          )
          .all()
      : await db
          .prepare(
            `SELECT id, tenant_id, title, asset_type, file_size, original_name, mime_type,
                    width, height, duration, source_tool, prompt, seed, model_name,
                    job_id, metadata_json, storage_path, thumbnail_path, created_at,
                    updated_at, status
               FROM assets
              WHERE status != 'deleted' AND tenant_id = ?
              ORDER BY created_at DESC`,
          )
          .all(scope.tenantId);
    return res.json({
      version: 1,
      updated_at: new Date().toISOString(),
      count: rows.length,
      assets: rows.map((row) => ({
        id: row.id,
        tenant_id: row.tenant_id,
        title: row.title,
        asset_type: row.asset_type,
        file_size: row.file_size,
        original_name: row.original_name,
        mime_type: row.mime_type,
        width: row.width,
        height: row.height,
        duration: row.duration,
        source_tool: row.source_tool,
        prompt: row.prompt,
        seed: row.seed,
        model_name: row.model_name,
        job_id: row.job_id,
        metadata: row.metadata_json ? safeParse(row.metadata_json) : null,
        status: row.status,
        original_path: row.storage_path,
        thumbnail_path: row.thumbnail_path || null,
        created_at: row.created_at,
        updated_at: row.updated_at,
      })),
    });
  }));

  return router;
}

module.exports = createManifestRouter;
