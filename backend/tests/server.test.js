const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const http = require('http');
const assert = require('assert');

// --- Step 1: Schema check ----------------------------------------------------
// Require the real server module with an isolated DB so it runs the full init
// path (CREATE TABLE block + idempotent ALTER TABLE loop + indexes + seed).
// We previously parsed `src/server.js` with a regex over `db.exec(\`...\`);`,
// but R2 split the schema into two blocks (initial CREATE + idempotent ALTER),
// so the regex captured only the first block and missed the columns added by
// migration. Using the real module exercises both blocks — if either is broken,
// the schema check fails. The required module leaves its `db` connection open
// for the lifetime of the Node process; we close it explicitly below before
// the upload + 413 + webhook tests spin up fresh server processes on different
// DB paths.
const schemaDbPath = path.join(__dirname, 'test-schema.db');
try { fs.unlinkSync(schemaDbPath); } catch {}
try { fs.unlinkSync(schemaDbPath + '-shm'); } catch {}
try { fs.unlinkSync(schemaDbPath + '-wal'); } catch {}
process.env.DB_PATH = schemaDbPath;
process.env.JWT_SECRET = 'test-secret-key';
process.env.STORAGE_DIR = path.join(__dirname, 'test-schema-storage');
try { fs.rmSync(process.env.STORAGE_DIR, { recursive: true, force: true }); } catch {}

// server.js's init also seeds default categories/tags and logs to stdout.
// We only care about schema correctness here, so we silence the module load
// by overriding console.log for the require() call and restoring it after.
const _origLog = console.log;
console.log = () => {};
require('../src/server');
console.log = _origLog;

const schemaDb = new Database(schemaDbPath, { readonly: true });
const cols = schemaDb.prepare("PRAGMA table_info(assets)").all().map(c => c.name);
['source_tool','prompt','seed','model_name','job_id','metadata_json'].forEach(c => {
  if (!cols.includes(c)) throw new Error('missing column: ' + c);
});

const tables = schemaDb.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(t=>t.name);
['webhook_endpoints','webhook_logs','manifest_writes'].forEach(t => {
  if (!tables.includes(t)) throw new Error('missing table: ' + t);
});

schemaDb.close();
try { fs.unlinkSync(schemaDbPath); } catch {}
try { fs.unlinkSync(schemaDbPath + '-shm'); } catch {}
try { fs.unlinkSync(schemaDbPath + '-wal'); } catch {}
try { fs.rmSync(process.env.STORAGE_DIR, { recursive: true, force: true }); } catch {}
// Drop the require cache so the upload test below can spin up its own
// server instance on a different DB path.
delete require.cache[require.resolve('../src/server')];
console.log('schema OK');

// --- Step 4: Upload endpoint test ---
// Start a temporary server with isolated DB + storage
const port = 18000 + Math.floor(Math.random() * 1000);
process.env.PORT = String(port);
const testDbPath = path.join(__dirname, 'test-upload.db');
const testStoragePath = path.join(__dirname, 'test-storage');
process.env.DB_PATH = testDbPath;
process.env.STORAGE_DIR = testStoragePath;
process.env.JWT_SECRET = 'test-secret-key';

try { fs.unlinkSync(testDbPath); } catch {}
try { fs.rmSync(testStoragePath, { recursive: true, force: true }); } catch {}

const jwt = require('jsonwebtoken');
const serverApp = require('../src/server');

// serverApp is the Express app; start listening
const server = serverApp.listen(port, '127.0.0.1', async () => {
  try {
    // Create admin user via direct DB access (seed runs on require, so admin exists)
    const testDb = new Database(testDbPath);
    const admin = testDb.prepare("SELECT id FROM users WHERE username='admin'").get();
    testDb.close();

    if (!admin) throw new Error('admin user not seeded');

    // Mint a JWT token for admin
    const token = jwt.sign({ sub: admin.id, role: 'admin' }, 'test-secret-key', { expiresIn: '1h' });

    // Build multipart form-data with a small image and extra fields
    const boundary = '----testboundary' + Date.now();
    const fileBuf = Buffer.from([
      0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A,
      0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52,
      0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
      0x08, 0x06, 0x00, 0x00, 0x00, 0x1F, 0x15, 0xC4,
      0x89, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x44, 0x41,
      0x54, 0x78, 0x9C, 0x62, 0x00, 0x01, 0x00, 0x00,
      0x05, 0x00, 0x01, 0x0D, 0x0A, 0x2D, 0xB4, 0x00,
      0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE,
      0x42, 0x60, 0x82,
    ]);

    const parts = [];
    parts.push(Buffer.from(`--${boundary}\r\n`));
    parts.push(Buffer.from('Content-Disposition: form-data; name="files"; filename="test.png"\r\n'));
    parts.push(Buffer.from('Content-Type: image/png\r\n\r\n'));
    parts.push(fileBuf);
    parts.push(Buffer.from('\r\n'));
    parts.push(Buffer.from(`--${boundary}\r\n`));
    parts.push(Buffer.from('Content-Disposition: form-data; name="source_tool"\r\n\r\n'));
    parts.push(Buffer.from('comfyui'));
    parts.push(Buffer.from('\r\n'));
    parts.push(Buffer.from(`--${boundary}\r\n`));
    parts.push(Buffer.from('Content-Disposition: form-data; name="prompt"\r\n\r\n'));
    parts.push(Buffer.from('a beautiful sunset over mountains'));
    parts.push(Buffer.from('\r\n'));
    parts.push(Buffer.from(`--${boundary}\r\n`));
    parts.push(Buffer.from('Content-Disposition: form-data; name="seed"\r\n\r\n'));
    parts.push(Buffer.from('42'));
    parts.push(Buffer.from('\r\n'));
    parts.push(Buffer.from(`--${boundary}\r\n`));
    parts.push(Buffer.from('Content-Disposition: form-data; name="model_name"\r\n\r\n'));
    parts.push(Buffer.from('sdxl-1.0'));
    parts.push(Buffer.from('\r\n'));
    parts.push(Buffer.from(`--${boundary}\r\n`));
    parts.push(Buffer.from('Content-Disposition: form-data; name="job_id"\r\n\r\n'));
    parts.push(Buffer.from('job-abc-123'));
    parts.push(Buffer.from('\r\n'));
    parts.push(Buffer.from(`--${boundary}\r\n`));
    parts.push(Buffer.from('Content-Disposition: form-data; name="metadata"\r\n\r\n'));
    parts.push(Buffer.from('{"steps":30,"cfg":7.5}'));
    parts.push(Buffer.from('\r\n'));
    parts.push(Buffer.from(`--${boundary}--\r\n`));

    const body = Buffer.concat(parts);

    const req = http.request({
      hostname: '127.0.0.1',
      port: port,
      path: '/api/v1/assets/upload',
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': body.length,
        'Authorization': `Bearer ${token}`,
      },
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          assert.strictEqual(res.statusCode, 201, `expected 201, got ${res.statusCode}: ${data}`);
          const parsed = JSON.parse(data);
          assert.strictEqual(parsed.count, 1, `expected count=1, got ${parsed.count}`);
          assert.strictEqual(parsed.items.length, 1, `expected items.length=1, got ${parsed.items.length}`);

          const asset = parsed.items[0];
          assert.strictEqual(asset.prompt, 'a beautiful sunset over mountains', `expected prompt echo, got ${asset.prompt}`);
          assert.strictEqual(asset.seed, 42, `expected seed=42, got ${asset.seed}`);
          assert.strictEqual(asset.job_id, 'job-abc-123', `expected job_id echo, got ${asset.job_id}`);
          assert.strictEqual(asset.source_tool, 'comfyui', `expected source_tool echo, got ${asset.source_tool}`);
          assert.strictEqual(asset.model_name, 'sdxl-1.0', `expected model_name echo, got ${asset.model_name}`);
          assert.ok(asset.metadata_json, 'expected metadata_json to be set');
          const meta = JSON.parse(asset.metadata_json);
          assert.strictEqual(meta.steps, 30, `expected metadata.steps=30, got ${meta.steps}`);

          console.log('upload endpoint OK');
          cleanup(server, testDbPath, testStoragePath);
        } catch (e) {
          console.error('TEST FAILED:', e.message);
          cleanup(server, testDbPath, testStoragePath);
          process.exit(1);
        }
      });
    });

    req.on('error', (e) => {
      console.error('REQUEST ERROR:', e.message);
      cleanup(server, testDbPath, testStoragePath);
      process.exit(1);
    });

    req.write(body);
    req.end();
  } catch (e) {
    console.error('TEST SETUP ERROR:', e.message);
    cleanup(server, testDbPath, testStoragePath);
    process.exit(1);
  }
});

// --- Step 5: 413 large file rejection test ---
// Reconfigure to a small limit so we can trigger LIMIT_FILE_SIZE without sending huge payloads.
server.close(() => {
  // Use a fresh DB path so server.js re-runs its full schema (includes ALTER TABLE ADD COLUMN)
  // without colliding with the first-test DB that better-sqlite3 still has open.
  const testDbPath413 = path.join(__dirname, 'test-upload-413.db');
  const testStoragePath413 = path.join(__dirname, 'test-storage-413');
  try { fs.unlinkSync(testDbPath413); } catch {}
  try { fs.unlinkSync(testDbPath413 + '-shm'); } catch {}
  try { fs.unlinkSync(testDbPath413 + '-wal'); } catch {}
  try { fs.rmSync(testStoragePath413, { recursive: true, force: true }); } catch {}

  process.env.DB_PATH = testDbPath413;
  process.env.STORAGE_DIR = testStoragePath413;

  const smallLimitMb = 1; // 1 MiB
  process.env.UPLOAD_MAX_FILE_SIZE_MB = String(smallLimitMb);
  // Re-require server.js with new env so the new limit is honored.
  delete require.cache[require.resolve('../src/server')];
  const serverApp413 = require('../src/server');

  const port413 = 18000 + Math.floor(Math.random() * 1000);
  const server413 = serverApp413.listen(port413, '127.0.0.1', async () => {
    try {
      const testDb = new Database(testDbPath413);
      const admin = testDb.prepare("SELECT id FROM users WHERE username='admin'").get();
      testDb.close();

      const token = jwt.sign({ sub: admin.id, role: 'admin' }, 'test-secret-key', { expiresIn: '1h' });

      // Build a payload larger than 1 MiB (slightly over to be safe).
      const oversizedPayload = Buffer.alloc((smallLimitMb * 1024 * 1024) + (64 * 1024), 0x41); // 1 MiB + 64 KiB

      const boundary = '----testboundary413' + Date.now();
      const parts = [];
      parts.push(Buffer.from(`--${boundary}\r\n`));
      parts.push(Buffer.from('Content-Disposition: form-data; name="files"; filename="big.bin"\r\n'));
      parts.push(Buffer.from('Content-Type: application/octet-stream\r\n\r\n'));
      parts.push(oversizedPayload);
      parts.push(Buffer.from('\r\n'));
      parts.push(Buffer.from(`--${boundary}\r\n`));
      parts.push(Buffer.from('Content-Disposition: form-data; name="source_tool"\r\n\r\n'));
      parts.push(Buffer.from('comfyui'));
      parts.push(Buffer.from('\r\n'));
      parts.push(Buffer.from(`--${boundary}--\r\n`));

      const body = Buffer.concat(parts);

      const req = http.request({
        hostname: '127.0.0.1',
        port: port413,
        path: '/api/v1/assets/upload',
        method: 'POST',
        headers: {
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': body.length,
          'Authorization': `Bearer ${token}`,
        },
      }, (res) => {
        let data = '';
        res.on('data', (chunk) => data += chunk);
        res.on('end', () => {
          try {
            assert.strictEqual(res.statusCode, 413, `expected 413, got ${res.statusCode}: ${data}`);
            const parsed = JSON.parse(data);
            assert.strictEqual(parsed.code, 'FILE_TOO_LARGE', `expected code=FILE_TOO_LARGE, got ${parsed.code}`);
            assert.ok(parsed.request_id, 'expected request_id to be set');
            console.log('413 file size limit OK');
            runWebhookTest();
          } catch (e) {
            console.error('TEST FAILED (413):', e.message);
            cleanup(server413, testDbPath413, testStoragePath413);
            process.exit(1);
          }
        });
      });

      req.on('error', (e) => {
        console.error('REQUEST ERROR (413):', e.message);
        cleanup(server413, testDbPath413, testStoragePath413);
        process.exit(1);
      });

      req.write(body);
      req.end();
    } catch (e) {
      console.error('TEST SETUP ERROR (413):', e.message);
      cleanup(server413, testDbPath413, testStoragePath413);
      process.exit(1);
    }
  });
});

// --- Step 7: Webhook CRUD + asset event dispatch test ----------------------
// Starts a tiny HTTP capture server, configures server.js with isolated DB +
// storage, then exercises:
//   - POST /api/v1/webhooks  -> 201 + secret in body
//   - GET  /api/v1/webhooks  -> list contains the new endpoint, is_active=true
//   - POST /api/v1/assets/upload -> webhook_logs gains a row with
//     event='asset.created' and signed envelope payload
//   - DELETE /api/v1/webhooks/:id -> 204, endpoint.is_active flipped to 0
//   - PUT /api/v1/assets/:id + DELETE /api/v1/assets/:id -> webhook_logs grows
function runWebhookTest() {
  const testDbPathWH = path.join(__dirname, 'test-webhook.db');
  const testStoragePathWH = path.join(__dirname, 'test-storage-webhook');
  try { fs.unlinkSync(testDbPathWH); } catch {}
  try { fs.unlinkSync(testDbPathWH + '-shm'); } catch {}
  try { fs.unlinkSync(testDbPathWH + '-wal'); } catch {}
  try { fs.rmSync(testStoragePathWH, { recursive: true, force: true }); } catch {}

  // Restore default upload limit so this test can upload a small image.
  delete process.env.UPLOAD_MAX_FILE_SIZE_MB;
  process.env.DB_PATH = testDbPathWH;
  process.env.STORAGE_DIR = testStoragePathWH;

  delete require.cache[require.resolve('../src/server')];
  const serverAppWH = require('../src/server');

  // --- Tiny HTTP capture server: records calls, returns 200 ---------------
  const captureRef = { calls: [] };
  const captureServer = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      captureRef.calls.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      });
      res.statusCode = 200;
      res.end('ok');
    });
  });

  function startCapture() {
    return new Promise((resolve) => {
      captureServer.listen(0, '127.0.0.1', () => resolve(captureServer.address().port));
    });
  }
  function stopCapture() {
    return new Promise((resolve) => captureServer.close(resolve));
  }

  startCapture().then((capturePort) => {
    const webhookUrl = `http://127.0.0.1:${capturePort}/hook`;

    const portWH = 18000 + Math.floor(Math.random() * 1000);
    const serverWH = serverAppWH.listen(portWH, '127.0.0.1', async () => {
      try {
        const testDb = new Database(testDbPathWH);
        const admin = testDb.prepare("SELECT id FROM users WHERE username='admin'").get();
        testDb.close();

        if (!admin) throw new Error('admin user not seeded');

        const token = jwt.sign({ sub: admin.id, role: 'admin' }, 'test-secret-key', { expiresIn: '1h' });
        const authHeaders = (extra) => Object.assign({ 'Authorization': `Bearer ${token}` }, extra || {});

        // --- 1) POST /api/v1/webhooks ------------------------------------
        const created = await jsonRequest({
          hostname: '127.0.0.1', port: portWH, path: '/api/v1/webhooks', method: 'POST',
          headers: authHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({ name: 'CaptureHook', url: webhookUrl }),
        });
        assert.strictEqual(created.status, 201,
          `POST /api/v1/webhooks expected 201, got ${created.status}: ${created.raw}`);
        const createdBody = JSON.parse(created.raw);
        assert.ok(createdBody.id, 'webhook id missing');
        assert.ok(createdBody.secret && /^[0-9a-f]{48}$/.test(createdBody.secret),
          `webhook secret must be 48-char lowercase hex, got: ${createdBody.secret}`);
        assert.strictEqual(createdBody.url, webhookUrl, 'webhook url echo mismatch');
        assert.ok(createdBody.warning, 'POST response must include save-secret warning');

        // --- 2) GET /api/v1/webhooks -------------------------------------
        const listed = await jsonRequest({
          hostname: '127.0.0.1', port: portWH, path: '/api/v1/webhooks', method: 'GET',
          headers: authHeaders(),
        });
        assert.strictEqual(listed.status, 200,
          `GET /api/v1/webhooks expected 200, got ${listed.status}: ${listed.raw}`);
        const listedBody = JSON.parse(listed.raw);
        assert.ok(Array.isArray(listedBody) && listedBody.length === 1,
          `expected 1 webhook in list, got ${listedBody.length}`);
        assert.strictEqual(listedBody[0].id, createdBody.id, 'webhook id mismatch');
        assert.strictEqual(listedBody[0].is_active, true, 'webhook must default to active');
        assert.ok(!('secret' in listedBody[0]), 'GET must not leak secret');

        // --- 3) Upload asset -> assert webhook_logs gains a row ---------
        const boundary = '----whboundary' + Date.now();
        const fileBuf = Buffer.from([
          0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A,
          0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52,
          0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
          0x08, 0x06, 0x00, 0x00, 0x00, 0x1F, 0x15, 0xC4,
          0x89, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x44, 0x41,
          0x54, 0x78, 0x9C, 0x62, 0x00, 0x01, 0x00, 0x00,
          0x05, 0x00, 0x01, 0x0D, 0x0A, 0x2D, 0xB4, 0x00,
          0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE,
          0x42, 0x60, 0x82,
        ]);
        const parts = [];
        parts.push(Buffer.from(`--${boundary}\r\n`));
        parts.push(Buffer.from('Content-Disposition: form-data; name="files"; filename="wh.png"\r\n'));
        parts.push(Buffer.from('Content-Type: image/png\r\n\r\n'));
        parts.push(fileBuf);
        parts.push(Buffer.from('\r\n'));
        parts.push(Buffer.from(`--${boundary}\r\n`));
        parts.push(Buffer.from('Content-Disposition: form-data; name="source_tool"\r\n\r\n'));
        parts.push(Buffer.from('test'));
        parts.push(Buffer.from('\r\n'));
        parts.push(Buffer.from(`--${boundary}--\r\n`));
        const uploadBody = Buffer.concat(parts);

        const uploadRes = await jsonRequest({
          hostname: '127.0.0.1', port: portWH, path: '/api/v1/assets/upload', method: 'POST',
          headers: authHeaders({
            'Content-Type': `multipart/form-data; boundary=${boundary}`,
            'Content-Length': uploadBody.length,
          }),
          body: uploadBody,
          binary: true,
        });
        assert.strictEqual(uploadRes.status, 201,
          `upload expected 201, got ${uploadRes.status}: ${uploadRes.raw}`);
        const uploadBodyParsed = JSON.parse(uploadRes.raw);
        assert.strictEqual(uploadBodyParsed.count, 1, `expected count=1, got ${uploadBodyParsed.count}`);
        const createdAsset = uploadBodyParsed.items[0];
        assert.ok(createdAsset.id, 'uploaded asset must have id');

        // Wait for the async webhook dispatch to settle (dispatch has 3 retries,
        // up to ~5s of backoff). Poll webhook_logs instead of fixed sleep.
        await waitFor(async () => {
          const dbx = new Database(testDbPathWH, { readonly: true });
          const row = dbx.prepare(
            "SELECT id, status, attempts, payload, event FROM webhook_logs WHERE endpoint_id = ?"
          ).get(createdBody.id);
          dbx.close();
          return row && row.status === 'done';
        }, 10000, 'webhook_logs row for asset.created');

        // Verify the persisted log row.
        const whDb = new Database(testDbPathWH, { readonly: true });
        const logRow = whDb.prepare(
          "SELECT status, attempts, payload, event FROM webhook_logs WHERE endpoint_id = ?"
        ).get(createdBody.id);
        whDb.close();
        assert.ok(logRow, 'webhook_logs row missing for endpoint');
        assert.strictEqual(logRow.event, 'asset.created', `expected event=asset.created, got ${logRow.event}`);
        assert.strictEqual(logRow.status, 'done', `expected status=done, got ${logRow.status}`);
        // payload column stores the signed envelope {event, payload, ts}.
        const env = JSON.parse(logRow.payload);
        assert.strictEqual(env.event, 'asset.created', 'envelope.event must match');
        assert.ok(env.payload && env.payload.id === createdAsset.id,
          'envelope.payload must echo asset id');
        assert.ok(env.ts, 'envelope.ts must be set');

        // Verify the capture server actually received the POST.
        const assetCreatedCall = captureRef.calls.find(
          (c) => c.method === 'POST' && c.url === '/hook'
        );
        assert.ok(assetCreatedCall, 'capture server did not receive the POST');
        assert.ok((assetCreatedCall.headers['x-dam-signature'] || '').startsWith('sha256='),
          'missing X-DAM-Signature header');
        assert.strictEqual(assetCreatedCall.headers['x-dam-event'], 'asset.created',
          'missing X-DAM-Event header');

        // --- 4) PUT asset -> webhook 'asset.updated' --------------------
        const putRes = await jsonRequest({
          hostname: '127.0.0.1', port: portWH,
          path: `/api/v1/assets/${createdAsset.id}`, method: 'PUT',
          headers: authHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({ title: 'Renamed by webhook test' }),
        });
        assert.strictEqual(putRes.status, 200,
          `PUT expected 200, got ${putRes.status}: ${putRes.raw}`);

        await waitFor(async () => {
          const dbx = new Database(testDbPathWH, { readonly: true });
          const row = dbx.prepare(
            "SELECT COUNT(*) AS c FROM webhook_logs WHERE endpoint_id = ? AND event = 'asset.updated'"
          ).get(createdBody.id);
          dbx.close();
          return row.c >= 1;
        }, 10000, 'webhook_logs row for asset.updated');

        // --- 5) DELETE asset -> webhook 'asset.deleted' -----------------
        const delRes = await jsonRequest({
          hostname: '127.0.0.1', port: portWH,
          path: `/api/v1/assets/${createdAsset.id}`, method: 'DELETE',
          headers: authHeaders(),
        });
        assert.strictEqual(delRes.status, 204,
          `DELETE expected 204, got ${delRes.status}: ${delRes.raw}`);

        await waitFor(async () => {
          const dbx = new Database(testDbPathWH, { readonly: true });
          const row = dbx.prepare(
            "SELECT COUNT(*) AS c FROM webhook_logs WHERE endpoint_id = ? AND event = 'asset.deleted'"
          ).get(createdBody.id);
          dbx.close();
          return row.c >= 1;
        }, 10000, 'webhook_logs row for asset.deleted');

        // --- 6) DELETE /api/v1/webhooks/:id (soft-disable) ---------------
        const delHook = await jsonRequest({
          hostname: '127.0.0.1', port: portWH,
          path: `/api/v1/webhooks/${createdBody.id}`, method: 'DELETE',
          headers: authHeaders(),
        });
        assert.strictEqual(delHook.status, 204,
          `DELETE webhook expected 204, got ${delHook.status}: ${delHook.raw}`);

        const dbFinal = new Database(testDbPathWH, { readonly: true });
        const epFinal = dbFinal.prepare(
          "SELECT is_active FROM webhook_endpoints WHERE id = ?"
        ).get(createdBody.id);
        dbFinal.close();
        assert.strictEqual(epFinal.is_active, 0, 'DELETE webhook must soft-disable');

        // After soft-disable, uploading again must NOT enqueue a new log row.
        const callsBefore = captureRef.calls.length;
        const logCountBefore = await (async () => {
          const dbx = new Database(testDbPathWH, { readonly: true });
          const row = dbx.prepare(
            "SELECT COUNT(*) AS c FROM webhook_logs WHERE endpoint_id = ?"
          ).get(createdBody.id);
          dbx.close();
          return row.c;
        })();

        const parts2 = [];
        parts2.push(Buffer.from(`--${boundary}\r\n`));
        parts2.push(Buffer.from('Content-Disposition: form-data; name="files"; filename="wh2.png"\r\n'));
        parts2.push(Buffer.from('Content-Type: image/png\r\n\r\n'));
        parts2.push(fileBuf);
        parts2.push(Buffer.from('\r\n'));
        parts2.push(Buffer.from(`--${boundary}--\r\n`));
        const uploadBody2 = Buffer.concat(parts2);
        await jsonRequest({
          hostname: '127.0.0.1', port: portWH, path: '/api/v1/assets/upload', method: 'POST',
          headers: authHeaders({
            'Content-Type': `multipart/form-data; boundary=${boundary}`,
            'Content-Length': uploadBody2.length,
          }),
          body: uploadBody2, binary: true,
        });
        await sleep(500);
        const logCountAfter = await (async () => {
          const dbx = new Database(testDbPathWH, { readonly: true });
          const row = dbx.prepare(
            "SELECT COUNT(*) AS c FROM webhook_logs WHERE endpoint_id = ?"
          ).get(createdBody.id);
          dbx.close();
          return row.c;
        })();
        assert.strictEqual(logCountAfter, logCountBefore,
          `disabled endpoint must NOT emit; before=${logCountBefore} after=${logCountAfter}`);

        console.log('webhook CRUD + asset event dispatch OK');
        await stopCapture();
        cleanup(serverWH, testDbPathWH, testStoragePathWH);
      } catch (e) {
        console.error('TEST FAILED (webhook):', e.message);
        await stopCapture().catch(() => {});
        cleanup(serverWH, testDbPathWH, testStoragePathWH);
        process.exit(1);
      }
    });
  });
}

function jsonRequest(opts) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: opts.hostname,
      port: opts.port,
      path: opts.path,
      method: opts.method,
      headers: opts.headers,
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode, raw });
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    if (opts.body !== undefined && opts.body !== null) {
      if (opts.binary) {
        req.write(opts.body);
      } else {
        req.write(typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body));
      }
    }
    req.end();
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, timeoutMs, label) {
  const start = Date.now();
  let lastErr = null;
  while (Date.now() - start < timeoutMs) {
    try {
      const ok = await predicate();
      if (ok) return;
    } catch (e) {
      lastErr = e;
    }
    await sleep(100);
  }
  const tail = lastErr ? ` (last err: ${lastErr.message})` : '';
  throw new Error(`waitFor timeout (${timeoutMs}ms): ${label}${tail}`);
}

function cleanup(server, dbPath, storagePath) {
  server.close(() => {
    try { fs.unlinkSync(dbPath); } catch {}
    try { fs.rmSync(storagePath, { recursive: true, force: true }); } catch {}
    process.exit(0);
  });
}