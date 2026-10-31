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

/**
 * @param {{db: import('better-sqlite3').Database}} deps
 * @returns {import('express').Router}
 */
function createStatsRouter({ db }) {
  const router = express.Router();

  router.get('/stats', authRequired(db), (_req, res) => {
    const total = db
      .prepare("SELECT COUNT(*) AS c FROM assets WHERE status != 'deleted'")
      .get().c;
    const images = db
      .prepare("SELECT COUNT(*) AS c FROM assets WHERE status != 'deleted' AND asset_type = 'image'")
      .get().c;
    const videos = db
      .prepare("SELECT COUNT(*) AS c FROM assets WHERE status != 'deleted' AND asset_type = 'video'")
      .get().c;
    const totalSize = db
      .prepare("SELECT COALESCE(SUM(file_size), 0) AS s FROM assets WHERE status != 'deleted'")
      .get().s;
    const recent = db
      .prepare(
        `SELECT ${ASSET_COLUMNS} FROM assets a WHERE a.status != 'deleted' ORDER BY a.created_at DESC LIMIT 10`,
      )
      .all();
    return res.json({
      total,
      images,
      videos,
      total_size: totalSize,
      recent: recent.map(toAsset),
    });
  });

  router.get('/stats/dashboard', authRequired(db), (_req, res) => {
    const summary = {
      total_assets: db.prepare("SELECT COUNT(*) AS c FROM assets WHERE status != 'deleted'").get().c,
      image_count: db
        .prepare("SELECT COUNT(*) AS c FROM assets WHERE status != 'deleted' AND asset_type = 'image'")
        .get().c,
      video_count: db
        .prepare("SELECT COUNT(*) AS c FROM assets WHERE status != 'deleted' AND asset_type = 'video'")
        .get().c,
      total_size_bytes: db
        .prepare("SELECT COALESCE(SUM(file_size), 0) AS s FROM assets WHERE status != 'deleted'")
        .get().s,
      storage_used_gb: 0,
      today_uploads: db
        .prepare(
          "SELECT COUNT(*) AS c FROM assets WHERE status != 'deleted' AND date(created_at) = date('now')",
        )
        .get().c,
      week_uploads: db
        .prepare(
          "SELECT COUNT(*) AS c FROM assets WHERE status != 'deleted' AND created_at >= datetime('now', '-7 days')",
        )
        .get().c,
      month_uploads: db
        .prepare(
          "SELECT COUNT(*) AS c FROM assets WHERE status != 'deleted' AND created_at >= datetime('now', '-30 days')",
        )
        .get().c,
      tag_count: db.prepare('SELECT COUNT(*) AS c FROM tags').get().c,
      category_count: db.prepare('SELECT COUNT(*) AS c FROM categories').get().c,
      user_count: db.prepare('SELECT COUNT(*) AS c FROM users').get().c,
    };
    summary.storage_used_gb = summary.total_size_bytes / (1024 ** 3);

    // Upload trend for the last 7 calendar days, oldest first. The date list
    // is built with local-date arithmetic in JS (SQLite's date('now') is local
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
      "SELECT COUNT(*) AS c FROM assets WHERE status != 'deleted' AND date(created_at) = ?",
    );
    const upload_trend = trendDates.map((date) => ({ date, count: dayCountStmt.get(date).c }));

    const recent_assets = db
      .prepare(
        `SELECT ${ASSET_COLUMNS} FROM assets a WHERE a.status != 'deleted' ORDER BY a.created_at DESC LIMIT 10`,
      )
      .all()
      .map(toAsset);

    return res.json({ summary, upload_trend, recent_assets });
  });

  return router;
}

module.exports = createStatsRouter;
