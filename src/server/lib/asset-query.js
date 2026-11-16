'use strict';

/**
 * Asset reads: the row's vocabulary, the filter builder and the two queries
 * that use it (the paginated list and the single-row read).
 *
 * This module is the *only* place that knows the asset list contract — the
 * frontend mirrors these parameter names in `src/client/api/assets.ts`. The
 * write side (upload, tagging, the three deletion states) lives in
 * `assets.js`, which re-exports everything here so a caller keeps requiring
 * one module.
 */

const { parsePositiveInt, parseBoolean } = require('./util');
const { isAllTenants } = require('./tenant');

const MAX_PAGE_SIZE = 200;

/**
 * Column list for asset reads. The `tag_names_csv` alias is a correlated
 * subquery so a list of N assets still costs exactly one SQL statement.
 */
const ASSET_COLUMNS = `
  a.id, a.tenant_id, a.title, a.description, a.filename, a.original_name, a.mime_type,
  a.file_size, a.file_hash, a.asset_type, a.category_id, a.width, a.height,
  a.duration, a.storage_path, a.thumbnail_path, a.status, a.deleted_at,
  a.uploaded_by, a.source, a.source_tool, a.prompt, a.seed, a.model_name,
  a.job_id, a.metadata_json, a.created_at, a.updated_at,
  -- The workflow itself is a document that can run to tens of kilobytes, so a
  -- listing does not carry it. What a listing needs is the fact that there is
  -- one, and that is a single bit.
  (a.workflow_json IS NOT NULL) AS has_workflow,
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
  // SQLite sorted titles with `COLLATE NOCASE`; MySQL has no such collation.
  // The table's `utf8mb4_unicode_ci` collation is already case-insensitive,
  // so the plain form keeps the same ordering.
  title_asc: 'a.title ASC',
  title_desc: 'a.title DESC',
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
function buildAssetWhere(scope, query) {
  const where = [];
  const params = [];

  // A listing without a scope is a listing of everything, which is never what
  // a caller meant. The scope is the only thing that says whose assets these
  // are, so a missing one is refused rather than read as "all of them" — the
  // same answer `findAssetById` gives.
  if (!scope || !scope.tenantId) {
    throw Object.assign(new Error('An asset read cannot run without a tenant scope'), {
      status: 403,
      code: 'NO_TENANT_SCOPE',
    });
  }

  if (scope.tenantId !== '*') {
    where.push('a.tenant_id = ?');
    params.push(scope.tenantId);
  }

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
 * @param {object} db
 * @param {Record<string, any>} query
 * @returns {Promise<{items: any[], total: number, page: number, page_size: number}>}
 */
async function listAssets(db, scope, query) {
  const page = parsePositiveInt(query.page, 1, 100000);
  const pageSize = parsePositiveInt(query.page_size, 20, MAX_PAGE_SIZE);
  const { whereSql, params } = buildAssetWhere(scope, query);
  const countRow = await db
    .prepare(`SELECT COUNT(*) AS c FROM assets a ${whereSql} -- tenant`)
    .get(...params);
  const total = Number(countRow.c);
  const orderSql = ORDER_BY[String(query.order_by || '')] || ORDER_BY.created_at_desc;
  const offset = (page - 1) * pageSize;
  const items = await db
    .prepare(
      `SELECT ${ASSET_COLUMNS} FROM assets a ${whereSql} ORDER BY ${orderSql} LIMIT ? OFFSET ? -- tenant`,
    )
    .all(...params, pageSize, offset);
  return { items, total, page, page_size: pageSize };
}

/**
 * Read a single asset row (with the tag alias) or null.
 *
 * @param {object} db
 * @param {string} id
 * @returns {Promise<any|null>}
 */
async function findAssetById(db, scope, id) {
  if (!scope || !scope.tenantId) {
    throw Object.assign(new Error('An asset read cannot run without a tenant scope'), {
      status: 403,
      code: 'NO_TENANT_SCOPE',
    });
  }
  const isSuperadmin = isAllTenants(scope);
  // A platform administrator's scope covers every tenant, so this branch
  // deliberately has no tenant condition.
  // tenant-lint: allow a superadmin reads across every tenant
  const row = isSuperadmin
    ? await db.prepare(`SELECT ${ASSET_COLUMNS} FROM assets a WHERE a.id = ?`).get(String(id))
    : await db
        .prepare(`SELECT ${ASSET_COLUMNS} FROM assets a WHERE a.id = ? AND a.tenant_id = ?`)
        .get(String(id), scope.tenantId);
  return row || null;
}

module.exports = {
  ASSET_COLUMNS,
  ASSET_STATUSES,
  MAX_PAGE_SIZE,
  detectAssetType,
  buildAssetWhere,
  listAssets,
  findAssetById,
};
