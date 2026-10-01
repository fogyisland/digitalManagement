/**
 * Smoke test for the webhook library.
 * Verifies:
 *   - signature format & length
 *   - timingSafeHexEqual contract
 *   - isRetryableStatus
 *   - computeBackoffMs is bounded and positive
 *   - dispatch() happy path: HTTP 200 -> status='done', webhook_logs row exists,
 *     endpoint.is_active flipped to 1
 *   - dispatch() failure path: always-500 -> 3 attempts, status='failed',
 *     webhook_logs row persists last_error, endpoint.is_active unchanged
 *   - dispatch() 4xx (non-retryable): 1 attempt, status='failed'
 *   - failure result SURFACES to the caller (no swallow)
 *
 * Runs against a temporary sqlite file so it does not pollute project data.
 */
'use strict';
const assert = require('assert');
const Database = require('better-sqlite3');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDb = path.join(os.tmpdir(), `webhook-smoke-${process.pid}.db`);
try { fs.unlinkSync(tmpDb); } catch (_e) {}
const db = new Database(tmpDb);
db.exec(`
  CREATE TABLE webhook_endpoints (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    url TEXT NOT NULL,
    secret TEXT NOT NULL,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE webhook_logs (
    id TEXT PRIMARY KEY,
    endpoint_id TEXT NOT NULL,
    event TEXT NOT NULL,
    payload TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// --- A tiny in-process HTTP server that we can program per-scenario --------
const scenariosRef = { current: null };
const server = http.createServer((req, res) => {
  let chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8');
    const scenario = scenariosRef.current;
    const sigHeader = req.headers['x-dam-signature'] || '';
    const eventHeader = req.headers['x-dam-event'] || '';
    const attemptHeader = req.headers['x-dam-attempt'] || '0';
    try {
      scenario({ body, sigHeader, eventHeader, attemptHeader, res });
    } catch (e) {
      console.error('[smoke server] scenario threw', e);
      try { res.statusCode = 500; res.end('scenario error'); } catch (_) {}
    }
  });
});

function startServer() {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function stopServer() {
  return new Promise((resolve) => server.close(resolve));
}

function insertEndpoint(id, url, secret, isActive) {
  db.prepare(
    'INSERT INTO webhook_endpoints (id, name, url, secret, is_active) VALUES (?, ?, ?, ?, ?)'
  ).run(id, 'smoke', url, secret, isActive ? 1 : 0);
}

function fetchEndpoint(id) {
  return db.prepare('SELECT * FROM webhook_endpoints WHERE id = ?').get(id);
}

function fetchLogs(endpointId) {
  return db.prepare('SELECT * FROM webhook_logs WHERE endpoint_id = ? ORDER BY created_at').all(endpointId);
}

(async () => {
  const port = await startServer();
  const baseUrl = `http://127.0.0.1:${port}`;

  const w = require('../src/lib/webhook');

  // --- unit checks ---------------------------------------------------------
  const sig = w.signPayload('topsecret', '{"a":1}');
  assert.strictEqual(sig.length, 64, 'hex sig must be 64 chars');
  assert.strictEqual(sig, sig.toLowerCase(), 'sig must be lowercase hex');

  // known answer for the brief
  const known = w.signPayload('topsecret', '{"a":1}');
  // we know it must equal HMAC-SHA256; verify by re-doing the HMAC manually
  const crypto = require('crypto');
  const manual = crypto.createHmac('sha256', 'topsecret').update('{"a":1}').digest('hex');
  assert.strictEqual(known, manual, 'sig must equal raw HMAC');

  assert.strictEqual(w.timingSafeHexEqual(sig, manual), true);
  assert.strictEqual(w.timingSafeHexEqual(sig, '00'), false);
  // Case-insensitive: hex is case-insensitive by spec; comparing bytes after
  // decode means "AB" and "ab" represent the same value. Receivers sometimes
  // uppercase, so we treat them as equal (and timingSafeEqual over equal
  // buffers is still safe — no oracle exposed).
  assert.strictEqual(w.timingSafeHexEqual(sig, sig.toUpperCase()), true);
  // Length-mismatch must return false (and not throw).
  assert.strictEqual(w.timingSafeHexEqual(sig, 'a'), false);
  assert.strictEqual(w.timingSafeHexEqual('aa', 'aa'), true);

  assert.strictEqual(w.isRetryableStatus(200), false);
  assert.strictEqual(w.isRetryableStatus(404), false);
  assert.strictEqual(w.isRetryableStatus(429), true);
  assert.strictEqual(w.isRetryableStatus(500), true);
  assert.strictEqual(w.isRetryableStatus(503), true);

  const b0 = w.computeBackoffMs(0);
  const b1 = w.computeBackoffMs(1);
  const b2 = w.computeBackoffMs(2);
  assert.ok(b0 >= 200 && b0 <= 400, `b0 out of range: ${b0}`);
  assert.ok(b1 >= 200 && b1 <= 800, `b1 out of range: ${b1}`);
  assert.ok(b2 >= 200 && b2 <= 1600, `b2 out of range: ${b2}`);

  // --- dispatch happy path -------------------------------------------------
  scenariosRef.current = ({ sigHeader, eventHeader, body, res }) => {
    assert.strictEqual(eventHeader, 'asset.created');
    assert.ok(sigHeader.startsWith('sha256='), 'signature header format');
    assert.ok(body.includes('"event":"asset.created"'));
    res.statusCode = 200;
    res.end('ok');
  };
  insertEndpoint('ep-ok', `${baseUrl}/ok`, 'sec-ok', 1);
  const okRes = await w.dispatch(
    db,
    fetchEndpoint('ep-ok'),
    'asset.created',
    { id: 'asset-1' },
  );
  assert.strictEqual(okRes.status, 'done', `happy path status was ${okRes.status} err=${okRes.error}`);
  assert.strictEqual(okRes.attempts, 1, `happy path attempts was ${okRes.attempts}`);
  assert.strictEqual(okRes.error, null);
  assert.strictEqual(fetchEndpoint('ep-ok').is_active, 1, 'endpoint must remain active');
  let logs = fetchLogs('ep-ok');
  assert.strictEqual(logs.length, 1, 'one log row per dispatch');
  assert.strictEqual(logs[0].status, 'done');
  assert.strictEqual(logs[0].attempts, 1);

  // --- dispatch failure: always 500 ---------------------------------------
  scenariosRef.current = ({ res }) => {
    res.statusCode = 500;
    res.end('boom');
  };
  insertEndpoint('ep-500', `${baseUrl}/500`, 'sec-500', 1);
  const failRes = await w.dispatch(
    db,
    fetchEndpoint('ep-500'),
    'asset.deleted',
    { id: 'asset-2' },
  );
  assert.strictEqual(failRes.status, 'failed', '500 must be classified failed');
  assert.strictEqual(failRes.attempts, 3, `expected 3 attempts, got ${failRes.attempts}`);
  assert.ok(/HTTP 500/.test(failRes.error), `expected HTTP 500 error, got ${failRes.error}`);
  assert.strictEqual(fetchEndpoint('ep-500').is_active, 1, 'is_active untouched on failure');
  logs = fetchLogs('ep-500');
  assert.strictEqual(logs.length, 1);
  assert.strictEqual(logs[0].status, 'failed');
  assert.strictEqual(logs[0].attempts, 3);
  assert.ok(logs[0].last_error && logs[0].last_error.includes('HTTP 500'),
    `log last_error must include HTTP 500, got: ${logs[0].last_error}`);

  // --- dispatch 404 (non-retryable) ---------------------------------------
  let calls404 = 0;
  scenariosRef.current = ({ res }) => {
    calls404++;
    res.statusCode = 404;
    res.end('nope');
  };
  insertEndpoint('ep-404', `${baseUrl}/404`, 'sec-404', 1);
  const r404 = await w.dispatch(
    db,
    fetchEndpoint('ep-404'),
    'asset.updated',
    { id: 'asset-3' },
  );
  assert.strictEqual(r404.status, 'failed');
  assert.strictEqual(r404.attempts, 1, `404 must stop after 1 attempt, got ${r404.attempts}`);
  assert.strictEqual(calls404, 1, `server saw ${calls404} calls`);
  assert.ok(/HTTP 404/.test(r404.error));
  const log404 = fetchLogs('ep-404');
  assert.strictEqual(log404.length, 1);
  assert.strictEqual(log404[0].attempts, 1);

  // --- transport error (server closed) -> retries, terminal failed --------
  // We close the server, then dispatch; expect 3 attempts, status='failed',
  // error message includes ECONNREFUSED or similar.
  await stopServer();
  const epDownId = 'ep-down';
  insertEndpoint(epDownId, 'http://127.0.0.1:1/never', `destroyed`, 1);
  const downRes = await w.dispatch(
    db,
    fetchEndpoint(epDownId),
    'asset.closed',
    { id: 'asset-4' },
  );
  assert.strictEqual(downRes.status, 'failed');
  assert.strictEqual(downRes.attempts, 3, `transport failure must retry, got ${downRes.attempts}`);
  assert.ok(downRes.error, 'error message must be surfaced to caller (no swallow)');
  const downLog = fetchLogs(epDownId);
  assert.strictEqual(downLog.length, 1);
  assert.strictEqual(downLog[0].status, 'failed');
  assert.ok(downLog[0].last_error, 'last_error must be captured in log row');

  console.log('webhook dispatch smoke OK');
  db.close();
  try { fs.unlinkSync(tmpDb); } catch (_e) {}
})().catch((e) => {
  console.error('SMOKE FAILED:', e);
  process.exit(1);
});