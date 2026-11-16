'use strict';

/**
 * The request log — the traffic record.
 *
 * One row per API call: what was asked, who asked it, which tenant it spoke
 * for, how long it took, and how many bytes came in and went out.
 *
 * This is **not** the audit trail. The audit trail (`audit_logs`) answers "what
 * did a person change"; this answers "what was this instance asked to do, and
 * how much did it move". They are different questions, so they are different
 * tables — and the request log is the one that grows on its own, one row per
 * request, which is why it is pruned on a retention window.
 *
 * This file is the recorder: the middleware that writes the rows, and the
 * sweep that drops the ones that fell out of the retention window. The
 * questions asked *about* those rows — the list and the traffic report — live
 * in `request-log-report.js`.
 *
 * Every row names the tenant it belongs to, even the ones the platform's own
 * actions produce: a request that resolved no tenant is kept under the
 * wildcard, the same place the platform's own actions go.
 */

const { nanoid } = require('nanoid');

/** The default number of days a request row is kept. */
const DEFAULT_RETENTION_DAYS = 30;

/**
 * How many consecutive failures turn into a pause.
 *
 * The first failure is worth a line on the console — something is wrong with
 * the database, and the operator should know. The second and third are not:
 * they are the same failure, again. So the count climbs quietly and the log
 * stops trying.
 */
const FAILURE_THRESHOLD = 3;

/**
 * How long the logger waits before it tries again after repeated failures.
 *
 * A minute is long enough that a database which is down for a moment does not
 * get a failed write per request, and short enough that the traffic resumes on
 * its own once the database is back.
 */
const FAILURE_BACKOFF_MS = 60 * 1000;

/**
 * Is the pool this handle points at closed?
 *
 * A request that finishes while the process is shutting down would otherwise
 * try to write into a pool that has already been closed, and the failure would
 * be noise about a shutdown rather than about the database.
 *
 * @param {object} db
 * @returns {boolean}
 */
function poolClosed(db) {
  const pool = db && db.pool;
  const core = pool && pool.pool;
  return Boolean(core && core._closed);
}

/**
 * Write one request into the log.
 *
 * A log that can break the operation it logs is worse than no log: the call
 * has already answered the client by the time this runs, so a failure here is
 * reported and dropped rather than raised.
 *
 * @param {object} db
 * @param {{tenantId: string, userId?: string|null, method: string, path: string,
 *          route?: string, status: number, durationMs: number,
 *          bytesIn?: number, bytesOut?: number, ip?: string|null}} entry
 * @returns {Promise<{ok: boolean, error?: Error}>} whether the row was written
 */
async function recordRequest(db, entry) {
  try {
    await db
      .prepare(
        `INSERT INTO request_logs
           (id, tenant_id, user_id, method, path, route, status, duration_ms,
            bytes_in, bytes_out, ip_address, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
      )
      .run(
        nanoid(),
        String(entry.tenantId || '*'),
        entry.userId ? String(entry.userId) : null,
        String(entry.method || 'GET').slice(0, 8),
        String(entry.path || '/').slice(0, 255),
        String(entry.route || '').slice(0, 191),
        Number(entry.status) || 0,
        Math.max(0, Math.round(Number(entry.durationMs) || 0)),
        Math.max(0, Math.round(Number(entry.bytesIn) || 0)),
        Math.max(0, Math.round(Number(entry.bytesOut) || 0)),
        entry.ip ? String(entry.ip).slice(0, 64) : null,
      );
    return { ok: true };
  } catch (error) {
    return { ok: false, error };
  }
}

/**
 * The bytes a chunk carries.
 *
 * `res.write` and `res.end` take a chunk that may be a buffer, a string or
 * nothing at all, and the encoding only applies to the string form.
 *
 * @param {unknown} chunk
 * @param {unknown} encoding
 * @returns {number}
 */
function byteLength(chunk, encoding) {
  if (chunk === undefined || chunk === null) return 0;
  if (Buffer.isBuffer(chunk)) return chunk.length;
  if (typeof chunk === 'string') {
    return Buffer.byteLength(chunk, typeof encoding === 'string' ? encoding : 'utf8');
  }
  return 0;
}

/**
 * Is this a request worth logging?
 *
 * The API is. The frontend's own files are not: a browser asks for a dozen
 * JavaScript and CSS files on every page load, and logging those would bury
 * the API traffic under the noise of the interface.
 *
 * The health probes are not either — they are asked for on a timer by whatever
 * is watching the instance, and they say nothing about the traffic.
 *
 * @param {string} url
 * @returns {boolean}
 */
function isLoggedPath(url) {
  const path = String(url || '').split('?')[0];
  if (path.startsWith('/api/health')) return false;
  if (path.startsWith('/api/')) return true;
  // The MCP endpoint is not under `/api`, but it is a call somebody made.
  if (path === '/mcp' || path.startsWith('/mcp/')) return true;
  return false;
}

/**
 * The route pattern a request matched.
 *
 * `req.route.path` is the pattern (`/assets/:id`), which is what makes the
 * traffic report readable: a hundred requests to a hundred different assets
 * are one line of traffic, not a hundred.
 *
 * @param {object} req
 * @returns {string}
 */
function routePattern(req) {
  const route = req && req.route ? req.route.path : '';
  if (Array.isArray(route)) return route.join('|');
  return typeof route === 'string' ? route : '';
}

/**
 * The middleware that records the traffic.
 *
 * The row is written after the response has been flushed, so the call the
 * client is waiting on does not wait for the log — and a slow log cannot make
 * the API slow.
 *
 * The logger also knows how to stay quiet. Three things happen in a normal
 * life of this application where a write *cannot* succeed:
 *
 *   - the installation is not set up yet, so the table is not there
 *   - the database is briefly unreachable
 *   - the process is shutting down and the pool has closed
 *
 * None of them is a fault of the request that happened to be in flight, and
 * none of them is worth a line of console per request. So the logger asks
 * whether it is ready before it writes, and when a write fails it says so once
 * and then waits — the traffic resumes on its own once the database is back.
 *
 * @param {{db: object, isReady?: () => boolean}} deps
 * @returns {import('express').RequestHandler}
 */
function createRequestLogger({ db, isReady }) {
  const state = {
    failures: 0,
    pausedUntil: 0,
    paused: false,
    reported: false,
  };

  /**
   * Write one row, and keep the console quiet about it.
   *
   * @param {object} entry
   * @returns {Promise<void>}
   */
  async function write(entry) {
    // The instance is not up yet — the setup wizard is still open, and there
    // is no table to write into. There is nothing to record and nothing to
    // complain about.
    if (typeof isReady === 'function' && !isReady()) return;
    // The pool is closed: the process is on its way out.
    if (poolClosed(db)) return;
    // The logger is backing off after repeated failures.
    if (Date.now() < state.pausedUntil) return;

    const result = await recordRequest(db, entry);
    if (result.ok) {
      if (state.failures > 0) {
        console.log('[request-log] the traffic is being logged again');
        state.failures = 0;
        state.pausedUntil = 0;
        state.paused = false;
        state.reported = false;
      }
      return;
    }

    const message = result.error && result.error.message ? result.error.message : '';

    // The pool went away: the process is shutting down, or the setup wizard is
    // moving the instance onto another database and drains the old pool. The
    // row is lost, but nothing is wrong with the database — so this is not a
    // fault to count, and not a fault to report.
    if (/pool is closed/i.test(message)) {
      return;
    }

    state.failures += 1;
    if (!state.reported) {
      state.reported = true;
      console.warn(
        '[request-log] a request could not be recorded:',
        result.error && result.error.message,
      );
    }
    if (state.failures >= FAILURE_THRESHOLD && !state.paused) {
      state.paused = true;
      state.pausedUntil = Date.now() + FAILURE_BACKOFF_MS;
      console.warn(
        `[request-log] pausing for ${FAILURE_BACKOFF_MS / 1000}s after ${state.failures} failed writes — the traffic is not being logged while it is paused`,
      );
    }
  }

  return function requestLogger(req, res, next) {
    if (!isLoggedPath(req.originalUrl || req.url)) {
      next();
      return;
    }

    const startedAt = process.hrtime.bigint();
    let bytesOut = 0;
    const originalWrite = res.write;
    const originalEnd = res.end;

    res.write = function countingWrite(chunk, encoding, callback) {
      bytesOut += byteLength(chunk, encoding);
      return originalWrite.call(this, chunk, encoding, callback);
    };
    res.end = function countingEnd(chunk, encoding, callback) {
      bytesOut += byteLength(chunk, encoding);
      return originalEnd.call(this, chunk, encoding, callback);
    };

    res.on('finish', () => {
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
      const scope = req.tenantScope;
      const user = req.user;
      void write({
        // A request that never resolved a tenant — a refused login, a request
        // without a credential — belongs to nobody in particular. It is kept
        // under the wildcard, the same place the platform's own actions go.
        tenantId: scope && scope.tenantId ? scope.tenantId : '*',
        userId: user ? user.id : null,
        method: req.method,
        path: String(req.originalUrl || req.url || '/').split('?')[0],
        route: routePattern(req),
        status: res.statusCode,
        durationMs,
        bytesIn: Number(req.headers['content-length'] || 0),
        bytesOut,
        ip: req.ip,
      });
    });

    next();
  };
}

/**
 * Drop the rows that fell out of the retention window.
 *
 * The log is the one table that grows without anybody asking it to, so it has
 * to lose its oldest rows on its own — otherwise the disk fills up with the
 * traffic of a year ago.
 *
 * @param {object} db
 * @param {number} retentionDays
 * @returns {Promise<number>} how many rows were dropped
 */
async function pruneRequestLogs(db, retentionDays = DEFAULT_RETENTION_DAYS) {
  const days = Math.min(Math.max(Number(retentionDays) || DEFAULT_RETENTION_DAYS, 1), 365);
  // tenant-lint: allow the log is pruned across every tenant — the rows are
  // older than the retention window, whichever tenant they belong to
  const result = await db
    .prepare('DELETE FROM request_logs WHERE created_at < DATE_SUB(NOW(), INTERVAL ? DAY)')
    .run(days);
  return Number(result && result.affectedRows) || 0;
}

module.exports = {
  DEFAULT_RETENTION_DAYS,
  FAILURE_THRESHOLD,
  FAILURE_BACKOFF_MS,
  recordRequest,
  pruneRequestLogs,
  createRequestLogger,
  isLoggedPath,
  poolClosed,
};
