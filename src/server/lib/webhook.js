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
 * Signature contract (v2, current):
 *   X-DAM-Timestamp: <unix seconds>
 *   X-DAM-Signature: sha256=<hex> = HMAC-SHA256(secret, `${timestamp}.${body}`)
 *   X-DAM-Signature-V1: sha256=<hex> = HMAC-SHA256(secret, body)   [legacy]
 *
 * The timestamp is inside the signed material, so a receiver that checks the
 * timestamp against its own clock (a few minutes either way) cannot have a
 * captured delivery replayed at it later: the old signature still verifies,
 * but the timestamp it was signed with no longer does.
 *
 * The **raw body bytes** are what both signatures cover — the exact string
 * the receiver reads from the socket. Re-serializing the parsed JSON on the
 * receiver side produces a mismatch.
 *
 * V1 is shipped alongside V2 for as long as existing receivers need it: a
 * receiver verifies V2 first and falls back to the body-only form. New
 * receivers should check V2 and the timestamp.
 */

const crypto = require('crypto');
const http = require('http');
const https = require('https');
const { resolvePublicAddresses, bareHost, privateTargetsAllowed } = require('./net');
const { URL } = require('url');
const { nanoid } = require('nanoid');

// --- Tunables ---------------------------------------------------------------
const MAX_ATTEMPTS = 3; // total tries per dispatch (initial + 2 retries)
const BASE_BACKOFF_MS = 200; // backoff base; doubles each retry
const MAX_BACKOFF_MS = 5000; // upper bound for a single sleep
const REQUEST_TIMEOUT_MS = 5000; // per-attempt socket timeout

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
  // An ingest integration that pushes new metadata is not an admin edit: a
  // receiver subscribed to `asset.updated` should not have to guess whose
  // change it was.
  'asset.metadata_updated',
  'tenant.created',
  'tenant.updated',
];

// Status codes that are worth retrying. Everything else (incl. 4xx) is a
// deterministic client error and we stop retrying immediately.
function isRetryableStatus(status) {
  return status === 408 || status === 425 || status === 429 || (status >= 500 && status < 600);
}

/**
 * Compute the delivery signature and return **lowercase hex**.
 *
 * With a `timestamp` the signed material is `${timestamp}.${body}` — the v2
 * form, which cannot be replayed. Without one it is the body alone, which is
 * the v1 form; the dispatcher ships both so an un-upgraded receiver keeps
 * working.
 *
 * @param {string} secret endpoint secret
 * @param {string|Buffer} body raw body bytes that will be transmitted
 * @param {string|number} [timestamp] Unix seconds, included in the signature
 * @returns {string} lowercase hex digest (64 chars)
 */
function signPayload(secret, body, timestamp) {
  if (typeof secret !== 'string' || secret.length === 0) {
    throw new TypeError('signPayload: secret must be a non-empty string');
  }
  if (body === null || body === undefined) {
    throw new TypeError('signPayload: body must not be null/undefined');
  }
  const material =
    timestamp === undefined || timestamp === null ? body : `${timestamp}.${body}`;
  return crypto.createHmac('sha256', secret).update(material).digest('hex');
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
 * A resolver that answers only with an address that was already checked.
 *
 * The connection is pinned to the address the guard approved, so a name
 * that answers with a public address the first time and a private one the
 * second cannot get in: the socket never asks the resolver again.
 *
 * @param {Array<{address: string, family: number}>} addresses
 * @returns {(hostname: string, options: any, callback: Function) => void}
 */
function pinnedLookup(addresses) {
  return (hostname, options, callback) => {
    if (options && options.all) return callback(null, addresses);
    const entry = addresses[0];
    return callback(null, entry.address, entry.family);
  };
}

/**
 * POST `body` (string) to `url` with the given headers.
 * Resolves to {status, body} on completion. Never rejects for HTTP error
 * statuses — only for transport-layer failures (DNS, TLS, timeout, socket
 * hang up) and for a target the guard refuses. The receiver will inspect
 * `status` to decide retry semantics.
 *
 * @param {string} url absolute http(s) URL
 * @param {string} body raw body bytes (utf-8 string)
 * @param {Object} headers extra request headers
 * @param {number} timeoutMs per-attempt socket timeout
 * @returns {Promise<{status:number, body:string}>}
 */
async function httpPost(url, body, headers, timeoutMs) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch (e) {
    throw Object.assign(new Error(`invalid webhook url "${url}": ${e.message}`), { status: 400 });
  }
  const isHttps = parsed.protocol === 'https:';
  const lib = isHttps ? https : http;
  const port = parsed.port
    ? parseInt(parsed.port, 10)
    : (isHttps ? 443 : 80);

  // The endpoint URL is the server's own outbound request, so it gets the
  // same treatment as the "import by URL" feature: the host is resolved and
  // checked before the connection is made, and the connection is pinned to
  // the address that was checked.
  let lookup;
  if (!privateTargetsAllowed()) {
    const addresses = await resolvePublicAddresses(parsed.hostname);
    lookup = pinnedLookup(addresses);
  }

  return new Promise((resolve, reject) => {
    const req = lib.request({
      method: 'POST',
      hostname: bareHost(parsed.hostname),
      port,
      path: (parsed.pathname || '/') + (parsed.search || ''),
      headers: Object.assign(
        { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
        headers || {},
      ),
      timeout: timeoutMs,
      ...(lookup ? { lookup } : {}),
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
 * @param {{id: string, tenant_id?: string|null}} endpoint the endpoint the
 *        delivery belongs to — the log row is owned by its tenant
 * @param {string} event
 * @param {string} body the signed payload
 * The row's id is also the **delivery id** sent as `X-DAM-Delivery`, so a
 * receiver can name the delivery it is complaining about and the operator can
 * find the row. The id therefore has to exist before the request goes out:
 * the row is inserted up front as `pending` and updated with the outcome.
 *
 * @param {{status: string, attempts: number, error: string|null}} final
 * @param {string} deliveryId the id the row was inserted with
 * @returns {Promise<void>}
 */
async function recordLog(db, endpoint, event, body, final, deliveryId) {
  const endpointId = endpoint.id;
  try {
    await db
      .prepare(
        "UPDATE webhook_logs SET status = ?, attempts = ?, last_error = ? WHERE id = ? AND tenant_id = ?",
      )
      .run(final.status, final.attempts, final.error, deliveryId, endpoint.tenant_id || 'default');
  } catch (e) {
    // Visible, structured, contextual — never silent.
    console.error('[webhook] failed to update webhook_logs row', {
      endpointId,
      event,
      status: final.status,
      attempts: final.attempts,
      err: e.message,
    });
  }
}

/**
 * Reserve the delivery's log row.
 *
 * Written before the first attempt so its id can travel as `X-DAM-Delivery`.
 * A failure to reserve is not fatal — the delivery is still worth making —
 * but it is logged, because an untraceable delivery is a support problem.
 *
 * @param {object} db
 * @param {object} endpoint
 * @param {string} event
 * @param {string} body
 * @returns {Promise<string>} the delivery id
 */
async function openDelivery(db, endpoint, event, body) {
  const id = nanoid();
  try {
    await db
      .prepare(
        "INSERT INTO webhook_logs (id, tenant_id, endpoint_id, event, payload, status, attempts) VALUES (?, ?, ?, ?, ?, 'pending', 0)",
      )
      .run(id, endpoint.tenant_id || 'default', endpoint.id, event, body);
  } catch (e) {
    console.error('[webhook] failed to reserve webhook_logs row', {
      endpointId: endpoint.id,
      event,
      err: e.message,
    });
  }
  return id;
}

/**
 * Dispatch a webhook.
 *
 * @param {Object} db the database handle, with `webhook_logs` +
 *          `webhook_endpoints` tables
 * @param {Object} endpoint {id, url, secret, [name], [is_active]}
 * @param {string} event short event name (e.g. "asset.created")
 * @param {Object} payload JSON-serializable payload
 * @returns {Promise<{status:'done'|'failed', attempts:number, error:string|null,
 *                    deliveryId: string}>}
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

  // The delivery id names the log row, so it has to exist before the request
  // leaves: a receiver that reports a bad delivery quotes this id back.
  const deliveryId = await openDelivery(db, endpoint, event, body);

  // The timestamp is signed together with the body (v2). It is generated
  // once per dispatch, not per attempt: the retries are the same delivery,
  // and a receiver that deduplicates on `X-DAM-Delivery` sees one delivery.
  const timestamp = String(Math.floor(Date.now() / 1000));
  const headers = {
    'X-DAM-Signature': `sha256=${signPayload(endpoint.secret, body, timestamp)}`,
    // The body-only signature ships alongside for as long as receivers that
    // predate v2 need it; new receivers should verify the v2 header and the
    // timestamp instead.
    'X-DAM-Signature-V1': `sha256=${signPayload(endpoint.secret, body)}`,
    'X-DAM-Timestamp': timestamp,
    'X-DAM-Event': event,
    'X-DAM-Attempt': '1',
    'X-DAM-Delivery': deliveryId,
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
      // A refusal — a private address, a malformed URL — is not a transport
      // failure. The same request is refused again, so it is not retried.
      if (e && e.status) {
        console.error('[webhook] delivery refused', {
          endpointId: endpoint.id,
          event,
          attempt: attempts,
          err: lastError,
        });
        break;
      }
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

  // Persist the terminal state. The endpoint's `is_active` flag is *not*
  // touched here: it belongs to the operator (`DELETE /webhooks/:id`
  // soft-disables, `PUT /webhooks/:id` toggles), and a delivery that was
  // already in flight must not resurrect an endpoint the operator has
  // disabled. The delivery outcome lives in `webhook_logs`.
  await recordLog(db, endpoint, event, body, terminal, deliveryId);

  return { ...terminal, deliveryId };
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
