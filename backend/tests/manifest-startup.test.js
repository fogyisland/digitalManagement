const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const http = require('http');
const assert = require('assert');

const testDbPath = path.join(__dirname, 'test-manifest-startup.db');
const testStoragePath = path.join(__dirname, 'test-storage-manifest-startup');

try { fs.unlinkSync(testDbPath); } catch {}
try { fs.rmSync(testStoragePath, { recursive: true, force: true }); } catch {}

process.env.DB_PATH = testDbPath;
process.env.STORAGE_DIR = testStoragePath;
process.env.JWT_SECRET = 'test-secret-manifest';
process.env.PORT = '0'; // unused

const port = 18100 + Math.floor(Math.random() * 1000);
process.env.PORT = String(port);

const serverApp = require('../src/server');

const server = serverApp.listen(port, '127.0.0.1', async () => {
  try {
    // The server's seed block creates an admin + a couple of categories/tags.
    // Wait briefly for any pending manifest writes started by `require` to settle.
    // (setImmediate fires on the same tick; 100ms is plenty.)
    await new Promise(r => setTimeout(r, 250));

    // Now GET the static endpoint and verify status 200 + JSON parses.
    const fetchUrl = `http://127.0.0.1:${port}/storage/manifests/index.json`;
    const r = await new Promise((resolve, reject) => {
      http.get(fetchUrl, (res) => {
        let data = '';
        res.on('data', (chunk) => data += chunk);
        res.on('end', () => resolve({ statusCode: res.statusCode, body: data }));
        res.on('error', reject);
      }).on('error', reject);
    });

    assert.strictEqual(r.statusCode, 200, `expected 200, got ${r.statusCode}: ${r.body}`);
    const parsed = JSON.parse(r.body);
    assert.ok(parsed && typeof parsed === 'object', 'expected parsed JSON object');
    assert.strictEqual(typeof parsed.version, 'number', 'expected manifest.version to be a number');
    assert.strictEqual(typeof parsed.count, 'number', 'expected manifest.count to be a number');
    assert.ok(Array.isArray(parsed.assets), 'expected manifest.assets to be an array');

    console.log('manifest startup replay + static endpoint OK');
    cleanup();
  } catch (e) {
    console.error('TEST FAILED:', e.message);
    cleanup();
    process.exit(1);
  }
});

function cleanup() {
  server.close(() => {
    try { fs.unlinkSync(testDbPath); } catch {}
    try { fs.rmSync(testStoragePath, { recursive: true, force: true }); } catch {}
    process.exit(0);
  });
}