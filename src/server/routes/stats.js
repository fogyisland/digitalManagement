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
 */

const express = require('express');
const { authRequired } = require('../lib/auth');
const { toAsset } = require('../lib/dto');
const { ASSET_COLUMNS } = require('../lib/assets');
const { asyncHandler } = require('../lib/http');

/**
 * @param {{db: object}} deps
 * @returns {import('express').Router}
 */
function createStatsRouter({ db }) {
  const router = express.Router();

  router.get('/stats', authRequired(db), asyncHandler(async (req, res) => {
    // Every counter is scoped to the caller's tenant: a platform
    // administrator's `tenantId` is the wildcard, so their scope adds no
    // condition and their totals cover the whole platform.
    const tenantId = req.tenantScope.tenantId;
    const total = (
      await db
        .prepare(
          "SELECT COUNT(*) AS c FROM assets WHERE tenant_id = ? AND status != 'deleted'",
        )
        .get(tenantId)
    ).c;
    const images = (
      await db
        .prepare(
          "SELECT COUNT(*) AS c FROM assets WHERE tenant_id = ? AND status != 'deleted' AND asset_type = 'image'",
        )
        .get(tenantId)
    ).c;
    const videos = (
      await db
        .prepare(
          "SELECT COUNT(*) AS c FROM assets WHERE tenant_id = ? AND status != 'deleted' AND asset_type = 'video'",
        )
        .get(tenantId)
    ).c;
    const totalSize = (
      await db
        .prepare(
          "SELECT COALESCE(SUM(file_size), 0) AS s FROM assets WHERE tenant_id = ? AND status != 'deleted'",
        )
        .get(tenantId)
    ).s;
    const recent = await db
      .prepare(
        `SELECT ${ASSET_COLUMNS} FROM assets a WHERE a.tenant_id = ? AND a.status != 'deleted' ORDER BY a.created_at DESC LIMIT 10`,
      )
      .all(tenantId);
    return res.json({
      total: Number(total),
      images: Number(images),
      videos: Number(videos),
      total_size: Number(totalSize),
      recent: recent.map(toAsset),
    });
  }));

  router.get('/stats/dashboard', authRequired(db), asyncHandler(async (req, res) => {
    const tenantId = req.tenantScope.tenantId;
    const summary = {
      total_assets: Number(
        (
          await db
            .prepare(
              "SELECT COUNT(*) AS c FROM assets WHERE tenant_id = ? AND status != 'deleted'",
            )
            .get(tenantId)
        ).c,
      ),
      image_count: Number(
        (
          await db
            .prepare(
              "SELECT COUNT(*) AS c FROM assets WHERE tenant_id = ? AND status != 'deleted' AND asset_type = 'image'",
            )
            .get(tenantId)
        ).c,
      ),
      video_count: Number(
        (
          await db
            .prepare(
              "SELECT COUNT(*) AS c FROM assets WHERE tenant_id = ? AND status != 'deleted' AND asset_type = 'video'",
            )
            .get(tenantId)
        ).c,
      ),
      total_size_bytes: Number(
        (
          await db
            .prepare(
              "SELECT COALESCE(SUM(file_size), 0) AS s FROM assets WHERE tenant_id = ? AND status != 'deleted'",
            )
            .get(tenantId)
        ).s,
      ),
      storage_used_gb: 0,
      today_uploads: Number(
        (
          await db
            .prepare(
              "SELECT COUNT(*) AS c FROM assets WHERE tenant_id = ? AND status != 'deleted' AND DATE(created_at) = CURDATE()",
            )
            .get(tenantId)
        ).c,
      ),
      week_uploads: Number(
        (
          await db
            .prepare(
              "SELECT COUNT(*) AS c FROM assets WHERE tenant_id = ? AND status != 'deleted' AND created_at >= NOW() - INTERVAL 7 DAY",
            )
            .get(tenantId)
        ).c,
      ),
      month_uploads: Number(
        (
          await db
            .prepare(
              "SELECT COUNT(*) AS c FROM assets WHERE tenant_id = ? AND status != 'deleted' AND created_at >= NOW() - INTERVAL 30 DAY",
            )
            .get(tenantId)
        ).c,
      ),
      tag_count: Number(
        (
          await db.prepare('SELECT COUNT(*) AS c FROM tags WHERE tenant_id = ?').get(tenantId)
        ).c,
      ),
      category_count: Number(
        (
          await db
            .prepare('SELECT COUNT(*) AS c FROM categories WHERE tenant_id = ?')
            .get(tenantId)
        ).c,
      ),
      user_count: Number(
        (await db.prepare('SELECT COUNT(*) AS c FROM users WHERE tenant_id = ?').get(tenantId)).c,
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
    const dayCountStmt = db.prepare(
      "SELECT COUNT(*) AS c FROM assets WHERE tenant_id = ? AND status != 'deleted' AND DATE(created_at) = ?",
    );
    const upload_trend = [];
    for (const date of trendDates) {
      const row = await dayCountStmt.get(tenantId, date);
      upload_trend.push({ date, count: Number(row.c) });
    }

    const recent_assets = (
      await db
        .prepare(
          `SELECT ${ASSET_COLUMNS} FROM assets a WHERE a.tenant_id = ? AND a.status != 'deleted' ORDER BY a.created_at DESC LIMIT 10`,
        )
        .all(tenantId)
    ).map(toAsset);

    return res.json({ summary, upload_trend, recent_assets });
  }));

  return router;
}

module.exports = createStatsRouter;
