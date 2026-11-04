/**
 * Smoke test for the webhook library.
 * Verifies:
 *   - signature format & length
 *   - timingSafeHexEqual contract
 *   - isRetryableStatus
 *   - computeBackoffMs is bounded and positive
 *   - dispatch() happy path: HTTP 200 -> status='done', webhook_logs row exists,
 *     endpoint.is_active untouched (the operator owns that flag)
 *   - dispatch() failure path: always-500 -> 3 attempts, status='failed',
 *     webhook_logs row persists last_error, endpoint.is_active unchanged
 *   - dispatch() 4xx (non-retryable): 1 attempt, status='failed'
 *   - dispatch() must NOT re-enable an endpoint the operator disabled
 *   - failure result SURFACES to the caller (no swallow)
 *
 * Runs against a temporary sqlite file so it does not pollute project data.
 */
'use strict';
const assert = require('assert');
const http = require('http');
const mysql = require('mysql2/promise');
const path = require('path');

const { createDb, createPool } = require('../../src/server/lib/db');
const { getConfig } = require('../../src/server/config');

const dbName = `dam_test_webhook_smoke_${process.pid}`;

/** The database handle — created by `setupDatabase()`. */
let db = null;

/**
 * Create the throw-away schema and the two tables the smoke test needs.
 *
 * @returns {Promise<void>}
 */
async function setupDatabase() {
  const config = getConfig();
  const connection = await mysql.createConnection({
    host: config.dbHost,
    port: config.dbPort,
    user: config.dbUser,
    password: config.dbPassword,
    charset: 'utf8mb4_unicode_ci',
  });
  try {
    await connection.query(`DROP DATABASE IF EXISTS \`${dbName}\``);
    await connection.query(
      `CREATE DATABASE \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    );
  } finally {
    await connection.end();
  }

  db = createDb(createPool({ ...config, dbName }));
  await db.exec(`
    CREATE TABLE webhook_endpoints (
      id VARCHAR(64) NOT NULL PRIMARY KEY,
      tenant_id VARCHAR(64) NOT NULL DEFAULT 'default',
      name VARCHAR(191) NOT NULL,
      url VARCHAR(1024) NOT NULL,
      secret VARCHAR(191) NOT NULL,
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  await db.exec(`
    CREATE TABLE webhook_logs (
      id VARCHAR(64) NOT NULL PRIMARY KEY,
      tenant_id VARCHAR(64) NOT NULL DEFAULT 'default',
      endpoint_id VARCHAR(64) NOT NULL,
      event VARCHAR(191) NOT NULL,
      payload TEXT NOT NULL,
      status VARCHAR(32) NOT NULL DEFAULT 'pending',
      attempts INT NOT NULL DEFAULT 0,
      last_error TEXT,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
}

/**
 * Drop the throw-away schema.
 *
 * @returns {Promise<void>}
 */
async function dropDatabase() {
  const config = getConfig();
  const connection = await mysql.createConnection({
    host: config.dbHost,
    port: config.dbPort,
    user: config.dbUser,
    password: config.dbPassword,
    charset: 'utf8mb4_unicode_ci',
  });
  try {
    await connection.query(`DROP DATABASE IF EXISTS \`${dbName}\``);
  } finally {
    await connection.end();
  }
}

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

async function insertEndpoint(id, url, secret, isActive) {
  await db
    .prepare(
      'INSERT INTO webhook_endpoints (id, name, url, secret, is_active) VALUES (?, ?, ?, ?, ?)'
    )
    .run(id, 'smoke', url, secret, isActive ? 1 : 0);
}

async function fetchEndpoint(id) {
  return db.prepare('SELECT * FROM webhook_endpoints WHERE id = ?').get(id);
}

async function fetchLogs(endpointId) {
  return db.prepare('SELECT * FROM webhook_logs WHERE endpoint_id = ? ORDER BY created_at').all(endpointId);
}

(async () => {
  await setupDatabase();
  const port = await startServer();
  const baseUrl = `http://127.0.0.1:${port}`;

  const w = require('../../src/server/lib/webhook');

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
  await insertEndpoint('ep-ok', `${baseUrl}/ok`, 'sec-ok', 1);
  const okRes = await w.dispatch(
    db,
    await fetchEndpoint('ep-ok'),
    'asset.created',
    { id: 'asset-1' },
  );
  assert.strictEqual(okRes.status, 'done', `happy path status was ${okRes.status} err=${okRes.error}`);
  assert.strictEqual(okRes.attempts, 1, `happy path attempts was ${okRes.attempts}`);
  assert.strictEqual(okRes.error, null);
  assert.strictEqual((await fetchEndpoint('ep-ok')).is_active, 1, 'endpoint must remain active');
  let logs = await fetchLogs('ep-ok');
  assert.strictEqual(logs.length, 1, 'one log row per dispatch');
  assert.strictEqual(logs[0].status, 'done');
  assert.strictEqual(logs[0].attempts, 1);

  // --- dispatch failure: always 500 ---------------------------------------
  scenariosRef.current = ({ res }) => {
    res.statusCode = 500;
    res.end('boom');
  };
  await insertEndpoint('ep-500', `${baseUrl}/500`, 'sec-500', 1);
  const failRes = await w.dispatch(
    db,
    await fetchEndpoint('ep-500'),
    'asset.deleted',
    { id: 'asset-2' },
  );
  assert.strictEqual(failRes.status, 'failed', '500 must be classified failed');
  assert.strictEqual(failRes.attempts, 3, `expected 3 attempts, got ${failRes.attempts}`);
  assert.ok(/HTTP 500/.test(failRes.error), `expected HTTP 500 error, got ${failRes.error}`);
  assert.strictEqual((await fetchEndpoint('ep-500')).is_active, 1, 'is_active untouched on failure');
  logs = await fetchLogs('ep-500');
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
  await insertEndpoint('ep-404', `${baseUrl}/404`, 'sec-404', 1);
  const r404 = await w.dispatch(
    db,
    await fetchEndpoint('ep-404'),
    'asset.updated',
    { id: 'asset-3' },
  );
  assert.strictEqual(r404.status, 'failed');
  assert.strictEqual(r404.attempts, 1, `404 must stop after 1 attempt, got ${r404.attempts}`);
  assert.strictEqual(calls404, 1, `server saw ${calls404} calls`);
  assert.ok(/HTTP 404/.test(r404.error));
  const log404 = await fetchLogs('ep-404');
  assert.strictEqual(log404.length, 1);
  assert.strictEqual(log404[0].attempts, 1);

  // --- a delivery must not re-enable a disabled endpoint -------------------
  // The endpoint's enabled flag belongs to the operator: `DELETE /webhooks/:id`
  // soft-disables it and `PUT /webhooks/:id` toggles it. A delivery that was
  // already in flight when the operator disabled the endpoint must not
  // resurrect it — otherwise a soft-disable silently comes back to life.
  scenariosRef.current = ({ res }) => {
    res.statusCode = 200;
    res.end('ok');
  };
  await insertEndpoint('ep-off', `${baseUrl}/ok`, 'sec-off', 0);
  const offRes = await w.dispatch(
    db,
    await fetchEndpoint('ep-off'),
    'asset.created',
    { id: 'asset-5' },
  );
  assert.strictEqual(offRes.status, 'done', `expected done, got ${offRes.status} err=${offRes.error}`);
  assert.strictEqual(
    (await fetchEndpoint('ep-off')).is_active,
    0,
    'a delivery must not re-enable an endpoint the operator disabled',
  );

  // --- transport error (server closed) -> retries, terminal failed --------
  // We close the server, then dispatch; expect 3 attempts, status='failed',
  // error message includes ECONNREFUSED or similar.
  await stopServer();
  const epDownId = 'ep-down';
  await insertEndpoint(epDownId, 'http://127.0.0.1:1/never', `destroyed`, 1);
  const downRes = await w.dispatch(
    db,
    await fetchEndpoint(epDownId),
    'asset.closed',
    { id: 'asset-4' },
  );
  assert.strictEqual(downRes.status, 'failed');
  assert.strictEqual(downRes.attempts, 3, `transport failure must retry, got ${downRes.attempts}`);
  assert.ok(downRes.error, 'error message must be surfaced to caller (no swallow)');
  const downLog = await fetchLogs(epDownId);
  assert.strictEqual(downLog.length, 1);
  assert.strictEqual(downLog[0].status, 'failed');
  assert.ok(downLog[0].last_error, 'last_error must be captured in log row');

  console.log('webhook dispatch smoke OK');
  await db.pool.end();
  await dropDatabase();
})().catch((e) => {
  console.error('SMOKE FAILED:', e);
  process.exit(1);
});