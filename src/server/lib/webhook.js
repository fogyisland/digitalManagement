'use strict';
/**
 * Webhook dispatch library.
 *
 * Responsibilities:
 *   1. Sign a JSON payload with HMAC-SHA256 using an endpoint secret.
 *   2. POST the payload to the endpoint URL with the signature header.
 *   3. Retry on transient failures (network error, 5xx, timeout) using
 *      exponential backoff with jitter.
 *   4. Persist a terminal `webhook_logs` row (status=done|failed) for every
 *      dispatch attempt, including the attempt count and last error.
 *   5. Surface the result to the caller. Never swallow failures.
 *
 * Signature contract:
 *   Header:  X-DAM-Signature: sha256=<lowercase-hex>
 *   Hex is HMAC-SHA256 over the **raw body bytes** (the exact string the
 *   receiver will hash on its end). Any re-serialization on the receiver
 *   side will produce a mismatch, so receivers must hash the raw request
 *   body, not re-serialize the parsed JSON.
 */

const crypto = require('crypto');
const http = require('http');
const https = require('https');
const { URL } = require('url');
const { nanoid } = require('nanoid');

// --- Tunables ---------------------------------------------------------------
const MAX_ATTEMPTS = 3;                 // total tries per dispatch (initial + 2 retries)
const BASE_BACKOFF_MS = 200;            // backoff base; doubles each retry
const MAX_BACKOFF_MS = 5000;             // upper bound for a single sleep
const REQUEST_TIMEOUT_MS = 5000;        // per-attempt socket timeout

/**
 * The event vocabulary an endpoint can subscribe to.
 *
 * `emitAssetEvent` (backend/src/lib/assets.js) emits exactly these names.
 * The frontend mirrors the list in `frontend/src/api/webhooks.ts` — the two
 * must stay identical or a subscription the UI accepted would silently
 * never fire.
 *
 * An endpoint with **no** subscription receives every event; that is the
 * behaviour of every row created before the column existed.
 */
const WEBHOOK_EVENTS = [
  'asset.created',
  'asset.updated',
  'asset.deleted',
  'asset.restored',
];

// Status codes that are worth retrying. Everything else (incl. 4xx) is a
// deterministic client error and we stop retrying immediately.
function isRetryableStatus(status) {
  return status === 408 || status === 425 || status === 429 || (status >= 500 && status < 600);
}

/**
 * Compute HMAC-SHA256(secret, body) and return **lowercase hex**.
 *
 * @param {string} secret endpoint secret
 * @param {string|Buffer} body raw body bytes that will be transmitted
 * @returns {string} lowercase hex digest (64 chars)
 */
function signPayload(secret, body) {
  if (typeof secret !== 'string' || secret.length === 0) {
    throw new TypeError('signPayload: secret must be a non-empty string');
  }
  if (body === null || body === undefined) {
    throw new TypeError('signPayload: body must not be null/undefined');
  }
  return crypto.createHmac('sha256', secret).update(body).digest('hex');
}

/**
 * Constant-time comparison of two hex strings of equal length.
 *
 * Returns false immediately if lengths differ. When lengths match, both
 * inputs are decoded to bytes via Buffer.from(..., 'hex') (which is
 * non-throwing in Node — invalid chars are silently dropped, so the
 * post-decode byte length is a stricter check than the input length). We
 * compare buffers with crypto.timingSafeEqual to avoid leaking prefix-match
 * timing information to a network attacker probing signatures.
 */
function timingSafeHexEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  // Buffer.from(str, 'hex') does not throw on bad input; it drops invalid
  // chars. So the byte-length check below is the real authority.
  const bufA = Buffer.from(a, 'hex');
  const bufB = Buffer.from(b, 'hex');
  if (bufA.length !== bufB.length || bufA.length === 0) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Sleep `ms` milliseconds. Used between retry attempts.
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Compute the next backoff window with full jitter:
 *   attempt 0 -> BASE..2*BASE
 *   attempt 1 -> BASE*2..BASE*4
 *   ...
 * Capped at MAX_BACKOFF_MS.
 */
function computeBackoffMs(attemptIndex) {
  const exp = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * Math.pow(2, attemptIndex));
  // Full jitter: uniform random in [BASE_BACKOFF_MS, exp]
  const lo = BASE_BACKOFF_MS;
  const hi = Math.max(lo, Math.floor(exp));
  return Math.floor(lo + Math.random() * (hi - lo + 1));
}

/**
 * POST `body` (string) to `url` with the given headers.
 * Resolves to {status, body} on completion. Never rejects for HTTP error
 * statuses — only for transport-layer failures (DNS, TLS, timeout, socket
 * hang up). The receiver will inspect `status` to decide retry semantics.
 *
 * @param {string} url absolute http(s) URL
 * @param {string} body raw body bytes (utf-8 string)
 * @param {Object} headers extra request headers
 * @param {number} timeoutMs per-attempt socket timeout
 * @returns {Promise<{status:number, body:string}>}
 */
function httpPost(url, body, headers, timeoutMs) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch (e) {
    return Promise.reject(new Error(`invalid webhook url "${url}": ${e.message}`));
  }
  const isHttps = parsed.protocol === 'https:';
  const lib = isHttps ? https : http;
  const port = parsed.port
    ? parseInt(parsed.port, 10)
    : (isHttps ? 443 : 80);

  return new Promise((resolve, reject) => {
    const req = lib.request({
      method: 'POST',
      hostname: parsed.hostname,
      port,
      path: (parsed.pathname || '/') + (parsed.search || ''),
      headers: Object.assign(
        { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
        headers || {},
      ),
      timeout: timeoutMs,
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        resolve({
          status: res.statusCode || 0,
          body: Buffer.concat(chunks).toString('utf8'),
        });
      });
      res.on('error', (e) => reject(e));
    });
    req.on('error', (e) => reject(e));
    req.on('timeout', () => {
      req.destroy(new Error(`webhook request timeout after ${timeoutMs}ms`));
    });
    req.write(body);
    req.end();
  });
}

/**
 * Validate the `endpoint` shape. Throws TypeError on misuse; the dispatch
 * function itself will surface that to the caller.
 */
function assertEndpoint(endpoint) {
  if (!endpoint || typeof endpoint !== 'object') {
    throw new TypeError('dispatch: endpoint must be an object');
  }
  if (typeof endpoint.id !== 'string' || !endpoint.id) {
    throw new TypeError('dispatch: endpoint.id must be a non-empty string');
  }
  if (typeof endpoint.url !== 'string' || !/^https?:\/\//.test(endpoint.url)) {
    throw new TypeError('dispatch: endpoint.url must be an http(s) URL');
  }
  if (typeof endpoint.secret !== 'string' || !endpoint.secret) {
    throw new TypeError('dispatch: endpoint.secret must be a non-empty string');
  }
}

/**
 * Persist a terminal `webhook_logs` row. We swallow DB errors with a
 * console.error — losing a log row is bad, but losing the dispatch result
 * (which is already in `final`) is the worse failure. The caller still sees
 * `final` and can react.
 *
 * @param {Object} db the database handle
 * @param {string} endpointId
 * @param {string} event
 * @param {string} body the signed payload
 * @param {{status: string, attempts: number, error: string|null}} final
 * @returns {Promise<void>}
 */
async function recordLog(db, endpointId, event, body, final) {
  try {
    await db
      .prepare(
        'INSERT INTO webhook_logs (id, endpoint_id, event, payload, status, attempts, last_error) VALUES (?, ?, ?, ?, ?, ?, ?)'
      )
      .run(
        nanoid(),
        endpointId,
        event,
        body,
        final.status,
        final.attempts,
        final.error,
      );
  } catch (e) {
    // Visible, structured, contextual — never silent.
    console.error('[webhook] failed to insert webhook_logs row', {
      endpointId,
      event,
      status: final.status,
      attempts: final.attempts,
      err: e.message,
    });
  }
}

/**
 * Mark the endpoint active when delivery succeeded, leave unchanged on
 * failure. `is_active` is not auto-disabled by a single failed attempt —
 * operations may want to keep endpoints warm — but this hook is in place
 * so task 7 can layer policy on top if desired.
 *
 * @param {Object} db the database handle
 * @param {string} endpointId
 * @param {string} finalStatus
 * @returns {Promise<void>}
 */
async function updateEndpointState(db, endpointId, finalStatus) {
  try {
    await db
      .prepare(
        'UPDATE webhook_endpoints SET is_active = CASE WHEN ? THEN 1 ELSE is_active END WHERE id = ?'
      )
      .run(finalStatus === 'done' ? 1 : 0, endpointId);
  } catch (e) {
    console.error('[webhook] failed to update webhook_endpoints.is_active', {
      endpointId,
      finalStatus,
      err: e.message,
    });
  }
}

/**
 * Dispatch a webhook.
 *
 * @param {Object} db the database handle, with `webhook_logs` +
 *          `webhook_endpoints` tables
 * @param {Object} endpoint {id, url, secret, [name], [is_active]}
 * @param {string} event short event name (e.g. "asset.created")
 * @param {Object} payload JSON-serializable payload
 * @returns {Promise<{status:'done'|'failed', attempts:number, error:string|null}>}
 *          The promise rejects only if `db` is missing / endpoint is
 *          malformed. Transport-level failures are reported as
 *          `{status:'failed', attempts, error}` so callers can always rely
 *          on a terminal result.
 */
async function dispatch(db, endpoint, event, payload) {
  if (!db || typeof db.prepare !== 'function') {
    throw new TypeError('dispatch: db must be a database handle');
  }
  assertEndpoint(endpoint);
  if (typeof event !== 'string' || !event) {
    throw new TypeError('dispatch: event must be a non-empty string');
  }
  if (payload === undefined) {
    throw new TypeError('dispatch: payload must not be undefined');
  }

  const body = JSON.stringify({ event, payload, ts: new Date().toISOString() });
  const sig = signPayload(endpoint.secret, body);
  const headers = {
    'X-DAM-Signature': 'sha256=' + sig,
    'X-DAM-Event': event,
    'X-DAM-Attempt': '1',
  };

  let attempts = 0;
  let lastError = null;
  let terminal = { status: 'failed', attempts: 0, error: 'no attempts made' };

  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    attempts = i + 1;
    headers['X-DAM-Attempt'] = String(attempts);
    try {
      const res = await httpPost(endpoint.url, body, headers, REQUEST_TIMEOUT_MS);
      if (res.status >= 200 && res.status < 300) {
        terminal = { status: 'done', attempts, error: null };
        break;
      }
      lastError = `HTTP ${res.status}`;
      // Deterministic 4xx (other than the retryable subset) -> stop immediately.
      if (!isRetryableStatus(res.status)) {
        break;
      }
    } catch (e) {
      lastError = (e && e.message) ? e.message : String(e);
      console.error('[webhook] transport error', {
        endpointId: endpoint.id,
        event,
        attempt: attempts,
        err: lastError,
      });
      // Transport errors are always retried.
    }

    if (i < MAX_ATTEMPTS - 1) {
      await sleep(computeBackoffMs(i));
    }
  }

  if (terminal.status !== 'done') {
    terminal = { status: 'failed', attempts, error: lastError };
  }

  // Persist terminal state and reflect into endpoint flag.
  await recordLog(db, endpoint.id, event, body, terminal);
  await updateEndpointState(db, endpoint.id, terminal.status);

  return terminal;
}

module.exports = {
  dispatch,
  signPayload,
  // Exported for tests + task 7 verification flow.
  timingSafeHexEqual,
  isRetryableStatus,
  computeBackoffMs,
  MAX_ATTEMPTS,
  // The event vocabulary — shared by the routes (validation) and by
  // `emitAssetEvent` (filtering). The frontend mirrors it in
  // `frontend/src/api/webhooks.ts`.
  WEBHOOK_EVENTS,
};
