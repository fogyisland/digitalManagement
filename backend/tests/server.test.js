const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const http = require('http');
const assert = require('assert');

const tmp = path.join(__dirname, 'tmp.db');
try { fs.unlinkSync(tmp); } catch {}
const db = new Database(tmp);
const schemaPath = path.join(__dirname, '..', 'src', 'server.js');
const src = fs.readFileSync(schemaPath, 'utf8');
const m = src.match(/db\.exec\(`([\s\S]*?)`\);/);
db.exec(m[1]);

const cols = db.prepare("PRAGMA table_info(assets)").all().map(c => c.name);
['source_tool','prompt','seed','model_name','job_id','metadata_json'].forEach(c => {
  if (!cols.includes(c)) throw new Error('missing column: ' + c);
});

const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(t=>t.name);
['webhook_endpoints','webhook_logs','manifest_writes'].forEach(t => {
  if (!tables.includes(t)) throw new Error('missing table: ' + t);
});

console.log('schema OK');
db.close();
fs.unlinkSync(tmp);

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
            cleanup(server413, testDbPath413, testStoragePath413);
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

function cleanup(server, dbPath, storagePath) {
  server.close(() => {
    try { fs.unlinkSync(dbPath); } catch {}
    try { fs.rmSync(storagePath, { recursive: true, force: true }); } catch {}
    process.exit(0);
  });
}