'use strict';

/**
 * Job routes.
 *
 * The product tracks upstream generation jobs through the `assets.job_id`
 * column — there is no separate jobs table. This route exposes that
 * relationship directly.
 *
 * Contract (mirrored by `frontend/src/api/assets.ts`):
 *   GET /jobs/by-comfyui/:job_id -> Asset  (404 when the job has no asset yet)
 */

const express = require('express');
const { authRequired } = require('../lib/auth');
const { toAsset } = require('../lib/dto');
const { findAssetById } = require('../lib/assets');
const { isAllTenants } = require('../lib/tenant');
const { asyncHandler } = require('../lib/http');

/**
 * @param {{db: object}} deps
 * @returns {import('express').Router}
 */
function createJobsRouter({ db }) {
  const router = express.Router();

  router.get('/jobs/by-comfyui/:job_id', authRequired(db), asyncHandler(async (req, res) => {
    const jobId = String(req.params.job_id || '').trim();
    if (!jobId) return res.status(400).json({ detail: 'job_id required' });
    const scope = req.tenantScope;
    // The job id is looked up inside the caller's tenant. A platform
    // administrator's scope covers every tenant, so their lookup names no
    // tenant at all.
    // tenant-lint: allow a superadmin reads across every tenant
    const row = isAllTenants(scope)
      ? await db
          .prepare(
            "SELECT id FROM assets WHERE job_id = ? AND status != 'deleted' ORDER BY created_at DESC",
          )
          .get(jobId)
      : await db
          .prepare(
            "SELECT id FROM assets WHERE tenant_id = ? AND job_id = ? AND status != 'deleted' ORDER BY created_at DESC",
          )
          .get(scope.tenantId, jobId);
    if (!row) return res.status(404).json({ detail: 'Not found' });
    return res.json(toAsset(await findAssetById(db, scope, row.id)));
  }));

  return router;
}

module.exports = createJobsRouter;
