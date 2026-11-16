'use strict';

/**
 * The reports over the request log.
 *
 * The recorder itself — the middleware that writes one row per API call —
 * lives in `request-log.js`. This file is the other half: the questions the
 * platform layer asks about the traffic that was recorded.
 *
 *   - `listRequests`    the rows themselves, filtered and paged
 *   - `trafficReport`   the totals, the shape over time, and the heaviest routes
 *
 * Every query here names `tenant_id`, even the platform's own reads: the
 * platform reads across the tenants *by asking for it* (an empty tenant means
 * every tenant), and a condition that is visible in the statement is one a
 * reviewer can read.
 */

/** The default number of hours a traffic report covers. */
const DEFAULT_WINDOW_HOURS = 24;

/**
 * How many buckets a traffic report carries.
 *
 * One bucket per hour for a day; a longer window asks for more buckets than
 * that, and a report nobody can read is not a report.
 */
const MAX_BUCKETS = 168;

/**
 * The status range a filter names.
 *
 * `'4xx'` is 400–499, `'5xx'` is 500 and above, `'2xx'` is 200–299. An
 * unknown filter means "no filter", which is expressed as the range `0`–`0`
 * and switched off by the leading parameter.
 *
 * @param {string} statusClass
 * @returns {{min: number, max: number}}
 */
function statusRange(statusClass) {
  switch (String(statusClass || '').trim()) {
    case '2xx':
      return { min: 200, max: 299 };
    case '4xx':
      return { min: 400, max: 499 };
    case '5xx':
      return { min: 500, max: 599 };
    default:
      return { min: 0, max: 0 };
  }
}

/**
 * The request log, newest first.
 *
 * The platform reads it across the tenants; a tenant reads its own. An empty
 * `tenantId` means every tenant — the platform's own scope — and it is asked
 * for explicitly rather than implied by the caller.
 *
 * @param {object} db
 * @param {{tenantId?: string, keyword?: string, method?: string,
 *          statusClass?: string, hours?: number, limit?: number, offset?: number}} options
 * @returns {Promise<{items: object[], total: number}>}
 */
async function listRequests(db, options = {}) {
  const tenantId = String(options.tenantId || '').trim();
  const keyword = String(options.keyword || '').trim();
  const method = String(options.method || '').trim().toUpperCase();
  const { min, max } = statusRange(options.statusClass);
  const hours = Math.min(Math.max(Number(options.hours) || DEFAULT_WINDOW_HOURS, 1), 24 * 30);
  const limit = Math.min(Math.max(Number(options.limit) || 50, 1), 200);
  const offset = Math.max(Number(options.offset) || 0, 0);
  const like = `%${keyword}%`;
  const params = [
    tenantId,
    tenantId,
    keyword,
    like,
    like,
    method,
    method,
    min === 0 ? 0 : 1,
    min,
    max,
    hours,
  ];

  // The tenant filter, the keyword, the method and the status class are each
  // one leading parameter that switches its own condition off. A leading `0`
  // means "no filter"; the condition that follows is the one that narrows.
  //
  // The condition is written out in every statement rather than assembled into
  // a variable: a WHERE clause that only exists at runtime cannot be audited,
  // and this is the one query whose scope decides who may see whose traffic.
  const rows = await db
    .prepare(
      `SELECT r.id, r.tenant_id, r.user_id, u.username, r.method, r.path, r.route,
              r.status, r.duration_ms, r.bytes_in, r.bytes_out, r.ip_address, r.created_at
         FROM request_logs r
         LEFT JOIN users u ON u.id = r.user_id
        WHERE (? = '' OR r.tenant_id = ?)
          AND (? = '' OR r.path LIKE ? OR r.route LIKE ?)
          AND (? = '' OR r.method = ?)
          AND (? = 0 OR (r.status >= ? AND r.status <= ?))
          AND r.created_at >= DATE_SUB(NOW(), INTERVAL ? HOUR)
        ORDER BY r.created_at DESC, r.id DESC
        LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, offset);

  const counted = await db
    .prepare(
      `SELECT COUNT(*) AS c
         FROM request_logs r
        WHERE (? = '' OR r.tenant_id = ?)
          AND (? = '' OR r.path LIKE ? OR r.route LIKE ?)
          AND (? = '' OR r.method = ?)
          AND (? = 0 OR (r.status >= ? AND r.status <= ?))
          AND r.created_at >= DATE_SUB(NOW(), INTERVAL ? HOUR)`,
    )
    .get(...params);

  return {
    items: rows.map((row) => ({
      id: row.id,
      tenant_id: row.tenant_id,
      user_id: row.user_id,
      username: row.username,
      method: row.method,
      path: row.path,
      route: row.route,
      status: row.status,
      duration_ms: row.duration_ms,
      bytes_in: Number(row.bytes_in),
      bytes_out: Number(row.bytes_out),
      ip_address: row.ip_address,
      created_at: row.created_at,
    })),
    total: Number(counted.c),
  };
}

/**
 * The traffic over a window: the totals, the shape over time, and the
 * endpoints that carry the traffic.
 *
 * @param {object} db
 * @param {{tenantId?: string, hours?: number, buckets?: number}} options
 * @returns {Promise<{summary: object, buckets: object[], routes: object[]}>}
 */
async function trafficReport(db, options = {}) {
  const tenantId = String(options.tenantId || '').trim();
  const hours = Math.min(Math.max(Number(options.hours) || DEFAULT_WINDOW_HOURS, 1), 24 * 30);
  const buckets = Math.min(Math.max(Number(options.buckets) || hours, 1), MAX_BUCKETS);

  const totals = await db
    .prepare(
      `SELECT COUNT(*) AS requests,
              COALESCE(SUM(bytes_in), 0) AS bytes_in,
              COALESCE(SUM(bytes_out), 0) AS bytes_out,
              SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END) AS errors,
              SUM(CASE WHEN status >= 500 THEN 1 ELSE 0 END) AS server_errors,
              COALESCE(AVG(duration_ms), 0) AS avg_duration_ms
         FROM request_logs
        WHERE (? = '' OR tenant_id = ?)
          AND created_at >= DATE_SUB(NOW(), INTERVAL ? HOUR)`,
    )
    .get(tenantId, tenantId, hours);

  const series = await db
    .prepare(
      `SELECT DATE_FORMAT(created_at, '%Y-%m-%d %H:00:00') AS bucket,
              COUNT(*) AS requests,
              COALESCE(SUM(bytes_in), 0) AS bytes_in,
              COALESCE(SUM(bytes_out), 0) AS bytes_out,
              SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END) AS errors
         FROM request_logs
        WHERE (? = '' OR tenant_id = ?)
          AND created_at >= DATE_SUB(NOW(), INTERVAL ? HOUR)
        GROUP BY bucket
        ORDER BY bucket ASC
        LIMIT ?`,
    )
    .all(tenantId, tenantId, hours, buckets);

  const routes = await db
    .prepare(
      `SELECT route, COUNT(*) AS requests,
              COALESCE(SUM(bytes_out), 0) AS bytes_out,
              COALESCE(AVG(duration_ms), 0) AS avg_duration_ms
         FROM request_logs
        WHERE (? = '' OR tenant_id = ?)
          AND created_at >= DATE_SUB(NOW(), INTERVAL ? HOUR)
        GROUP BY route
        ORDER BY requests DESC
        LIMIT 10`,
    )
    .all(tenantId, tenantId, hours);

  const requests = Number(totals.requests) || 0;
  const errors = Number(totals.errors) || 0;

  return {
    summary: {
      window_hours: hours,
      requests,
      bytes_in: Number(totals.bytes_in) || 0,
      bytes_out: Number(totals.bytes_out) || 0,
      errors,
      server_errors: Number(totals.server_errors) || 0,
      error_rate: requests > 0 ? Math.round((errors / requests) * 1000) / 1000 : 0,
      avg_duration_ms: Math.round(Number(totals.avg_duration_ms) || 0),
    },
    buckets: series.map((row) => ({
      bucket: row.bucket,
      requests: Number(row.requests),
      bytes_in: Number(row.bytes_in),
      bytes_out: Number(row.bytes_out),
      errors: Number(row.errors),
    })),
    routes: routes.map((row) => ({
      route: row.route,
      requests: Number(row.requests),
      bytes_out: Number(row.bytes_out),
      avg_duration_ms: Math.round(Number(row.avg_duration_ms) || 0),
    })),
  };
}

module.exports = {
  DEFAULT_WINDOW_HOURS,
  MAX_BUCKETS,
  statusRange,
  listRequests,
  trafficReport,
};
