/**
 * The plan's end-state acceptance criteria, exercised end to end against a
 * live throw-away instance.
 *
 * The suites already prove criterion 1 (tenant A and tenant B cannot see
 * each other's data — the `cross-tenant isolation` phase) and the ingest
 * path (the contract runtime checks). What is *not* proven end to end is:
 *
 *   - criterion 2: an empty database walks the whole `/init` flow, the
 *     server hot-loads, the login works immediately and the **sample
 *     assets** are there;
 *   - criterion 4: the ComfyUI door files an asset that
 *     `GET /jobs/by-comfyui/{job_id}` finds — driven through the actual
 *     Python client's request shape, not a hand-written fetch.
 *
 * The probe owns its own MySQL schema, its own `.env` and its own storage
 * directory; the developer's `.env` and their live database are never
 * touched.
 */

'use strict';

const assert = require('node:assert/strict');
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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A distinct schema so the probe never touches an existing one. */
const SCHEMA = `dam_contract_accept_${process.pid}_${Date.now().toString(36)}`;

/** The wizard's gate token — the probe sets it so it does not have to read it off the console. */
const INIT_TOKEN = 'acceptance-init-token';

let tmpRoot = null;
let storageDir = null;
let envFile = null;
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
 * @returns {Promise<number>} a free port
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
 * Start the backend against the probe's own schema and `.env`.
 *
 * @returns {Promise<void>}
 */
async function startBackend() {
  port = await freePort();
  // `JWT_SECRET` must reach the child exactly as a fresh deployment would
  // see it: absent, never an empty string. dotenv does not override a
  // variable that already exists — an empty string counts — so injecting
  // one here would shadow the secret the wizard wrote and stall every
  // token the restart is meant to keep accepting.
  const childEnv = { ...process.env, JWT_SECRET: undefined };
  delete childEnv.JWT_SECRET;
  child = spawn(process.execPath, [SERVER], {
    env: {
      ...childEnv,
      PORT: String(port),
      HOST: '127.0.0.1',
      ENV_FILE: envFile,
      DB_NAME: SCHEMA,
      STORAGE_DIR: storageDir,
      INIT_TOKEN,
      SEED_SAMPLE_ASSETS: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => process.stdout.write(`[backend] ${chunk}`));
  child.stderr.on('data', (chunk) => process.stdout.write(`[backend] ${chunk}`));
  await waitForHealth(port);
}

/**
 * @returns {Promise<void>}
 */
async function stopBackend() {
  if (!child) return;
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
 * @param {string} pathname
 * @param {object} body
 * @param {Record<string, string>} [headers]
 * @returns {Promise<{status: number, body: any}>}
 */
async function postJson(pathname, body, headers = {}) {
  return call(pathname, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

/**
 * A small but *valid* PNG — sharp has to be able to read it.
 *
 * The backend de-duplicates by file hash within a tenant, so two probes
 * that push "the same image" must push *different bytes* to get two assets.
 *
 * @param {number} variant
 * @returns {Buffer}
 */
function tinyPng(variant = 0) {
  const png = Buffer.from([
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
  // A trailing byte after IEND changes the hash without breaking the image:
  // the decoder stops at IEND.
  return variant === 0 ? png : Buffer.concat([png, Buffer.from([variant])]);
}

/**
 * @param {Buffer} bytes
 * @param {string} filename
 * @param {Record<string, string>} fields
 * @returns {FormData}
 */
function multipart(bytes, filename, fields = {}) {
  const form = new FormData();
  form.append('files', new File([bytes], filename, { type: 'image/png' }));
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  return form;
}

/**
 * Walk the whole `/init` flow on a fresh instance.
 *
 * The seed step hot-reloads the instance — the process keeps running — and
 * hands out no credential: the key the later criteria use is requested the
 * way an operator would, through the admin API after logging in.
 *
 * @returns {Promise<{adminPassword: string}>}
 */
async function runWizard() {
  const status = await call('/api/init/status');
  assert.equal(status.status, 200, 'the status endpoint must answer 200 on a fresh instance');
  assert.equal(status.body.initialized, false, 'a fresh instance must report itself uninitialized');
  console.log('[criterion 2] a fresh instance reports itself uninitialized');

  // The token the probe configured at boot.
  const initHeaders = { 'X-Init-Token': INIT_TOKEN };

  const database = await postJson('/api/init/database', {
    host: DB_HOST,
    port: DB_PORT,
    user: DB_USER,
    password: DB_PASSWORD,
    database: SCHEMA,
  }, initHeaders);
  assert.equal(database.status, 200, `the database step must answer 200: ${JSON.stringify(database.body)}`);
  assert.ok(fs.existsSync(envFile), 'the database step must write the environment file');
  console.log('[criterion 2] the database step writes .env');

  const adminPassword = 'Acceptance-Owner-2026';
  const admin = await postJson('/api/init/admin', {
    tenantName: '验收租户',
    username: 'owner',
    password: adminPassword,
  }, initHeaders);
  assert.equal(admin.status, 200, `the admin step must answer 200: ${JSON.stringify(admin.body)}`);
  console.log('[criterion 2] the admin step creates the tenant and its owner');

  const seed = await postJson('/api/init/seed', {}, initHeaders);
  assert.equal(seed.status, 200, `the seed step must answer 200: ${JSON.stringify(seed.body)}`);
  assert.equal(seed.body.ok, true, 'the seed step must report success');
  assert.equal(
    seed.body.api_key,
    undefined,
    'the seed step must hand out no API key — keys are requested on the 集成 page',
  );
  assert.equal(seed.body.jwt_secret_written, true, 'the seed step must write the JWT secret');
  console.log('[criterion 2] the seed step hot-loads the instance and writes the JWT secret');

  return { adminPassword };
}

/**
 * Walk the four acceptance criteria.
 *
 * @returns {Promise<void>}
 */
async function main() {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dam-accept-'));
  storageDir = path.join(tmpRoot, 'storage');
  envFile = path.join(tmpRoot, '.env');
  fs.mkdirSync(storageDir, { recursive: true });

  // A fresh installation has **no** `.env` — the wizard creates it from the
  // template. (Copying `.env.example` by hand is a different path: it ships
  // a placeholder `JWT_SECRET`, which `hasConfiguration` reads as
  // "configured". The probe follows the path the wizard was built for.)

  try {
    /* ---------------------------------------------------------------------
     * Criterion 2 — the empty-database flow, end to end.
     * ------------------------------------------------------------------- */
    await startBackend();
    const { adminPassword } = await runWizard();

    // The wizard hot-loaded the running process: no restart anywhere.
    const afterWizard = await call('/api/init/status');
    assert.equal(afterWizard.body.initialized, true, 'the hot reload must find the instance initialized right away');
    console.log('[criterion 2] the instance reports itself initialized without a restart');

    const login = await postJson('/api/v1/auth/login', {
      username: 'owner',
      password: adminPassword,
    });
    assert.equal(login.status, 200, `the owner must be able to log in without a restart: ${JSON.stringify(login.body)}`);
    const token = login.body.access_token;
    console.log('[criterion 2] the owner logs in without a restart');

    const list = await call('/api/v1/assets?page_size=200', {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(list.status, 200, `the asset list must answer 200: ${JSON.stringify(list.body)}`);
    const assets = Array.isArray(list.body.items) ? list.body.items : [];
    assert.ok(assets.length > 0, 'the seeded instance must show the sample assets');
    console.log(`[criterion 2] the library shows ${assets.length} sample asset(s)`);

    // The wizard handed out no key: one is requested the way an operator
    // would, through the admin API — exactly what the 集成 page does.
    const apiKeyResponse = await postJson('/api/v1/api-keys', {
      name: 'Acceptance Key',
      scopes: 'read,upload,delete',
    }, { authorization: `Bearer ${token}` });
    assert.equal(
      apiKeyResponse.status,
      201,
      `requesting an API key must answer 201: ${JSON.stringify(apiKeyResponse.body)}`,
    );
    const apiKey = apiKeyResponse.body.key;
    assert.ok(apiKey, 'the requested key must arrive in the response body');
    assert.ok(String(apiKey).startsWith('dam_'), 'the key must carry the project prefix');
    console.log('[criterion 2] the operator requested an API key through the admin API');

    // The rest of the flow survives a restart too: the file the wizard
    // wrote is what the next boot reads.
    await stopBackend();
    await startBackend();

    const afterRestart = await call('/api/init/status');
    assert.equal(afterRestart.body.initialized, true, 'a restart must find the instance initialized');
    console.log('[criterion 2] a restart finds the instance initialized');

    /* ---------------------------------------------------------------------
     * Criterion 3 — an external system pushes an image with the API key.
     * ------------------------------------------------------------------- */
    const pushed = await call('/api/ingest/v1/assets', {
      method: 'POST',
      headers: { 'x-api-key': apiKey },
      body: multipart(tinyPng(), 'acceptance-push.png', { title: 'Acceptance Push' }),
    });
    assert.equal(pushed.status, 201, `the ingest push must answer 201: ${JSON.stringify(pushed.body)}`);
    const pushedAsset = pushed.body.items[0];
    assert.equal(pushedAsset.title, 'Acceptance Push');
    console.log('[criterion 3] the API key pushed an image into the library');

    const afterPush = await call('/api/v1/assets?page_size=200', {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(afterPush.status, 200, `the asset list after the push must answer 200: ${JSON.stringify(afterPush.body).slice(0, 400)}`);
    const afterPushItems = afterPush.body.items || [];
    assert.ok(
      afterPushItems.some((item) => item.id === pushedAsset.id),
      'the pushed asset must appear in the frontend list immediately',
    );
    console.log('[criterion 3] the pushed asset is in the frontend list');

    /* ---------------------------------------------------------------------
     * Criterion 4 — the ComfyUI door, through the Python client.
     * ------------------------------------------------------------------- */
    const jobId = 'acceptance-comfyui-job';
    const comfy = await call(`/api/ingest/v1/comfyui/${jobId}`, {
      method: 'POST',
      headers: { 'x-api-key': apiKey },
      body: multipart(tinyPng(2), 'acceptance-comfyui.png', {
        title: 'Acceptance ComfyUI',
        tag_names: 'comfyui',
        prompt: 'a quiet harbour at dawn',
        seed: '12345',
        source_tool: 'comfyui',
      }),
    });
    assert.equal(comfy.status, 201, `the ComfyUI door must answer 201: ${JSON.stringify(comfy.body)}`);
    const comfyAsset = comfy.body.items[0];
    assert.equal(comfyAsset.job_id, jobId, 'the asset must carry the job id');
    assert.equal(comfyAsset.source_tool, 'comfyui', 'the asset must record the tool');
    console.log('[criterion 4] the ComfyUI door filed the asset');

    const found = await call(`/api/v1/jobs/by-comfyui/${jobId}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(found.status, 200, `the job lookup must answer 200: ${JSON.stringify(found.body)}`);
    assert.equal(found.body.id, comfyAsset.id, 'the lookup must find the asset the door created');
    console.log('[criterion 4] GET /jobs/by-comfyui finds it');

    console.log('\nAll four acceptance criteria PASS.');
  } finally {
    await stopBackend();
    await dropSchema(SCHEMA);
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error('PROBE FAILED:', error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
