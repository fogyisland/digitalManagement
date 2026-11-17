/**
 * A live reproduction of the reviewer's Critical #2: `/storage` serves every
 * tenant's files with no credential at all.
 *
 * The probe uploads one file into a tenant, then fetches it back **without
 * any header** — no token, no key. If the bytes come back, any anonymous
 * caller can read another tenant's originals.
 *
 * The manifest index is checked too: it is written by the storage layer's
 * own index writer and lives under the same static root.
 *
 * The probe owns its own schema and storage directory.
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const SERVER = path.join(ROOT, 'src', 'server', 'server.js');
const DB_HOST = process.env.DB_HOST || '127.0.0.1';
const DB_PORT = parseInt(process.env.DB_PORT || '3307', 10);
const DB_USER = process.env.DB_USER || 'dam';
const DB_PASSWORD = process.env.DB_PASSWORD || '';

/** The probe's own schema — a fixed name, so the cleanup can only touch it. */
const SCHEMA = 'dam_contract_storage_probe';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let tmpRoot = null;
let child = null;
let port = null;

/**
 * @param {string} schema
 * @returns {Promise<void>}
 */
async function dropSchema(schema) {
  const mysql = require('mysql2/promise');
  const connection = await mysql.createConnection({
    host: DB_HOST,
    port: DB_PORT,
    user: DB_USER,
    password: DB_PASSWORD,
  });
  try {
    await connection.query(`DROP DATABASE IF EXISTS \`${schema}\``);
  } finally {
    await connection.end();
  }
}

/**
 * @returns {Promise<number>}
 */
async function freePort() {
  const net = require('node:net');
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}

/**
 * @param {number} targetPort
 * @returns {Promise<void>}
 */
async function waitForHealth(targetPort) {
  const deadline = Date.now() + 60000;
  let last = 'never answered';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${targetPort}/api/health`);
      if (response.ok) return;
      last = `HTTP ${response.status}`;
    } catch (error) {
      last = error.message;
    }
    await sleep(200);
  }
  throw new Error(`backend did not become healthy: ${last}`);
}

/**
 * @param {string} pathname
 * @param {object} [options]
 * @returns {Promise<{status: number, body: any}>}
 */
async function call(pathname, options = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, options);
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch (error) {
    body = text;
  }
  return { status: response.status, body };
}

/**
 * A small but valid PNG.
 *
 * These are the bytes sharp itself writes, so every chunk carries the CRC
 * libpng checks. A PNG that only looks right is refused by the decoder, and
 * the refusal is swallowed as "non-fatal" — the thumbnail is then never
 * written and the path that writes it is never exercised.
 *
 * @returns {Buffer}
 */
function tinyPng() {
  return Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
    0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
    0x89, 0x00, 0x00, 0x00, 0x09, 0x70, 0x48, 0x59,
    0x73, 0x00, 0x00, 0x03, 0xe8, 0x00, 0x00, 0x03,
    0xe8, 0x01, 0xb5, 0x7b, 0x52, 0x6b, 0x00, 0x00,
    0x00, 0x0d, 0x49, 0x44, 0x41, 0x54, 0x08, 0xd7,
    0x63, 0x60, 0x60, 0x60, 0x60, 0x00, 0x00, 0x00,
    0x05, 0x00, 0x01, 0x5e, 0xf3, 0x2a, 0x3a, 0x00,
    0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
    0x42, 0x60, 0x82,
  ]);
}

async function main() {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dam-storage-'));
  const storageDir = path.join(tmpRoot, 'storage');
  fs.mkdirSync(storageDir, { recursive: true });

  port = await freePort();
  child = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      DB_NAME: SCHEMA,
      STORAGE_DIR: storageDir,
      JWT_SECRET: 'storage-probe-secret',
      SEED_SAMPLE_ASSETS: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => process.stdout.write(`[backend] ${chunk}`));
  child.stderr.on('data', (chunk) => process.stdout.write(`[backend] ${chunk}`));

  try {
    await waitForHealth(port);

    // Log in as the seeded administrator and upload one file.
    const login = await call('/api/v1/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'Admin@123456' }),
    });
    const token = login.body.access_token;

    const form = new FormData();
    form.append('files', new File([tinyPng()], 'secret-report.png', { type: 'image/png' }));
    form.append('title', 'Secret Report');
    const uploaded = await call('/api/v1/assets/upload', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: form,
    });
    const asset = uploaded.body.items ? uploaded.body.items[0] : uploaded.body;
    console.log(`\nuploaded ${asset.id} -> ${asset.original_url}`);

    // --- 1) the file itself, with NO credential ---------------------------
    // The URL the API hands out is signed: it carries an expiry and an HMAC
    // over the asset's tenant and path. The server issued it to a caller
    // who may already see the asset, and it opens that one file until it
    // expires — that is what lets a browser's `<img src>` show a picture,
    // since an image request cannot carry an `Authorization` header.
    const anonymous = await fetch(`http://127.0.0.1:${port}${asset.original_url}`);
    const bytes = Buffer.from(await anonymous.arrayBuffer());
    console.log(
      `anonymous GET <signed url> -> HTTP ${anonymous.status}, ` +
        `${bytes.length} bytes, PNG signature: ${bytes.slice(0, 8).toString('hex')}`,
    );

    // --- 2) the same path WITHOUT the signature ---------------------------
    // This is the attack the static mount allowed: guess an asset id, build
    // the path by hand, read the bytes. Without a valid signature the route
    // has to refuse.
    const unsigned = asset.original_url.split('?')[0];
    const unsignedRes = await fetch(`http://127.0.0.1:${port}${unsigned}`);
    const unsignedBytes = Buffer.from(await unsignedRes.arrayBuffer());
    console.log(
      `anonymous GET ${unsigned} -> HTTP ${unsignedRes.status}, ${unsignedBytes.length} bytes`,
    );

    // --- 3) the manifest index, with NO credential -------------------------
    // The index enumerates the whole library — every tenant's titles,
    // prompts and file names. It used to be a static file under the same
    // root; it is served through the authenticated API now.
    const manifest = await fetch(`http://127.0.0.1:${port}/storage/manifests/index.json`);
    const manifestText = await manifest.text();
    console.log(`anonymous GET /storage/manifests/index.json -> HTTP ${manifest.status}`);
    if (manifest.ok) {
      const parsed = JSON.parse(manifestText);
      console.log(`  count: ${parsed.count}, tenants: ${parsed.assets.map((a) => a.tenant_id).join(', ')}`);
      console.log(`  first entry's original_path: ${parsed.assets[0].original_path}`);
    }
  } finally {
    if (child) {
      const dying = child;
      child = null;
      dying.kill();
      await new Promise((resolve) => {
        if (dying.exitCode !== null) {
          resolve();
          return;
        }
        dying.once('exit', resolve);
        setTimeout(resolve, 3000);
      });
    }
    await dropSchema(SCHEMA);
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error('PROBE FAILED:', error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
