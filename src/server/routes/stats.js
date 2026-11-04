'use strict';

/**
 * Statistics routes.
 *
 * Contract (mirrored by `frontend/src/api/assets.ts` and
 * `frontend/src/pages/Dashboard.tsx`):
 *   GET /stats           -> {total, images, videos, total_size, recent: Asset[]}
 *   GET /stats/dashboard -> {summary, upload_trend, recent_assets: Asset[]}
 *
 * Soft-deleted assets are excluded from every counter — they live in the
 * trash, not in the library.
 *
 * A platform administrator's scope covers every tenant, so every counter
 * here has two statements: one that names the tenant and one that does not.
 * The two statements are written out rather than assembled at runtime,
 * because the tenant lint reads the SQL as text — a condition built by
 * concatenation would hide itself from the check that exists to prove it.
 */

const express = require('express');
const { authRequired } = require('../lib/auth');
const { toAsset } = require('../lib/dto');
const { ASSET_COLUMNS } = require('../lib/assets');
const { isAllTenants } = require('../lib/tenant');
const { asyncHandler } = require('../lib/http');

/**
 * Count the rows of a query, honouring the caller's scope.
 *
 * `scopedSql` and `allSql` are two complete statements; the scope picks
 * between them. Neither is built from a fragment at runtime.
 *
 * The two statements do not necessarily have the same number of
 * placeholders — the scoped one has one more, for the tenant — so each
 * carries its own parameter list.
 *
 * @param {object} db
 * @param {{tenantId: string}} scope
 * @param {string} scopedSql
 * @param {string} allSql
 * @param {unknown[]} scopedParams the parameters of the scoped statement
 * @param {unknown[]} allParams the parameters of the every-tenant statement
 * @returns {Promise<number>}
 */
async function countFor(db, scope, scopedSql, allSql, scopedParams = [], allParams = []) {
  // tenant-lint: allow a superadmin reads across every tenant
  const row = isAllTenants(scope)
    ? await db.prepare(allSql).get(...allParams)
    : await db.prepare(scopedSql).get(...scopedParams);
  return Number(row.c);
}

/**
 * Sum a column, honouring the caller's scope.
 *
 * @param {object} db
 * @param {{tenantId: string}} scope
 * @param {string} scopedSql
 * @param {string} allSql
 * @param {unknown[]} scopedParams the parameters of the scoped statement
 * @param {unknown[]} allParams the parameters of the every-tenant statement
 * @returns {Promise<number>}
 */
async function sumFor(db, scope, scopedSql, allSql, scopedParams = [], allParams = []) {
  // tenant-lint: allow a superadmin reads across every tenant
  const row = isAllTenants(scope)
    ? await db.prepare(allSql).get(...allParams)
    : await db.prepare(scopedSql).get(...scopedParams);
  return Number(row.s);
}

/**
 * @param {{db: object}} deps
 * @returns {import('express').Router}
 */
function createStatsRouter({ db }) {
  const router = express.Router();

  router.get('/stats', authRequired(db), asyncHandler(async (req, res) => {
    // Every counter is scoped to the caller's tenant: a platform
    // administrator's scope covers every tenant, so their totals cover the
    // whole platform.
    const scope = req.tenantScope;
    const tenantId = scope.tenantId;

    const total = await countFor(
      db,
      scope,
      "SELECT COUNT(*) AS c FROM assets WHERE tenant_id = ? AND status != 'deleted'",
      "SELECT COUNT(*) AS c FROM assets WHERE status != 'deleted'",
      [tenantId],
    );
    const images = await countFor(
      db,
      scope,
      "SELECT COUNT(*) AS c FROM assets WHERE tenant_id = ? AND status != 'deleted' AND asset_type = 'image'",
      "SELECT COUNT(*) AS c FROM assets WHERE status != 'deleted' AND asset_type = 'image'",
      [tenantId],
    );
    const videos = await countFor(
      db,
      scope,
      "SELECT COUNT(*) AS c FROM assets WHERE tenant_id = ? AND status != 'deleted' AND asset_type = 'video'",
      "SELECT COUNT(*) AS c FROM assets WHERE status != 'deleted' AND asset_type = 'video'",
      [tenantId],
    );
    const totalSize = await sumFor(
      db,
      scope,
      "SELECT COALESCE(SUM(file_size), 0) AS s FROM assets WHERE tenant_id = ? AND status != 'deleted'",
      "SELECT COALESCE(SUM(file_size), 0) AS s FROM assets WHERE status != 'deleted'",
      [tenantId],
    );
    // The recent list honours the same scope as the counters: a platform
    // administrator's list spans every tenant.
    let recent;
    if (isAllTenants(scope)) {
      // tenant-lint: allow a superadmin reads across every tenant
      recent = await db
        .prepare(
          `SELECT ${ASSET_COLUMNS} FROM assets a WHERE a.status != 'deleted' ORDER BY a.created_at DESC LIMIT 10`,
        )
        .all();
    } else {
      recent = await db
        .prepare(
          `SELECT ${ASSET_COLUMNS} FROM assets a WHERE a.tenant_id = ? AND a.status != 'deleted' ORDER BY a.created_at DESC LIMIT 10`,
        )
        .all(tenantId);
    }
    return res.json({
      total,
      images,
      videos,
      total_size: totalSize,
      recent: recent.map(toAsset),
    });
  }));

  router.get('/stats/dashboard', authRequired(db), asyncHandler(async (req, res) => {
    const scope = req.tenantScope;
    const tenantId = scope.tenantId;
    const summary = {
      total_assets: await countFor(
        db,
        scope,
        "SELECT COUNT(*) AS c FROM assets WHERE tenant_id = ? AND status != 'deleted'",
        "SELECT COUNT(*) AS c FROM assets WHERE status != 'deleted'",
        [tenantId],
      ),
      image_count: await countFor(
        db,
        scope,
        "SELECT COUNT(*) AS c FROM assets WHERE tenant_id = ? AND status != 'deleted' AND asset_type = 'image'",
        "SELECT COUNT(*) AS c FROM assets WHERE status != 'deleted' AND asset_type = 'image'",
        [tenantId],
      ),
      video_count: await countFor(
        db,
        scope,
        "SELECT COUNT(*) AS c FROM assets WHERE tenant_id = ? AND status != 'deleted' AND asset_type = 'video'",
        "SELECT COUNT(*) AS c FROM assets WHERE status != 'deleted' AND asset_type = 'video'",
        [tenantId],
      ),
      total_size_bytes: await sumFor(
        db,
        scope,
        "SELECT COALESCE(SUM(file_size), 0) AS s FROM assets WHERE tenant_id = ? AND status != 'deleted'",
        "SELECT COALESCE(SUM(file_size), 0) AS s FROM assets WHERE status != 'deleted'",
        [tenantId],
      ),
      storage_used_gb: 0,
      today_uploads: await countFor(
        db,
        scope,
        "SELECT COUNT(*) AS c FROM assets WHERE tenant_id = ? AND status != 'deleted' AND DATE(created_at) = CURDATE()",
        "SELECT COUNT(*) AS c FROM assets WHERE status != 'deleted' AND DATE(created_at) = CURDATE()",
        [tenantId],
      ),
      week_uploads: await countFor(
        db,
        scope,
        "SELECT COUNT(*) AS c FROM assets WHERE tenant_id = ? AND status != 'deleted' AND created_at >= NOW() - INTERVAL 7 DAY",
        "SELECT COUNT(*) AS c FROM assets WHERE status != 'deleted' AND created_at >= NOW() - INTERVAL 7 DAY",
        [tenantId],
      ),
      month_uploads: await countFor(
        db,
        scope,
        "SELECT COUNT(*) AS c FROM assets WHERE tenant_id = ? AND status != 'deleted' AND created_at >= NOW() - INTERVAL 30 DAY",
        "SELECT COUNT(*) AS c FROM assets WHERE status != 'deleted' AND created_at >= NOW() - INTERVAL 30 DAY",
        [tenantId],
      ),
      tag_count: await countFor(
        db,
        scope,
        'SELECT COUNT(*) AS c FROM tags WHERE tenant_id = ?',
        'SELECT COUNT(*) AS c FROM tags',
        [tenantId],
      ),
      category_count: await countFor(
        db,
        scope,
        'SELECT COUNT(*) AS c FROM categories WHERE tenant_id = ?',
        'SELECT COUNT(*) AS c FROM categories',
        [tenantId],
      ),
      user_count: await countFor(
        db,
        scope,
        'SELECT COUNT(*) AS c FROM users WHERE tenant_id = ?',
        'SELECT COUNT(*) AS c FROM users',
        [tenantId],
      ),
    };
    summary.storage_used_gb = summary.total_size_bytes / (1024 ** 3);

    // Upload trend for the last 7 calendar days, oldest first. The date list
    // is built with local-date arithmetic in JS (MySQL's CURDATE() is local
    // too) and each day is queried with a prepared statement — no string
    // interpolation ever reaches the SQL.
    const trendDates = [];
    const now = new Date();
    for (let i = 6; i >= 0; i -= 1) {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
      const yyyy = d.getFullYear();
      const mm = String(d.getMonth() + 1).padStart(2, '0');
      const dd = String(d.getDate()).padStart(2, '0');
      trendDates.push(`${yyyy}-${mm}-${dd}`);
    }
    const upload_trend = [];
    for (const date of trendDates) {
      const count = await countFor(
        db,
        scope,
        "SELECT COUNT(*) AS c FROM assets WHERE tenant_id = ? AND status != 'deleted' AND DATE(created_at) = ?",
        "SELECT COUNT(*) AS c FROM assets WHERE status != 'deleted' AND DATE(created_at) = ?",
        [tenantId, date],
        [date],
      );
      upload_trend.push({ date, count });
    }

    let recent_assets;
    if (isAllTenants(scope)) {
      // tenant-lint: allow a superadmin reads across every tenant
      recent_assets = await db
        .prepare(
          `SELECT ${ASSET_COLUMNS} FROM assets a WHERE a.status != 'deleted' ORDER BY a.created_at DESC LIMIT 10`,
        )
        .all();
    } else {
      recent_assets = await db
        .prepare(
          `SELECT ${ASSET_COLUMNS} FROM assets a WHERE a.tenant_id = ? AND a.status != 'deleted' ORDER BY a.created_at DESC LIMIT 10`,
        )
        .all(tenantId);
    }

    return res.json({ summary, upload_trend, recent_assets: recent_assets.map(toAsset) });
  }));

  return router;
}

module.exports = createStatsRouter;
