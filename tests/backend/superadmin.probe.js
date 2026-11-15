/**
 * A live reproduction of the reviewer's Critical #1: the `superadmin`
 * wildcard only works for the asset routes.
 *
 * The probe builds two tenants with their own data, then asks a superadmin
 * for each resource the platform administrator is supposed to see. The
 * routes that filter by `tenant_id = ?` with the literal `'*'` answer an
 * empty set; the ones that branch on `isAllTenants(scope)` answer the whole
 * instance.
 *
 * The probe owns its own schema and storage directory.
 */

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const dotenv = require('dotenv');

const ROOT = path.resolve(__dirname, '..', '..');
const SERVER = path.join(ROOT, 'src', 'server', 'server.js');

// The database configuration lives in the repository's `.env`. The probe
// reads the process environment, so the file has to be loaded here — the
// same the server itself does on boot.
dotenv.config({ path: path.join(ROOT, '.env') });

const DB_HOST = process.env.DB_HOST || '127.0.0.1';
const DB_PORT = parseInt(process.env.DB_PORT || '3307', 10);
const DB_USER = process.env.DB_USER || 'dam';
const DB_PASSWORD = process.env.DB_PASSWORD || '';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The probe's own schema — a fixed name, not a computed one, so the cleanup
 * below can only ever touch this one throw-away schema.
 */
const SCHEMA = 'dam_contract_superadmin_probe';

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
 * The tenant a row belongs to.
 *
 * The API answers with DTOs, and not every DTO carries the tenant — so the
 * row is read where it lives.
 *
 * @param {string} table
 * @param {string} id
 * @returns {Promise<string|null>}
 */
async function tenantOfRow(table, id) {
  const mysql = require('mysql2/promise');
  const connection = await mysql.createConnection({
    host: DB_HOST,
    port: DB_PORT,
    user: DB_USER,
    password: DB_PASSWORD,
    database: SCHEMA,
  });
  try {
    const [rows] = await connection.query(
      `SELECT tenant_id FROM \`${table}\` WHERE id = ?`,
      [id],
    );
    return rows.length ? rows[0].tenant_id : null;
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

async function main() {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dam-super-'));
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
      JWT_SECRET: 'superadmin-probe-secret',
      SEED_SAMPLE_ASSETS: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => process.stdout.write(`[backend] ${chunk}`));
  child.stderr.on('data', (chunk) => process.stdout.write(`[backend] ${chunk}`));

  try {
    await waitForHealth(port);

    // Two tenants, each with a user, a category, a tag, an API key, a
    // webhook endpoint and an asset.
    const mysql = require('mysql2/promise');
    const db = await mysql.createConnection({
      host: DB_HOST,
      port: DB_PORT,
      user: DB_USER,
      password: DB_PASSWORD,
      database: SCHEMA,
    });
    const password = await bcrypt.hash('Probe@123456', 10);
    for (const tenant of ['tenant-a', 'tenant-b']) {
      await db.query('INSERT INTO tenants (id, name, slug, status) VALUES (?, ?, ?, ?)', [
        tenant,
        tenant,
        tenant,
        'active',
      ]);
      await db.query(
        'INSERT INTO users (id, tenant_id, username, email, password_hash, role) VALUES (?, ?, ?, ?, ?, ?)',
        [`u-${tenant}`, tenant, `owner-${tenant}`, `${tenant}@dam.local`, password, 'owner'],
      );
      await db.query('INSERT INTO categories (id, tenant_id, name, slug) VALUES (?, ?, ?, ?)', [
        `cat-${tenant}`,
        tenant,
        `cat-${tenant}`,
        `cat-${tenant}`,
      ]);
      await db.query('INSERT INTO tags (id, tenant_id, name, slug) VALUES (?, ?, ?, ?)', [
        `tag-${tenant}`,
        tenant,
        `tag-${tenant}`,
        `tag-${tenant}`,
      ]);
      await db.query(
        'INSERT INTO api_keys (id, tenant_id, name, key_prefix, key_hash, scopes) VALUES (?, ?, ?, ?, ?, ?)',
        [`key-${tenant}`, tenant, `key-${tenant}`, `dam_${tenant}`, `hash-${tenant}`, 'read,upload'],
      );
      await db.query(
        'INSERT INTO webhook_endpoints (id, tenant_id, name, url, secret, events, is_active) VALUES (?, ?, ?, ?, ?, ?, 1)',
        [`hook-${tenant}`, tenant, `hook-${tenant}`, 'http://127.0.0.1:9/x', 'secret', 'asset.created'],
      );
      await db.query(
        `INSERT INTO assets (id, tenant_id, title, filename, original_name, mime_type, file_size,
           file_hash, asset_type, storage_path, source, status, job_id)
         VALUES (?, ?, ?, ?, ?, ?, 10, ?, 'image', ?, 'admin', 'ready', ?)`,
        [
          `a-${tenant}`,
          tenant,
          `asset-${tenant}`,
          `${tenant}.png`,
          `${tenant}.png`,
          'image/png',
          `hash-${tenant}`,
          `originals/${tenant}.png`,
          `job-${tenant}`,
        ],
      );
    }

    // The platform administrator: role `superadmin`, tenant `*`.
    await db.query(
      'INSERT INTO users (id, tenant_id, username, email, password_hash, role) VALUES (?, ?, ?, ?, ?, ?)',
      ['u-root', '*', 'root', 'root@dam.local', password, 'superadmin'],
    );
    await db.end();

    const login = await call('/api/v1/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'root', password: 'Probe@123456' }),
    });
    assert.equal(login.status, 200, `the superadmin must be able to log in: ${JSON.stringify(login.body)}`);
    const token = login.body.access_token;
    const auth = { authorization: `Bearer ${token}` };

    /** @type {{route: string, expected: number, got: number, items: number}[]} */
    const results = [];

    /**
     * @param {string} route
     * @param {number} expected
     * @param {number} got
     * @param {number} items
     */
    function record(route, expected, got, items) {
      results.push({ route, expected, got, items });
    }

    // --- assets (the branch that honours the wildcard) ---------------------
    const assets = await call('/api/v1/assets?page_size=200', { headers: auth });
    record('GET /api/v1/assets', 2, assets.status, (assets.body.items || []).length);

    // --- the routes the reviewer suspects ---------------------------------
    // `/stats` answers `{total, images, videos, total_size, recent}`; the
    // dashboard answers `{summary: {total_assets, ...}, upload_trend,
    // recent_assets}`. The probe counts the assets each of them reports.
    const stats = await call('/api/v1/stats', { headers: auth });
    record('GET /api/v1/stats', 200, stats.status, stats.body ? stats.body.total : -1);

    const dashboard = await call('/api/v1/stats/dashboard', { headers: auth });
    record(
      'GET /api/v1/stats/dashboard',
      200,
      dashboard.status,
      dashboard.body && dashboard.body.summary ? dashboard.body.summary.total_assets : -1,
    );

    const keys = await call('/api/v1/api-keys', { headers: auth });
    record('GET /api/v1/api-keys', 200, keys.status, (keys.body.items || keys.body || []).length);

    const hooks = await call('/api/v1/webhooks', { headers: auth });
    record('GET /api/v1/webhooks', 200, hooks.status, (hooks.body.items || hooks.body || []).length);

    const tags = await call('/api/v1/tags', { headers: auth });
    record('GET /api/v1/tags', 200, tags.status, (tags.body.items || tags.body || []).length);

    const categories = await call('/api/v1/categories', { headers: auth });
    record('GET /api/v1/categories', 200, categories.status, (categories.body.items || categories.body || []).length);

    const users = await call('/api/v1/users', { headers: auth });
    record('GET /api/v1/users', 200, users.status, (users.body.items || users.body || []).length);

    const job = await call('/api/v1/jobs/by-comfyui/job-tenant-a', { headers: auth });
    record('GET /api/v1/jobs/by-comfyui/job-tenant-a', 200, job.status, job.body && job.body.id ? 1 : 0);

    console.log('\n--- the superadmin wildcard, per route ---');
    for (const entry of results) {
      // `/jobs/by-comfyui` answers with one asset, not a list, so its
      // threshold is 1; every other route must show at least the two
      // tenants' worth of rows.
      const expectedMinimum = entry.route.includes('by-comfyui') ? 1 : 2;
      console.log(
        `  ${entry.route.padEnd(42)} status ${entry.got}, items ${entry.items}` +
          `  ${entry.items >= expectedMinimum ? 'OK' : '<-- EMPTY'}`,
      );
    }

    const broken = results.filter((entry) => {
      if (entry.route.includes('/stats')) return entry.items <= 0;
      if (entry.route.includes('by-comfyui')) return entry.items < 1;
      return entry.items < 2;
    });
    console.log(
      `\n${broken.length} route(s) answer the superadmin with an empty set: ` +
        broken.map((entry) => entry.route).join(', '),
    );

    // --- the write path ----------------------------------------------------
    // A platform administrator's scope covers every tenant, so it names none.
    // A row that names the wildcard belongs to nobody: no tenant admin can
    // read it, and an account created against it cannot authenticate — there
    // is no tenant row for the wildcard to resolve to, so every request it
    // makes is refused. A write therefore has to name a concrete tenant, and
    // the superadmin names it in `X-Tenant`.
    const json = { 'content-type': 'application/json' };

    const unnamed = await call('/api/v1/categories', {
      method: 'POST',
      headers: { ...json, ...auth },
      body: JSON.stringify({ name: 'no tenant named' }),
    });
    assert.equal(
      unnamed.status,
      400,
      `a write that names no tenant must be refused: ${JSON.stringify(unnamed.body)}`,
    );
    assert.equal(
      unnamed.body && unnamed.body.code,
      'TENANT_REQUIRED',
      `the refusal must name itself: ${JSON.stringify(unnamed.body)}`,
    );

    const bogus = await call('/api/v1/categories', {
      method: 'POST',
      headers: { ...json, ...auth, 'x-tenant': 'no-such-tenant' },
      body: JSON.stringify({ name: 'a tenant that does not exist' }),
    });
    assert.equal(
      bogus.status,
      400,
      `a write into a tenant that does not exist must be refused: ${JSON.stringify(bogus.body)}`,
    );
    assert.equal(
      bogus.body && bogus.body.code,
      'NO_SUCH_TENANT',
      `the refusal must name itself: ${JSON.stringify(bogus.body)}`,
    );

    const named = await call('/api/v1/categories', {
      method: 'POST',
      headers: { ...json, ...auth, 'x-tenant': 'tenant-a' },
      body: JSON.stringify({ name: 'written by the platform administrator' }),
    });
    assert.equal(
      named.status,
      201,
      `a write into a named tenant must succeed: ${JSON.stringify(named.body)}`,
    );
    // The category DTO does not carry the tenant, so the row is checked where
    // it lives: in the database.
    assert.equal(
      await tenantOfRow('categories', named.body.id),
      'tenant-a',
      'the row must belong to the tenant it was named for',
    );

    // The header is not a way out of a tenant. A caller who already speaks
    // for one tenant writes into that tenant, whatever the header says.
    const ownerLogin = await call('/api/v1/auth/login', {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ username: 'owner-tenant-a', password: 'Probe@123456' }),
    });
    assert.equal(
      ownerLogin.status,
      200,
      `a tenant owner must be able to log in: ${JSON.stringify(ownerLogin.body)}`,
    );
    const ownerWrite = await call('/api/v1/categories', {
      method: 'POST',
      headers: {
        ...json,
        authorization: `Bearer ${ownerLogin.body.access_token}`,
        'x-tenant': 'tenant-b',
      },
      body: JSON.stringify({ name: 'a tenant owner naming another tenant' }),
    });
    assert.equal(
      ownerWrite.status,
      201,
      `a tenant owner must be able to write: ${JSON.stringify(ownerWrite.body)}`,
    );
    assert.equal(
      await tenantOfRow('categories', ownerWrite.body.id),
      'tenant-a',
      "the header must not move a write out of the caller's own tenant",
    );

    // The account it created has to work: an account whose tenant does not
    // exist can log in and is then refused every single request.
    const created = await call('/api/v1/users', {
      method: 'POST',
      headers: { ...json, ...auth, 'x-tenant': 'tenant-b' },
      body: JSON.stringify({ username: 'made-by-root', password: 'Probe@123456', role: 'viewer' }),
    });
    assert.equal(
      created.status,
      201,
      `a user write into a named tenant must succeed: ${JSON.stringify(created.body)}`,
    );
    assert.equal(
      created.body.tenant_id,
      'tenant-b',
      'the user must belong to the tenant it was named for',
    );
    assert.equal(
      await tenantOfRow('users', created.body.id),
      'tenant-b',
      'the user row must belong to the tenant it was named for',
    );

    const createdLogin = await call('/api/v1/auth/login', {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ username: 'made-by-root', password: 'Probe@123456' }),
    });
    assert.equal(
      createdLogin.status,
      200,
      `the created account must be able to log in: ${JSON.stringify(createdLogin.body)}`,
    );
    const createdMe = await call('/api/v1/auth/me', {
      headers: { authorization: `Bearer ${createdLogin.body.access_token}` },
    });
    assert.equal(
      createdMe.status,
      200,
      `the created account must be able to act: ${JSON.stringify(createdMe.body)}`,
    );

    console.log('\n--- the superadmin write path ---');
    console.log('  a write that names no tenant is refused       OK');
    console.log('  a write into a tenant that does not exist     OK');
    console.log('  a write into a named tenant lands there       OK');
    console.log('  the account it created can authenticate       OK');
    console.log('  the header does not move a tenant write       OK');
    console.log('superadmin probe OK');
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
