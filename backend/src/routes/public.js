'use strict';

/**
 * Public delivery routes — authenticated with an API key, not a user token.
 *
 * These endpoints are what an upstream generator (or any external system)
 * calls to push assets into the library or to read the catalogue back.
 *
 * Contract:
 *   GET  /delivery/assets  (x-api-key, scope "read")  -> PageResponse<Asset>
 *   POST /delivery/upload  (x-api-key, scope "upload") -> {items: Asset[], count}
 *
 * The router is mounted at `/api/public/v1`, so the paths above are relative
 * to that prefix.
 */

const express = require('express');
const { getConfig } = require('../config');
const { apiKeyRequired } = require('../lib/auth');
const { toAsset } = require('../lib/dto');
const { listAssets, processUpload } = require('../lib/assets');
const { safeParse } = require('../lib/util');

/**
 * @param {{db: import('better-sqlite3').Database, uploader: import('multer').Multer}} deps
 * @returns {import('express').Router}
 */
function createPublicRouter({ db, uploader }) {
  const router = express.Router();

  router.get('/delivery/assets', apiKeyRequired(db, 'read'), (req, res) => {
    try {
      const { items, total, page, page_size: pageSize } = listAssets(db, req.query);
      return res.json({
        items: items.map(toAsset),
        total,
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
  });

  router.post('/delivery/upload', apiKeyRequired(db, 'upload'), uploader.array('files', 20), async (req, res) => {
    if (!req.files || !req.files.length) {
      return res.status(400).json({ detail: 'No files' });
    }
    const body = req.body || {};
    const extra = {
      source_tool: body.source_tool || null,
      prompt: body.prompt || null,
      seed: body.seed !== undefined && body.seed !== null && body.seed !== '' ? parseInt(body.seed, 10) : null,
      model_name: body.model_name || null,
      job_id: body.job_id || null,
      metadata: body.metadata ? safeParse(body.metadata) : null,
      title: body.title || null,
      description: body.description || null,
      category_id: body.category_id || null,
      tag_names: body.tag_names || null,
    };
    const results = [];
    for (const file of req.files) {
      const result = await processUpload({
        db,
        storageDir: getConfig().storageDir,
        file,
        ownerId: null,
        source: 'public',
        extra,
      });
      results.push(result.asset);
    }
    return res.status(201).json({ items: results.map(toAsset), count: results.length });
  });

  return router;
}

module.exports = createPublicRouter;
