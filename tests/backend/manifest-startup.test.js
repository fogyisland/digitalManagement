'use strict';

/**
 * Manifest startup test.
 *
 * The server writes the manifest index when it boots. The test boots the
 * real server against a throw-away MySQL schema and checks that the index
 * is written to disk and that the API serves it to an authenticated caller.
 *
 * The index is not a static file any more: it enumerates the whole library,
 * so it is served through the authenticated API, scoped to the caller's
 * tenant.
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const assert = require('assert');
const mysql = require('mysql2/promise');

const { getConfig } = require('../../src/server/config');

const testDbName = `dam_test_manifest_startup_${process.pid}`;
const testStoragePath = path.join(__dirname, 'test-storage-manifest-startup');

fs.rmSync(testStoragePath, { recursive: true, force: true });

process.env.DB_NAME = testDbName;
process.env.STORAGE_DIR = testStoragePath;
process.env.JWT_SECRET = 'test-secret-manifest';
// The sample library would add assets the test does not expect.
process.env.SEED_SAMPLE_ASSETS = '0';

const port = 18100 + Math.floor(Math.random() * 1000);
process.env.PORT = String(port);

const serverApp = require('../../src/server/server');

/**
 * Drop the throw-away schema.
 *
 * @returns {Promise<void>}
 */
async function dropTestDatabase() {
  const config = getConfig();
  const connection = await mysql.createConnection({
    host: config.dbHost,
    port: config.dbPort,
    user: config.dbUser,
    password: config.dbPassword,
    charset: 'utf8mb4_unicode_ci',
  });
  try {
    await connection.query(`DROP DATABASE IF EXISTS \`${testDbName}\``);
  } finally {
    await connection.end();
  }
}

/**
 * Log in as the seeded administrator and return the access token.
 *
 * @param {string} baseUrl
 * @returns {Promise<string>}
 */
async function login(baseUrl) {
  const body = JSON.stringify({ username: 'admin', password: 'Admin@123456' });
  const response = await new Promise((resolve, reject) => {
    const req = http.request(
      `${baseUrl}/api/v1/auth/login`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => resolve({ statusCode: res.statusCode, body: data }));
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
  assert.strictEqual(
    response.statusCode,
    200,
    `login expected 200, got ${response.statusCode}: ${response.body}`,
  );
  return JSON.parse(response.body).access_token;
}

const server = serverApp.listen(port, '127.0.0.1', async () => {
  try {
    // The schema and the seed data are created in the background; the
    // manifest can only be written once the database is there.
    await serverApp.locals.ready;

    // The index is written to disk on boot.
    const indexPath = path.join(testStoragePath, 'manifests', 'index.json');
    assert.ok(fs.existsSync(indexPath), `expected the manifest index at ${indexPath}`);
    const onDisk = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    assert.ok(onDisk && typeof onDisk === 'object', 'expected parsed JSON object');
    assert.strictEqual(typeof onDisk.version, 'number', 'expected manifest.version to be a number');
    assert.strictEqual(typeof onDisk.count, 'number', 'expected manifest.count to be a number');
    assert.ok(Array.isArray(onDisk.assets), 'expected manifest.assets to be an array');

    // The old static path is gone: the index enumerates the library, so an
    // anonymous caller must not read it.
    const anonymous = await new Promise((resolve, reject) => {
      http.get(`http://127.0.0.1:${port}/storage/manifests/index.json`, (res) => {
        let data = '';
        res.on('data', (chunk) => data += chunk);
        res.on('end', () => resolve({ statusCode: res.statusCode, body: data }));
        res.on('error', reject);
      }).on('error', reject);
    });
    assert.notStrictEqual(
      anonymous.statusCode,
      200,
      `the manifest index must not be readable anonymously, got ${anonymous.statusCode}`,
    );

    // An authenticated caller gets it from the API, scoped to their tenant.
    const token = await login(`http://127.0.0.1:${port}`);
    const r = await new Promise((resolve, reject) => {
      http.get(
        `http://127.0.0.1:${port}/api/v1/manifest`,
        { headers: { Authorization: `Bearer ${token}` } },
        (res) => {
          let data = '';
          res.on('data', (chunk) => data += chunk);
          res.on('end', () => resolve({ statusCode: res.statusCode, body: data }));
          res.on('error', reject);
        },
      ).on('error', reject);
    });

    assert.strictEqual(r.statusCode, 200, `expected 200, got ${r.statusCode}: ${r.body}`);
    const parsed = JSON.parse(r.body);
    assert.ok(parsed && typeof parsed === 'object', 'expected parsed JSON object');
    assert.strictEqual(typeof parsed.version, 'number', 'expected manifest.version to be a number');
    assert.strictEqual(typeof parsed.count, 'number', 'expected manifest.count to be a number');
    assert.ok(Array.isArray(parsed.assets), 'expected manifest.assets to be an array');

    console.log('manifest startup replay + authenticated endpoint OK');
    await cleanup(0);
  } catch (e) {
    console.error('TEST FAILED:', e.message);
    await cleanup(1);
  }
});

/**
 * Close the server, drop the schema and leave.
 *
 * @param {number} code the process exit code
 * @returns {Promise<void>}
 */
async function cleanup(code) {
  server.close(async () => {
    try { fs.rmSync(testStoragePath, { recursive: true, force: true }); } catch {}
    try { await dropTestDatabase(); } catch {}
    process.exit(code);
  });
}
