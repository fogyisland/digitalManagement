'use strict';

/**
 * The ingest API — the way an external system pushes data in.
 *
 * It lives in its own namespace (`/api/ingest/v1`) and authenticates with an
 * API key, not a user token: the caller is a generator, a render farm or a
 * script, and the key *is* the tenant it writes into. That is the whole
 * design — there is no tenant field in any request body.
 *
 * Ingest is not a second implementation of uploading. It calls
 * `processUpload`, the same function the admin upload uses, so de-duplication,
 * thumbnails, the manifest and the webhook fan-out behave identically no
 * matter which door a file came through.
 *
 * The router is mounted at `/api/ingest/v1`, so the paths below are relative
 * to that prefix. Contract:
 *   POST /assets              (scope upload) multipart `files`, or JSON `{url}`
 *   POST /comfyui/:job_id     (scope upload) multipart `files` — the ComfyUI door
 *   POST /assets/:id/metadata (scope write)  {title?, description?, tags?, category_id?, status?}
 *   POST /events              (scope write)  {event, payload?}
 */

const express = require('express');
const { getConfig } = require('../config');
const { apiKeyRequired } = require('../lib/auth');
const { toAsset } = require('../lib/dto');
const { findAssetById, processUpload, attachTags } = require('../lib/assets');
const { fetchRemoteFile } = require('../lib/net');
const { safeParse } = require('../lib/util');
const { asyncHandler } = require('../lib/http');
const { nanoid } = require('nanoid');

/** The statuses an ingest caller may set. */
const INGEST_STATUSES = ['ready', 'processing', 'failed'];

/**
 * Build the `extra` payload `processUpload` takes from a multipart body.
 *
 * @param {Record<string, unknown>} body
 * @returns {Record<string, unknown>}
 */
function uploadExtras(body) {
  const rawSeed = body.seed;
  const rawMetadata = body.metadata || body.metadata_json;
  return {
    source_tool: body.source_tool || null,
    prompt: body.prompt || null,
    seed:
      rawSeed !== undefined && rawSeed !== null && rawSeed !== ''
        ? parseInt(String(rawSeed), 10)
        : null,
    model_name: body.model_name || null,
    job_id: body.job_id || null,
    metadata: rawMetadata ? safeParse(String(rawMetadata)) : null,
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
function createIngestRouter({ db, uploader }) {
  const router = express.Router();

  // --- assets ---------------------------------------------------------------
  router.post(
    '/assets',
    apiKeyRequired(db, 'upload'),
    // The file limit is the same one the admin upload uses: an API key must
    // not be a way around the configured maximum.
    uploader.array('files', 20),
    asyncHandler(async (req, res) => {
      const tenantId = req.tenantScope.tenantId;
      const body = req.body || {};

      // A JSON body with a `url` is the "pull it for me" form; multipart with
      // files is the "here it is" form. Both land through `processUpload`.
      if ((!req.files || req.files.length === 0) && body.url) {
        let downloaded;
        try {
          downloaded = await fetchRemoteFile(String(body.url), getConfig().maxFileSize);
        } catch (error) {
          const status = error && error.status ? error.status : 502;
          return res.status(status).json({ detail: error.message });
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
          ownerId: null,
          source: 'ingest',
          tenantId,
          extra: uploadExtras(body),
        });
        return res
          .status(result.duplicate ? 200 : 201)
          .json({ items: [toAsset(result.asset)], count: 1 });
      }

      if (!req.files || req.files.length === 0) {
        return res.status(400).json({ detail: 'files or url required' });
      }

      const extras = uploadExtras(body);
      const items = [];
      let anyCreated = false;
      for (let index = 0; index < req.files.length; index += 1) {
        const file = req.files[index];
        const perFile = { ...extras };
        // A shared title across a batch would produce indistinguishable rows.
        if (extras.title && req.files.length > 1) {
          perFile.title = `${extras.title} (${index + 1})`;
        }
        const result = await processUpload({
          db,
          storageDir: getConfig().storageDir,
          file,
          ownerId: null,
          source: 'ingest',
          tenantId,
          extra: perFile,
        });
        if (!result.duplicate) anyCreated = true;
        items.push(toAsset(result.asset));
      }
      return res.status(anyCreated ? 201 : 200).json({ items, count: items.length });
    }),
  );

  // --- metadata -------------------------------------------------------------
  router.post(
    '/assets/:id/metadata',
    apiKeyRequired(db, 'write'),
    asyncHandler(async (req, res) => {
      const asset = await findAssetById(db, req.tenantScope, req.params.id);
      if (!asset) return res.status(404).json({ detail: 'Not found' });

      const body = req.body || {};
      const { title, description, tags, tag_names, category_id, status } = body;

      if (status !== undefined && status !== null && !INGEST_STATUSES.includes(String(status))) {
        return res.status(400).json({ detail: `Unsupported status: ${status}` });
      }

      await db
        .prepare(
          `UPDATE assets SET title = COALESCE(?, title), description = COALESCE(?, description),
             category_id = COALESCE(?, category_id), status = COALESCE(?, status), updated_at = NOW()
           WHERE id = ? AND tenant_id = ?`,
        )
        .run(
          title === undefined || title === null ? null : String(title),
          description === undefined || description === null ? null : String(description),
          category_id === undefined || category_id === null ? null : String(category_id),
          status === undefined || status === null ? null : String(status),
          asset.id,
          req.tenantScope.tenantId,
        );

      const names = tags !== undefined ? tags : tag_names;
      if (names !== undefined && names !== null) {
        const csv = Array.isArray(names) ? names.join(',') : String(names);
        await attachTags(db, req.tenantScope.tenantId, asset.id, csv);
      }

      const updated = await findAssetById(db, req.tenantScope, asset.id);
      // An ingest that changed metadata is exactly what `asset.metadata_updated`
      // exists for; the admin path emits `asset.updated`.
      await require('../lib/assets').emitAssetEvent(db, 'asset.metadata_updated', updated);
      return res.json(toAsset(updated));
    }),
  );

  // --- comfyui --------------------------------------------------------------
  router.post(
    '/comfyui/:job_id',
    apiKeyRequired(db, 'upload'),
    // The same file limit as every other door: an API key must not be a way
    // around the configured maximum.
    uploader.array('files', 20),
    asyncHandler(async (req, res) => {
      const jobId = String(req.params.job_id || '').trim();
      if (!jobId) return res.status(400).json({ detail: 'job_id required' });

      const body = req.body || {};
      if (!req.files || req.files.length === 0) {
        return res.status(400).json({ detail: 'files required' });
      }

      // The job id in the path is the correlation — it wins over whatever the
      // body claims, so a caller cannot file one artifact under another's job.
      const extras = uploadExtras({ ...body, job_id: jobId, source_tool: 'comfyui' });
      if (!extras.title) extras.title = jobId;

      const items = [];
      let anyCreated = false;
      for (let index = 0; index < req.files.length; index += 1) {
        const perFile = { ...extras };
        if (req.files.length > 1) {
          perFile.title = `${extras.title} (${index + 1})`;
        }
        const result = await processUpload({
          db,
          storageDir: getConfig().storageDir,
          file: req.files[index],
          ownerId: null,
          source: 'ingest',
          tenantId: req.tenantScope.tenantId,
          extra: perFile,
        });
        if (!result.duplicate) anyCreated = true;
        items.push(toAsset(result.asset));
      }
      return res.status(anyCreated ? 201 : 200).json({ items, count: items.length });
    }),
  );

  // --- events ---------------------------------------------------------------
  router.post(
    '/events',
    apiKeyRequired(db, 'write'),
    asyncHandler(async (req, res) => {
      const body = req.body || {};
      const event = String(body.event || '').trim();
      if (!event) return res.status(400).json({ detail: 'event required' });
      if (!/^[a-z][a-z0-9_.]{2,80}$/.test(event)) {
        return res.status(400).json({ detail: 'event must be a dotted lower-case name' });
      }

      const payload = body.payload === undefined ? null : body.payload;
      const id = nanoid();
      // The audit trail is the record: who pushed what, under which key.
      await db
        .prepare(
          'INSERT INTO audit_logs (id, tenant_id, user_id, action, resource_type, resource_id, details, ip_address) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          id,
          req.tenantScope.tenantId,
          null,
          event,
          'ingest',
          body.resource_id ? String(body.resource_id) : null,
          payload === null ? null : JSON.stringify(payload),
          String(req.ip || ''),
        );

      // An event the vocabulary knows is also delivered to the tenant's
      // webhooks, so a receiver does not have to poll the audit log.
      const { WEBHOOK_EVENTS, dispatch } = require('../lib/webhook');
      let delivered = 0;
      if (WEBHOOK_EVENTS.includes(event)) {
        const endpoints = await db
          .prepare(
            'SELECT id, url, secret, events, tenant_id FROM webhook_endpoints WHERE tenant_id = ? AND is_active = 1',
          )
          .all(req.tenantScope.tenantId);
        for (const endpoint of endpoints) {
          delivered += 1;
          dispatch(db, endpoint, event, payload === null ? {} : payload).catch((error) => {
            console.warn('[ingest] webhook dispatch failed', {
              endpointId: endpoint.id,
              err: error.message,
            });
          });
        }
      }

      return res.status(202).json({ ok: true, id, event, webhooks: delivered });
    }),
  );

  return router;
}

module.exports = createIngestRouter;
