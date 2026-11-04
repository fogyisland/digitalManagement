'use strict';

/**
 * Backend integration test suite.
 *
 * Every phase boots the real server module against its own isolated database
 * and storage directory and drives it over real HTTP.
 *
 *   1. schema     — the migration produces every column and table
 *   2. tenant     — a credential resolves to the tenant it speaks for
 *   3. credential — the token and the API key carry the tenant
 *   4. isolation  — one tenant's data never answers another tenant
 *   5. upload     — a multipart upload echoes the metadata fields back
 *   6. file size  — an oversized upload is rejected with 413
 *   7. webhooks   — CRUD plus the asset event fan-out
 *   8. lifecycle  — login/refresh/logout, user CRUD, soft delete, restore,
 *                   permanent delete and the chunked upload flow
 *
 * The phases are chained explicitly: a phase only starts once the previous
 * one has released its server. This matters because `server.close()` called
 * right after `server.listen()` cancels Node's `listening` event — the
 * callback that starts the phase would never fire and the phase would be
 * silently skipped while the suite still reported success.
 */

const mysql = require('mysql2/promise');
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const assert = require('assert');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const {
  DEFAULT_TENANT_ID,
  TENANT_SCOPED_TABLES,
  TENANT_UNIQUE_KEYS,
  tenantUniqueKeyName,
} = require('../../src/server/lib/schema');
const {
  ALL_TENANTS,
  SUPERADMIN_ROLE,
  resolveTenantFromUser,
  tenantScope,
} = require('../../src/server/lib/tenant');

const TESTS_DIR = __dirname;
const JWT_SECRET = 'test-secret-key';

/** A 1x1 PNG — enough for sharp to report a size, small enough to inline. */
const PNG_1X1 = Buffer.from([
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

// --- Generic helpers ---------------------------------------------------------

/**
 * Open a connection to the MySQL server itself, without a schema.
 *
 * The fixtures are separate databases on the same server, so they are
 * created and dropped with this connection.
 *
 * @returns {Promise<import('mysql2/promise').Connection>}
 */
function serverConnection() {
  return mysql.createConnection({
    host: process.env.DB_HOST || '127.0.0.1',
    port: parseInt(process.env.DB_PORT || '3306', 10),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    charset: 'utf8mb4_unicode_ci',
  });
}

/**
 * Quote a schema name for MySQL.
 *
 * @param {string} name
 * @returns {string}
 */
function quoteSchema(name) {
  return `\`${String(name).replace(/`/g, '``')}\``;
}

/**
 * Delete a fixture database and its storage directory.
 *
 * The server module keeps its pool open for the lifetime of the process, so
 * the drop can fail while connections are still around; the failures are
 * swallowed on purpose because the fixtures are disposable.
 *
 * @param {string} dbName
 * @param {string} storagePath
 * @returns {Promise<void>}
 */
async function removeFixture(dbName, storagePath) {
  try {
    const connection = await serverConnection();
    try {
      await connection.query(`DROP DATABASE IF EXISTS ${quoteSchema(dbName)}`);
    } finally {
      await connection.end();
    }
  } catch {
    // Already gone, or the server is unreachable — nothing to clean up.
  }
  try {
    fs.rmSync(storagePath, { recursive: true, force: true });
  } catch {
    // Best effort.
  }
}

/**
 * Build a multipart/form-data body.
 *
 * @param {string} boundary
 * @param {Array<[string, string]>} fields
 * @param {Array<{name: string, filename: string, contentType: string, buffer: Buffer}>} files
 * @returns {Buffer}
 */
function buildMultipart(boundary, fields, files) {
  const parts = [];
  for (const [name, value] of fields) {
    parts.push(Buffer.from(`--${boundary}\r\n`));
    parts.push(Buffer.from(`Content-Disposition: form-data; name="${name}"\r\n\r\n`));
    parts.push(Buffer.from(String(value)));
    parts.push(Buffer.from('\r\n'));
  }
  for (const file of files) {
    parts.push(Buffer.from(`--${boundary}\r\n`));
    parts.push(
      Buffer.from(
        `Content-Disposition: form-data; name="${file.name}"; filename="${file.filename}"\r\n`,
      ),
    );
    parts.push(Buffer.from(`Content-Type: ${file.contentType}\r\n\r\n`));
    parts.push(file.buffer);
    parts.push(Buffer.from('\r\n'));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return Buffer.concat(parts);
}

/**
 * Perform an HTTP request and collect the response.
 *
 * @param {{hostname: string, port: number, path: string, method: string,
 *          headers?: Record<string, string|number>, body?: string|Buffer, binary?: boolean}} opts
 * @returns {Promise<{status: number, raw: string}>}
 */
function request(opts) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: opts.hostname,
        port: opts.port,
        path: opts.path,
        method: opts.method,
        headers: opts.headers,
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          resolve({ status: res.statusCode, raw: Buffer.concat(chunks).toString('utf8') });
        });
        res.on('error', reject);
      },
    );
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

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Poll a predicate until it returns a truthy value.
 *
 * @param {() => Promise<boolean>|boolean} predicate
 * @param {number} timeoutMs
 * @param {string} label
 * @returns {Promise<void>}
 */
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

/**
 * Boot a fresh server instance against an isolated fixture.
 *
 * The require cache entry is dropped first so `src/server.js` re-reads the
 * environment (database name, storage directory, upload limit) instead of
 * reusing the previous phase's configuration. The returned promise resolves
 * once the schema exists, so the first request never races the migration.
 *
 * @param {string} name fixture prefix
 * @param {Record<string, string>} [env] extra environment variables
 * @returns {Promise<{app: import('express').Express, dbName: string, storagePath: string}>}
 */
async function bootServer(name, env) {
  const dbName = `dam_test_${name}_${process.pid}`;
  const storagePath = path.join(TESTS_DIR, `test-storage-${name}`);
  await removeFixture(dbName, storagePath);
  process.env.DB_NAME = dbName;
  process.env.STORAGE_DIR = storagePath;
  process.env.JWT_SECRET = JWT_SECRET;
  // The sample library is a first-boot convenience; the tests need a
  // deterministic, empty catalogue.
  process.env.SEED_SAMPLE_ASSETS = '0';
  for (const [key, value] of Object.entries(env || {})) {
    process.env[key] = value;
  }
  delete require.cache[require.resolve('../../src/server/server')];
  const app = require('../../src/server/server');
  await app.locals.ready;
  return { app, dbName, storagePath };
}

/**
 * Start listening on an OS-assigned free port.
 *
 * @param {import('express').Express} app
 * @returns {Promise<import('http').Server>}
 */
function listen(app) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
    server.on('error', reject);
  });
}

/**
 * Stop a server and drop its keep-alive sockets.
 *
 * Node's global HTTP agent keeps connections alive by default, so a plain
 * `close()` would wait for the idle sockets to time out and the suite would
 * hang instead of finishing.
 *
 * @param {import('http').Server} server
 * @returns {Promise<void>}
 */
function close(server) {
  return new Promise((resolve) => {
    server.close(() => resolve());
    if (typeof server.closeAllConnections === 'function') {
      server.closeAllConnections();
    }
  });
}

/**
 * Close the database pool the server module opened.
 *
 * `src/server/server.js` creates one pool per module instance, and the suite
 * re-requires that module for every phase (the require cache is dropped so
 * the phase gets its own schema and storage directory). An un-ended pool
 * keeps its sockets open, the Node event loop never drains and the suite
 * process never exits — the runner waits on the child's `exit` event and
 * would hang forever. Every phase therefore closes the pool it created.
 *
 * @param {import('express').Express} app
 * @returns {Promise<void>}
 */
async function closeDb(app) {
  const pool = app && app.locals && app.locals.db && app.locals.db.pool;
  if (!pool) return;
  await pool.end();
}

/**
 * Mint an admin access token for the seeded admin user.
 *
 * @param {string} dbName
 * @returns {Promise<string>}
 */
async function mintAdminToken(dbName) {
  const pool = await mysql.createPool({
    host: process.env.DB_HOST || '127.0.0.1',
    port: parseInt(process.env.DB_PORT || '3306', 10),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: dbName,
    dateStrings: true,
  });
  try {
    const [rows] = await pool.execute("SELECT id, tenant_id FROM users WHERE username = 'admin'");
    if (rows.length === 0) throw new Error('admin user not seeded');
    // The token carries the tenant it was issued for, like a real one.
    return jwt.sign(
      { sub: rows[0].id, role: 'admin', tid: rows[0].tenant_id },
      JWT_SECRET,
      { expiresIn: '1h' },
    );
  } finally {
    await pool.end();
  }
}

/**
 * Run one query against a fixture database.
 *
 * @param {string} dbName
 * @param {string} sql
 * @param {unknown[]} [params]
 * @returns {Promise<object[]>} the matching rows
 */
async function queryFixture(dbName, sql, params = []) {
  const pool = await mysql.createPool({
    host: process.env.DB_HOST || '127.0.0.1',
    port: parseInt(process.env.DB_PORT || '3306', 10),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: dbName,
    dateStrings: true,
  });
  try {
    const [rows] = await pool.execute(sql, params);
    return rows;
  } finally {
    await pool.end();
  }
}

/**
 * Upload a single file to `/api/v1/assets/upload`.
 *
 * @param {number} port
 * @param {string} token
 * @param {{filename?: string, buffer?: Buffer, contentType?: string,
 *          fields?: Array<[string, string]>}} [options]
 * @returns {Promise<{status: number, raw: string}>}
 */
async function uploadFile(port, token, options) {
  const opts = options || {};
  const boundary = '----upload' + Date.now() + Math.random().toString(16).slice(2);
  const body = buildMultipart(
    boundary,
    opts.fields || [],
    [
      {
        name: 'files',
        filename: opts.filename || 'test.png',
        contentType: opts.contentType || 'image/png',
        buffer: opts.buffer || PNG_1X1,
      },
    ],
  );
  return request({
    hostname: '127.0.0.1',
    port,
    path: '/api/v1/assets/upload',
    method: 'POST',
    headers: {
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      'Content-Length': body.length,
      Authorization: `Bearer ${token}`,
    },
    body,
    binary: true,
  });
}

// --- Phase 1: schema ---------------------------------------------------------

/**
 * The real server module is required with an isolated DB so it runs the full
 * init path (CREATE TABLE + idempotent ALTER TABLE + indexes + seed).
 * The module opens its own pool, which this phase closes before the fixture
 * is dropped.
 */
async function phaseSchema() {
  const dbName = `dam_test_schema_${process.pid}`;
  const storagePath = path.join(TESTS_DIR, 'test-storage-schema');
  await removeFixture(dbName, storagePath);
  process.env.DB_NAME = dbName;
  process.env.STORAGE_DIR = storagePath;
  process.env.JWT_SECRET = JWT_SECRET;
  process.env.SEED_SAMPLE_ASSETS = '0';

  // The init also seeds default categories/tags and logs to stdout; the
  // schema is the only thing this phase cares about.
  const originalLog = console.log;
  console.log = () => {};
  const app = require('../../src/server/server');
  await app.locals.ready;
  console.log = originalLog;

  const pool = await mysql.createPool({
    host: process.env.DB_HOST || '127.0.0.1',
    port: parseInt(process.env.DB_PORT || '3306', 10),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: dbName,
    dateStrings: true,
  });
  try {
    const [columnRows] = await pool.execute(
      `SELECT COLUMN_NAME AS name FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'assets'`,
      [dbName],
    );
    const cols = columnRows.map((c) => c.name);
    for (const column of ['source_tool', 'prompt', 'seed', 'model_name', 'job_id', 'metadata_json', 'deleted_at']) {
      if (!cols.includes(column)) throw new Error('missing column: ' + column);
    }

    const [tableRows] = await pool.execute(
      `SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?`,
      [dbName],
    );
    const tables = tableRows.map((t) => t.name);
    for (const table of [
      'webhook_endpoints',
      'webhook_logs',
      'manifest_writes',
      'revoked_tokens',
      'token_registry',
      'upload_sessions',
    ]) {
      if (!tables.includes(table)) throw new Error('missing table: ' + table);
    }

    // --- the tenant layer ---------------------------------------------------
    // Every business row belongs to a tenant: the `tenants` table exists, it
    // carries the default tenant, and every tenant-scoped table has the
    // `tenant_id` column that points at it.
    const [tenantRows] = await pool.execute(
      "SELECT id, slug FROM tenants WHERE id = 'default'",
    );
    assert.strictEqual(tenantRows.length, 1, 'the default tenant must exist');
    assert.strictEqual(
      DEFAULT_TENANT_ID,
      'default',
      'the default tenant id must be exported as "default"',
    );

    for (const table of TENANT_SCOPED_TABLES) {
      const [cols] = await pool.execute(
        `SELECT COLUMN_NAME AS name FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?`,
        [dbName, table],
      );
      assert.ok(
        cols.some((c) => c.name === 'tenant_id'),
        `${table} must have a tenant_id column`,
      );
    }

    // The unique keys that used to be global are now tenant-scoped: the old
    // index is gone and the composite one is in place, otherwise two tenants
    // could not both own a category called "产品图".
    for (const [table, oldIndex, column] of TENANT_UNIQUE_KEYS) {
      const [indexes] = await pool.execute(
        `SELECT DISTINCT INDEX_NAME AS name FROM information_schema.STATISTICS
          WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?`,
        [dbName, table],
      );
      const names = indexes.map((i) => i.name);
      if (oldIndex) {
        assert.ok(
          !names.includes(oldIndex),
          `${table}.${oldIndex} must be replaced by a tenant-scoped unique key`,
        );
      }
      assert.ok(
        names.includes(tenantUniqueKeyName(table, column)),
        `${table} must have the tenant-scoped unique key on ${column}`,
      );
    }

    // `asset_tags` is keyed by tenant as well: the same tag on the same
    // asset may exist once per tenant.
    const [assetTagsKeys] = await pool.execute(
      `SELECT COLUMN_NAME AS name, SEQ_IN_INDEX AS seq FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'asset_tags' AND INDEX_NAME = 'PRIMARY'
        ORDER BY SEQ_IN_INDEX`,
      [dbName],
    );
    assert.deepStrictEqual(
      assetTagsKeys.map((c) => c.name),
      ['tenant_id', 'asset_id', 'tag_id'],
      'asset_tags must be keyed by (tenant_id, asset_id, tag_id)',
    );
  } finally {
    await pool.end();
  }

  await closeDb(app);
  await removeFixture(dbName, storagePath);
  delete require.cache[require.resolve('../../src/server/server')];
  console.log('schema OK');
}

// --- Phase 2: tenant context -------------------------------------------------

/**
 * The tenant a credential speaks for.
 *
 * Two tenants and two users: a regular one that belongs to the default
 * tenant, and a platform administrator that may act across every tenant.
 * The tenant identity comes from the credential, never from the request.
 */
async function phaseTenantContext() {
  const { app, dbName, storagePath } = await bootServer('tenant');
  const db = app.locals.db;
  try {
    await db
      .prepare('INSERT INTO tenants (id, name, slug) VALUES (?, ?, ?)')
      .run(['tenant-b', '第二租户', 'tenant-b']);
    await db
      .prepare(
        'INSERT INTO users (id, tenant_id, username, password_hash, role) VALUES (?, ?, ?, ?, ?)',
      )
      .run(['u-regular', DEFAULT_TENANT_ID, 'regular', 'x', 'viewer']);
    await db
      .prepare(
        'INSERT INTO users (id, tenant_id, username, password_hash, role) VALUES (?, ?, ?, ?, ?)',
      )
      .run(['u-root', ALL_TENANTS, 'root', 'x', SUPERADMIN_ROLE]);

    const regular = await db
      .prepare('SELECT id, username, role, tenant_id FROM users WHERE id = ?')
      .get(['u-regular']);
    const root = await db
      .prepare('SELECT id, username, role, tenant_id FROM users WHERE id = ?')
      .get(['u-root']);

    // A regular user speaks for its own tenant and nothing else.
    const regularTenant = await resolveTenantFromUser(db, regular);
    assert.deepStrictEqual(
      regularTenant,
      { id: DEFAULT_TENANT_ID, slug: DEFAULT_TENANT_ID, name: '默认租户', status: 'active' },
      'a regular user must resolve to the tenant its row belongs to',
    );
    assert.deepStrictEqual(
      tenantScope(regular, regularTenant),
      { tenantId: DEFAULT_TENANT_ID, isSuperadmin: false },
      'a regular user must be scoped to its own tenant',
    );

    // A platform administrator speaks for every tenant.
    const rootTenant = await resolveTenantFromUser(db, root);
    assert.strictEqual(rootTenant.id, ALL_TENANTS, 'a superadmin resolves to the wildcard tenant');
    assert.deepStrictEqual(
      tenantScope(root, rootTenant),
      { tenantId: ALL_TENANTS, isSuperadmin: true },
      'a superadmin must be scoped across every tenant',
    );

    // A user whose tenant does not exist resolves to nothing at all: the
    // request is answered with 403, never with another tenant's data.
    const orphan = await resolveTenantFromUser(db, {
      id: 'u-orphan',
      role: 'viewer',
      tenant_id: 'no-such-tenant',
    });
    assert.strictEqual(orphan, null, 'a user without a tenant must not resolve to one');
    assert.strictEqual(
      tenantScope({ id: 'u-orphan', role: 'viewer' }, null),
      null,
      'a request without a tenant has no scope',
    );
    assert.strictEqual(
      tenantScope(null, null),
      null,
      'an unauthenticated request has no scope',
    );

    console.log('tenant context OK');
  } finally {
    await closeDb(app);
    await removeFixture(dbName, storagePath);
  }
}

// --- Phase 3: the credential decides the tenant -------------------------------

/**
 * The tenant travels with the credential, never with the request.
 *
 * A management token carries the tenant it was issued for, an API key the
 * one it was created in, and a suspended tenant is refused outright.
 */
async function phaseTenantCredential() {
  const { app, dbName, storagePath } = await bootServer('credential');
  const server = await listen(app);
  const port = server.address().port;
  const db = app.locals.db;

  /**
   * Log in and return the session.
   *
   * @param {string} username
   * @param {string} password
   * @returns {Promise<object>}
   */
  async function login(username, password) {
    const res = await request({
      hostname: '127.0.0.1',
      port,
      path: '/api/v1/auth/login',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    assert.strictEqual(res.status, 200, `login(${username}) expected 200, got ${res.status}: ${res.raw}`);
    return JSON.parse(res.raw);
  }

  try {
    // A second tenant with its own administrator.
    await db
      .prepare('INSERT INTO tenants (id, name, slug) VALUES (?, ?, ?)')
      .run(['tenant-b', '第二租户', 'tenant-b']);
    await db
      .prepare(
        'INSERT INTO users (id, tenant_id, username, email, password_hash, role) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(
        ['u-boss', 'tenant-b', 'boss', 'boss@dam.local', bcrypt.hashSync('Boss@123456', 10), 'admin'],
      );

    // --- 1) the access token carries the tenant it was issued for ----------
    const bossSession = await login('boss', 'Boss@123456');
    const bossPayload = jwt.decode(bossSession.access_token);
    assert.strictEqual(
      bossPayload.tid,
      'tenant-b',
      'the access token must carry the tenant of its user',
    );

    // --- 2) the tenant is visible on the current user ----------------------
    const meRes = await request({
      hostname: '127.0.0.1',
      port,
      path: '/api/v1/auth/me',
      method: 'GET',
      headers: { Authorization: `Bearer ${bossSession.access_token}` },
    });
    assert.strictEqual(meRes.status, 200, `/auth/me expected 200, got ${meRes.status}: ${meRes.raw}`);
    assert.strictEqual(
      JSON.parse(meRes.raw).tenant_id,
      'tenant-b',
      '/auth/me must report the tenant of the credential',
    );

    // --- 3) the seeded administrator belongs to the default tenant ---------
    const adminSession = await login('admin', 'Admin@123456');
    assert.strictEqual(
      jwt.decode(adminSession.access_token).tid,
      DEFAULT_TENANT_ID,
      'the seeded administrator must speak for the default tenant',
    );

    // --- 4) a suspended tenant is refused ----------------------------------
    await db
      .prepare('UPDATE tenants SET status = ? WHERE id = ?')
      .run(['suspended', 'tenant-b']);
    const suspendedRes = await request({
      hostname: '127.0.0.1',
      port,
      path: '/api/v1/auth/me',
      method: 'GET',
      headers: { Authorization: `Bearer ${bossSession.access_token}` },
    });
    assert.strictEqual(
      suspendedRes.status,
      403,
      `a suspended tenant must be refused, got ${suspendedRes.status}: ${suspendedRes.raw}`,
    );
    await db
      .prepare('UPDATE tenants SET status = ? WHERE id = ?')
      .run(['active', 'tenant-b']);

    // --- 5) an API key speaks for its own tenant ---------------------------
    const rawKey = 'dam_test_key_b';
    const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');
    await db
      .prepare(
        'INSERT INTO api_keys (id, tenant_id, name, key_prefix, key_hash, scopes) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(['k-b', 'tenant-b', 'tenant-b key', rawKey.slice(0, 12), keyHash, 'read']);

    const deliveryRes = await request({
      hostname: '127.0.0.1',
      port,
      path: '/api/public/v1/delivery/assets',
      method: 'GET',
      headers: { 'X-API-Key': rawKey },
    });
    assert.strictEqual(
      deliveryRes.status,
      200,
      `the delivery API must accept a key of an active tenant, got ${deliveryRes.status}: ${deliveryRes.raw}`,
    );

    // A key of a suspended tenant is refused like any other credential.
    await db
      .prepare('INSERT INTO tenants (id, name, slug, status) VALUES (?, ?, ?, ?)')
      .run(['tenant-c', '暂停租户', 'tenant-c', 'suspended']);
    const rawKeyC = 'dam_test_key_c';
    await db
      .prepare(
        'INSERT INTO api_keys (id, tenant_id, name, key_prefix, key_hash, scopes) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(
        [
          'k-c',
          'tenant-c',
          'suspended key',
          rawKeyC.slice(0, 12),
          crypto.createHash('sha256').update(rawKeyC).digest('hex'),
          'read',
        ],
      );
    const suspendedKeyRes = await request({
      hostname: '127.0.0.1',
      port,
      path: '/api/public/v1/delivery/assets',
      method: 'GET',
      headers: { 'X-API-Key': rawKeyC },
    });
    assert.strictEqual(
      suspendedKeyRes.status,
      403,
      `a key of a suspended tenant must be refused, got ${suspendedKeyRes.status}: ${suspendedKeyRes.raw}`,
    );

    console.log('tenant credential OK');
  } finally {
    await close(server);
    await closeDb(app);
    await removeFixture(dbName, storagePath);
  }
}

// --- Phase 4: cross-tenant isolation -----------------------------------------

/**
 * Build a 1x1 PNG upload body for the asset endpoints.
 *
 * @param {string} filename
 * @param {Array<[string, string]>} [fields]
 * @returns {{boundary: string, body: Buffer}}
 */
function pngUpload(filename, fields = []) {
  const boundary = '----damTenantBoundary';
  const body = buildMultipart(
    boundary,
    fields,
    [{ name: 'files', filename, contentType: 'image/png', buffer: PNG_1X1 }],
  );
  return { boundary, body };
}

/**
 * One tenant's data must never be answerable to another tenant's credential.
 *
 * The failure mode this phase exists for is the quiet one: a list that
 * returns everything, or a read by id that returns a row from another
 * tenant. A cross-tenant read must be **404**, never 403, never 200 — 403
 * would confirm the resource exists.
 */
async function phaseTenantIsolation() {
  const { app, dbName, storagePath } = await bootServer('isolation');
  const server = await listen(app);
  const port = server.address().port;
  const db = app.locals.db;

  /**
   * Call an admin endpoint with a bearer token.
   *
   * @param {string} token
   * @param {string} method
   * @param {string} requestPath
   * @param {{headers?: Record<string, string>, body?: string|Buffer, binary?: boolean}} [options]
   * @returns {Promise<{status: number, raw: string}>}
   */
  function call(token, method, requestPath, options = {}) {
    return request({
      hostname: '127.0.0.1',
      port,
      path: requestPath,
      method,
      headers: Object.assign(
        token ? { Authorization: `Bearer ${token}` } : {},
        options.headers || {},
      ),
      body: options.body,
      binary: options.binary,
    });
  }

  /**
   * Log in and return the access token.
   *
   * @param {string} username
   * @param {string} password
   * @returns {Promise<string>}
   */
  async function tokenFor(username, password) {
    const res = await request({
      hostname: '127.0.0.1',
      port,
      path: '/api/v1/auth/login',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    assert.strictEqual(
      res.status,
      200,
      `login(${username}) expected 200, got ${res.status}: ${res.raw}`,
    );
    return JSON.parse(res.raw).access_token;
  }

  /**
   * Upload one PNG for the credential's tenant.
   *
   * @param {string} token
   * @param {string} title
   * @returns {Promise<object>} the created asset
   */
  async function uploadFor(token, title) {
    const { boundary, body } = pngUpload(`${title}.png`, [['title', title]]);
    const res = await call(token, 'POST', '/api/v1/assets/upload', {
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': String(body.length),
      },
      body,
      binary: true,
    });
    assert.strictEqual(res.status, 201, `upload(${title}) expected 201, got ${res.status}: ${res.raw}`);
    const uploaded = JSON.parse(res.raw);
    assert.strictEqual(uploaded.items.length, 1, 'the upload must return exactly one asset');
    return uploaded.items[0];
  }

  try {
    // --- two tenants, an administrator each ---------------------------------
    await db
      .prepare('INSERT INTO tenants (id, name, slug) VALUES (?, ?, ?)')
      .run(['tenant-a', '租户 A', 'tenant-a']);
    await db
      .prepare('INSERT INTO tenants (id, name, slug) VALUES (?, ?, ?)')
      .run(['tenant-b', '租户 B', 'tenant-b']);
    await db
      .prepare(
        'INSERT INTO users (id, tenant_id, username, email, password_hash, role) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run([
        'u-a',
        'tenant-a',
        'alice',
        'alice@dam.local',
        bcrypt.hashSync('Alice@123456', 10),
        'admin',
      ]);
    await db
      .prepare(
        'INSERT INTO users (id, tenant_id, username, email, password_hash, role) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run([
        'u-b',
        'tenant-b',
        'bob',
        'bob@dam.local',
        bcrypt.hashSync('Bob@123456', 10),
        'admin',
      ]);
    // A platform administrator acts across every tenant.
    await db
      .prepare(
        'INSERT INTO users (id, tenant_id, username, email, password_hash, role) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run([
        'u-root',
        '*',
        'root',
        'root@dam.local',
        bcrypt.hashSync('Root@123456', 10),
        'superadmin',
      ]);

    const aliceToken = await tokenFor('alice', 'Alice@123456');
    const bobToken = await tokenFor('bob', 'Bob@123456');
    const rootToken = await tokenFor('root', 'Root@123456');

    // Each tenant owns a tag and a category, so the superadmin's view of
    // those resources can be checked — not only its view of the assets.
    // (The API keys and the webhook endpoints are created later, in the
    // superadmin section, so the isolation assertions above still see a
    // tenant with none of them.)
    for (const tenant of ['tenant-a', 'tenant-b']) {
      await db
        .prepare('INSERT INTO tags (id, tenant_id, name, slug) VALUES (?, ?, ?, ?)')
        .run([`tag-${tenant}`, tenant, `标签 ${tenant}`, `tag-${tenant}`]);
      await db
        .prepare('INSERT INTO categories (id, tenant_id, name, slug) VALUES (?, ?, ?, ?)')
        .run([`cat-${tenant}`, tenant, `分类 ${tenant}`, `cat-${tenant}`]);
    }

    const aliceAsset = await uploadFor(aliceToken, 'alice-image');
    const bobAsset = await uploadFor(bobToken, 'bob-image');

    // A job id on tenant A's asset, so the superadmin's job lookup has
    // something to find.
    await db
      .prepare('UPDATE assets SET job_id = ? WHERE id = ?')
      .run(['tenant-a-job', aliceAsset.id]);
    assert.notStrictEqual(aliceAsset.id, bobAsset.id, 'the two uploads must be distinct assets');
    assert.strictEqual(
      aliceAsset.tenant_id,
      'tenant-a',
      'the upload must belong to the caller tenant',
    );
    assert.strictEqual(
      bobAsset.tenant_id,
      'tenant-b',
      'the upload must belong to the caller tenant',
    );

    // --- 1) the list is filtered --------------------------------------------
    const aliceList = await call(aliceToken, 'GET', '/api/v1/assets?page_size=200');
    assert.strictEqual(aliceList.status, 200, `list expected 200, got ${aliceList.status}`);
    const alicePage = JSON.parse(aliceList.raw);
    assert.deepStrictEqual(
      alicePage.items.map((item) => item.id),
      [aliceAsset.id],
      'tenant A must only see its own assets',
    );
    assert.strictEqual(alicePage.total, 1, 'the total must count only the caller tenant');

    const bobList = JSON.parse((await call(bobToken, 'GET', '/api/v1/assets?page_size=200')).raw);
    assert.deepStrictEqual(
      bobList.items.map((item) => item.id),
      [bobAsset.id],
      'tenant B must only see its own assets',
    );

    // --- 2) a cross-tenant read is 404, not 403 -----------------------------
    const traversal = await call(aliceToken, 'GET', `/api/v1/assets/${bobAsset.id}`);
    assert.strictEqual(
      traversal.status,
      404,
      `a cross-tenant read must answer 404, got ${traversal.status}: ${traversal.raw}`,
    );

    // --- 3) a cross-tenant write cannot reach the row ------------------------
    const crossUpdate = await call(aliceToken, 'PUT', `/api/v1/assets/${bobAsset.id}`, {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'hijacked' }),
    });
    assert.strictEqual(
      crossUpdate.status,
      404,
      `a cross-tenant update must answer 404, got ${crossUpdate.status}: ${crossUpdate.raw}`,
    );
    const crossDelete = await call(aliceToken, 'DELETE', `/api/v1/assets/${bobAsset.id}`);
    assert.strictEqual(
      crossDelete.status,
      404,
      `a cross-tenant delete must answer 404, got ${crossDelete.status}: ${crossDelete.raw}`,
    );
    const crossRestore = await call(aliceToken, 'POST', `/api/v1/assets/${bobAsset.id}/restore`);
    assert.strictEqual(
      crossRestore.status,
      404,
      `a cross-tenant restore must answer 404, got ${crossRestore.status}: ${crossRestore.raw}`,
    );

    // The row is untouched.
    const bobAfter = await call(bobToken, 'GET', `/api/v1/assets/${bobAsset.id}`);
    assert.strictEqual(bobAfter.status, 200, 'the other tenant must still see its own asset');
    assert.strictEqual(
      JSON.parse(bobAfter.raw).title,
      'bob-image',
      'a refused cross-tenant write must not change the row',
    );

    // --- 4) the trash is per tenant too -------------------------------------
    assert.strictEqual(
      (await call(bobToken, 'DELETE', `/api/v1/assets/${bobAsset.id}`)).status,
      204,
      'tenant B must be able to delete its own asset',
    );
    const aliceTrash = JSON.parse(
      (await call(aliceToken, 'GET', '/api/v1/assets?status=deleted&page_size=200')).raw,
    );
    assert.deepStrictEqual(aliceTrash.items, [], 'another tenant must not see the trash');
    const bobTrash = JSON.parse(
      (await call(bobToken, 'GET', '/api/v1/assets?status=deleted&page_size=200')).raw,
    );
    assert.deepStrictEqual(
      bobTrash.items.map((item) => item.id),
      [bobAsset.id],
      'a tenant must see its own trash',
    );
    assert.strictEqual(
      (await call(bobToken, 'POST', `/api/v1/assets/${bobAsset.id}/restore`)).status,
      200,
      'a tenant must be able to restore its own asset',
    );

    // --- 5) the catalogue is per tenant -------------------------------------
    const aliceCategory = JSON.parse(
      (
        await call(aliceToken, 'POST', '/api/v1/categories', {
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: '共享分类名' }),
        })
      ).raw,
    );
    const bobCategoryRes = await call(bobToken, 'POST', '/api/v1/categories', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '共享分类名' }),
    });
    assert.strictEqual(
      bobCategoryRes.status,
      201,
      `two tenants must be able to share a category name, got ${bobCategoryRes.status}: ${bobCategoryRes.raw}`,
    );
    const bobCategory = JSON.parse(bobCategoryRes.raw);
    assert.notStrictEqual(
      aliceCategory.id,
      bobCategory.id,
      'the two categories must be distinct rows',
    );

    const aliceCategories = JSON.parse((await call(aliceToken, 'GET', '/api/v1/categories')).raw);
    assert.ok(
      aliceCategories.some((row) => row.id === aliceCategory.id),
      'tenant A must see its own category',
    );
    assert.ok(
      !aliceCategories.some((row) => row.id === bobCategory.id),
      "tenant A must not see tenant B's category",
    );
    assert.strictEqual(
      (await call(aliceToken, 'DELETE', `/api/v1/categories/${bobCategory.id}`)).status,
      404,
      'a cross-tenant category delete must answer 404',
    );

    const aliceTag = JSON.parse(
      (
        await call(aliceToken, 'POST', '/api/v1/tags', {
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: '共享标签名' }),
        })
      ).raw,
    );
    const bobTagRes = await call(bobToken, 'POST', '/api/v1/tags', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '共享标签名' }),
    });
    assert.strictEqual(
      bobTagRes.status,
      201,
      `two tenants must be able to share a tag name, got ${bobTagRes.status}: ${bobTagRes.raw}`,
    );
    const bobTag = JSON.parse(bobTagRes.raw);
    const aliceTags = JSON.parse((await call(aliceToken, 'GET', '/api/v1/tags')).raw);
    assert.ok(
      aliceTags.some((row) => row.id === aliceTag.id),
      'tenant A must see its own tag',
    );
    assert.ok(
      !aliceTags.some((row) => row.id === bobTag.id),
      "tenant A must not see tenant B's tag",
    );
    assert.strictEqual(
      (await call(aliceToken, 'DELETE', `/api/v1/tags/${bobTag.id}`)).status,
      404,
      'a cross-tenant tag delete must answer 404',
    );

    // --- 6) users are per tenant --------------------------------------------
    const aliceUsers = JSON.parse(
      (await call(aliceToken, 'GET', '/api/v1/users?page_size=200')).raw,
    );
    assert.deepStrictEqual(
      aliceUsers.items.map((row) => row.username),
      ['alice'],
      'a tenant sees only its own users',
    );
    assert.strictEqual(
      (
        await call(aliceToken, 'POST', '/api/v1/users', {
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: 'bob', password: 'Bob@123456', role: 'viewer' }),
        })
      ).status,
      201,
      'a username taken in another tenant must still be free in this one',
    );
    assert.strictEqual(
      (
        await call(aliceToken, 'PUT', '/api/v1/users/u-b', {
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ display_name: 'hijacked' }),
        })
      ).status,
      404,
      'a cross-tenant user update must answer 404',
    );

    // --- 7) keys, webhooks and stats are per tenant -------------------------
    const aliceKeys = JSON.parse((await call(aliceToken, 'GET', '/api/v1/api-keys')).raw);
    assert.deepStrictEqual(aliceKeys, [], 'a new tenant starts with no API keys');

    const bobWebhookRes = await call(bobToken, 'POST', '/api/v1/webhooks', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'bob hook', url: 'https://example.invalid/hook' }),
    });
    assert.strictEqual(
      bobWebhookRes.status,
      201,
      `webhook create expected 201, got ${bobWebhookRes.status}: ${bobWebhookRes.raw}`,
    );
    const bobWebhook = JSON.parse(bobWebhookRes.raw);
    const aliceWebhooks = JSON.parse((await call(aliceToken, 'GET', '/api/v1/webhooks')).raw);
    assert.deepStrictEqual(
      aliceWebhooks,
      [],
      "a tenant must not see another tenant's webhooks",
    );
    assert.strictEqual(
      (await call(aliceToken, 'DELETE', `/api/v1/webhooks/${bobWebhook.id}`)).status,
      404,
      'a cross-tenant webhook delete must answer 404',
    );

    const aliceStats = JSON.parse((await call(aliceToken, 'GET', '/api/v1/stats')).raw);
    assert.strictEqual(aliceStats.total, 1, 'the stats must count only the caller tenant');
    assert.strictEqual(aliceStats.recent.length, 1, 'the recent list must be scoped too');
    const aliceDashboard = JSON.parse(
      (await call(aliceToken, 'GET', '/api/v1/stats/dashboard')).raw,
    );
    assert.strictEqual(
      aliceDashboard.summary.total_assets,
      1,
      'the dashboard must be scoped too',
    );
    assert.strictEqual(
      aliceDashboard.summary.user_count,
      2,
      'the dashboard user count must count only the tenant (alice + the viewer just created)',
    );

    // --- 8) the platform administrator sees every tenant ---------------------
    const rootList = JSON.parse(
      (await call(rootToken, 'GET', '/api/v1/assets?page_size=200')).raw,
    );
    assert.deepStrictEqual(
      rootList.items.map((item) => item.id).sort(),
      [aliceAsset.id, bobAsset.id].sort(),
      "a superadmin must see every tenant's assets",
    );
    for (const item of rootList.items) {
      assert.ok(item.tenant_id, 'every asset must report the tenant it belongs to');
    }
    assert.strictEqual(
      new Set(rootList.items.map((item) => item.tenant_id)).size,
      2,
      'the superadmin list must carry both tenants',
    );

    // --- 8b) the platform administrator sees every tenant, everywhere -------
    //
    // The asset list was the only route that honoured the wildcard. Every
    // other resource has to honour it too, or the platform administrator
    // opens the API-keys page and sees nothing.
    //
    // The keys and the endpoints are created here rather than in the setup,
    // so the isolation assertions above still meet a tenant that has none.
    for (const tenant of ['tenant-a', 'tenant-b']) {
      await db
        .prepare(
          'INSERT INTO api_keys (id, tenant_id, name, key_prefix, key_hash, scopes) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .run([
          `key-${tenant}`,
          tenant,
          `${tenant} key`,
          `dam_${tenant}`,
          crypto.createHash('sha256').update(`dam_${tenant}_raw`).digest('hex'),
          'read,upload',
        ]);
      await db
        .prepare(
          'INSERT INTO webhook_endpoints (id, tenant_id, name, url, secret, events, is_active) VALUES (?, ?, ?, ?, ?, ?, 1)',
        )
        .run([
          `hook-${tenant}`,
          tenant,
          `${tenant} hook`,
          'http://127.0.0.1:9/unreachable',
          'a-secret',
          'asset.created',
        ]);
    }

    const rootStats = JSON.parse((await call(rootToken, 'GET', '/api/v1/stats')).raw);
    assert.strictEqual(
      rootStats.total,
      2,
      "a superadmin's stats must count every tenant's assets",
    );
    assert.strictEqual(
      rootStats.recent.length,
      2,
      "a superadmin's recent list must cover every tenant",
    );

    const rootDashboard = JSON.parse(
      (await call(rootToken, 'GET', '/api/v1/stats/dashboard')).raw,
    );
    assert.strictEqual(
      rootDashboard.summary.total_assets,
      2,
      "a superadmin's dashboard must count every tenant's assets",
    );
    // The superadmin's own row carries `tenant_id = '*'`, so the count is the
    // tenants' four users plus the superadmin itself.
    assert.strictEqual(
      rootDashboard.summary.user_count,
      5,
      "a superadmin's dashboard must count every tenant's users",
    );

    // These routes answer with a bare array; `/users` answers with a page.
    const rootKeys = JSON.parse((await call(rootToken, 'GET', '/api/v1/api-keys')).raw);
    assert.ok(
      Array.isArray(rootKeys) && rootKeys.length > 0,
      "a superadmin must see the tenants' API keys",
    );

    const rootHooks = JSON.parse((await call(rootToken, 'GET', '/api/v1/webhooks')).raw);
    assert.ok(
      Array.isArray(rootHooks) && rootHooks.length > 0,
      "a superadmin must see the tenants' webhook endpoints",
    );

    const rootTags = JSON.parse((await call(rootToken, 'GET', '/api/v1/tags')).raw);
    assert.ok(
      Array.isArray(rootTags) && rootTags.length > 0,
      "a superadmin must see the tenants' tags",
    );

    const rootCategories = JSON.parse(
      (await call(rootToken, 'GET', '/api/v1/categories')).raw,
    );
    assert.ok(
      Array.isArray(rootCategories) && rootCategories.length > 0,
      "a superadmin must see the tenants' categories",
    );

    const rootUsers = JSON.parse((await call(rootToken, 'GET', '/api/v1/users')).raw);
    assert.ok(
      Array.isArray(rootUsers.items) && rootUsers.items.length > 0,
      "a superadmin must see the tenants' users",
    );

    const rootJob = await call(rootToken, 'GET', '/api/v1/jobs/by-comfyui/tenant-a-job');
    assert.strictEqual(
      rootJob.status,
      200,
      `a superadmin must find a job of any tenant, got ${rootJob.status}: ${rootJob.raw}`,
    );

    // --- 9) the delivery API is scoped by the key's tenant -------------------
    const rawKeyA = 'dam_tenant_a_key';
    await db
      .prepare(
        'INSERT INTO api_keys (id, tenant_id, name, key_prefix, key_hash, scopes) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run([
        'key-a',
        'tenant-a',
        'tenant A key',
        rawKeyA.slice(0, 12),
        crypto.createHash('sha256').update(rawKeyA).digest('hex'),
        'read',
      ]);
    const delivery = await request({
      hostname: '127.0.0.1',
      port,
      path: '/api/public/v1/delivery/assets?page_size=200',
      method: 'GET',
      headers: { 'X-API-Key': rawKeyA },
    });
    assert.strictEqual(
      delivery.status,
      200,
      `delivery expected 200, got ${delivery.status}: ${delivery.raw}`,
    );
    assert.deepStrictEqual(
      JSON.parse(delivery.raw).items.map((item) => item.id),
      [aliceAsset.id],
      "an API key must only return its own tenant's assets",
    );

    // --- 10) a webhook only fires for its own tenant's events ---------------
    const hookHits = [];
    const hookServer = http.createServer((hookReq, hookRes) => {
      let payload = '';
      hookReq.on('data', (chunk) => {
        payload += chunk;
      });
      hookReq.on('end', () => {
        hookHits.push(payload);
        hookRes.statusCode = 200;
        hookRes.end('ok');
      });
    });
    await new Promise((resolve) => hookServer.listen(0, '127.0.0.1', resolve));
    const hookPort = hookServer.address().port;

    await db
      .prepare('UPDATE webhook_endpoints SET url = ? WHERE id = ?')
      .run([`http://127.0.0.1:${hookPort}/hook`, bobWebhook.id]);

    // Both tenants now touch their own asset. The update fires an event for
    // each, and only tenant B's endpoint may receive one — the same file
    // twice would be a no-op (a duplicate), so the update is what produces a
    // fresh event on both sides.
    const aliceUpdate = await call(aliceToken, 'PUT', `/api/v1/assets/${aliceAsset.id}`, {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'alice-second' }),
    });
    assert.strictEqual(aliceUpdate.status, 200, 'tenant A must update its own asset');
    const bobUpdate = await call(bobToken, 'PUT', `/api/v1/assets/${bobAsset.id}`, {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'bob-second' }),
    });
    assert.strictEqual(bobUpdate.status, 200, 'tenant B must update its own asset');

    await waitFor(() => hookHits.length > 0, 5000, 'the webhook of tenant B must fire');
    // Give a stray delivery to tenant A's (nonexistent) endpoint time to
    // arrive, so a cross-tenant leak cannot pass by being merely late.
    await sleep(300);
    const fired = hookHits.map((raw) => JSON.parse(raw));
    assert.ok(
      fired.every((envelope) => envelope.payload.tenant_id === 'tenant-b'),
      `a webhook must only receive its own tenant's events, saw: ${fired
        .map((envelope) => envelope.payload.tenant_id)
        .join(', ')}`,
    );
    assert.ok(
      !fired.some((envelope) => envelope.payload.title === 'alice-second'),
      "tenant A's event must not reach tenant B's webhook",
    );

    if (typeof hookServer.closeAllConnections === 'function') {
      hookServer.closeAllConnections();
    }
    await new Promise((resolve) => hookServer.close(resolve));

    console.log('cross-tenant isolation OK');
  } finally {
    await close(server);
    await closeDb(app);
    await removeFixture(dbName, storagePath);
  }
}

// --- Phase 5: upload endpoint ------------------------------------------------

async function phaseUpload() {
  const { app, dbName, storagePath } = await bootServer('upload');
  const server = await listen(app);
  const port = server.address().port;
  try {
    const token = await mintAdminToken(dbName);
    const res = await uploadFile(port, token, {
      fields: [
        ['source_tool', 'comfyui'],
        ['prompt', 'a beautiful sunset over mountains'],
        ['seed', '42'],
        ['model_name', 'sdxl-1.0'],
        ['job_id', 'job-abc-123'],
        ['metadata', '{"steps":30,"cfg":7.5}'],
      ],
    });

    assert.strictEqual(res.status, 201, `expected 201, got ${res.status}: ${res.raw}`);
    const parsed = JSON.parse(res.raw);
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
    assert.strictEqual(asset.status, 'ready', `expected status=ready, got ${asset.status}`);
    assert.ok(asset.id, 'expected asset.id to be set');
    assert.ok(Array.isArray(asset.tag_names), 'expected tag_names to be an array');

    console.log('upload endpoint OK');
  } finally {
    await close(server);
    await closeDb(app);
    await removeFixture(dbName, storagePath);
  }
}

// --- Phase 3: oversized upload ----------------------------------------------

async function phaseFileSizeLimit() {
  const { app, dbName, storagePath } = await bootServer('filesize', { UPLOAD_MAX_FILE_SIZE_MB: '1' });
  const server = await listen(app);
  const port = server.address().port;
  try {
    const token = await mintAdminToken(dbName);
    // A MiB plus 64 KiB — comfortably above the 1 MiB limit.
    const oversized = Buffer.alloc((1 * 1024 * 1024) + (64 * 1024), 0x41);
    const res = await uploadFile(port, token, { filename: 'big.bin', buffer: oversized });

    assert.strictEqual(res.status, 413, `expected 413, got ${res.status}: ${res.raw}`);
    const parsed = JSON.parse(res.raw);
    assert.strictEqual(parsed.code, 'FILE_TOO_LARGE', `expected code=FILE_TOO_LARGE, got ${parsed.code}`);
    assert.ok(parsed.request_id, 'expected request_id to be set');

    console.log('413 file size limit OK');
  } finally {
    await close(server);
    await closeDb(app);
    delete process.env.UPLOAD_MAX_FILE_SIZE_MB;
    await removeFixture(dbName, storagePath);
  }
}

// --- Phase 4: webhooks -------------------------------------------------------

async function phaseWebhooks() {
  const { app, dbName, storagePath } = await bootServer('webhook');
  const db = app.locals.db;
  const server = await listen(app);
  const port = server.address().port;

  // Tiny HTTP capture server: records the calls, answers 200.
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
  const capturePort = await new Promise((resolve) => {
    captureServer.listen(0, '127.0.0.1', () => resolve(captureServer.address().port));
  });
  const webhookUrl = `http://127.0.0.1:${capturePort}/hook`;

  try {
    const token = await mintAdminToken(dbName);
    const authHeaders = (extra) => Object.assign({ Authorization: `Bearer ${token}` }, extra || {});

    // --- 1) POST /api/v1/webhooks -----------------------------------------
    const created = await request({
      hostname: '127.0.0.1',
      port,
      path: '/api/v1/webhooks',
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ name: 'CaptureHook', url: webhookUrl }),
    });
    assert.strictEqual(created.status, 201, `POST /api/v1/webhooks expected 201, got ${created.status}: ${created.raw}`);
    const createdBody = JSON.parse(created.raw);
    assert.ok(createdBody.id, 'webhook id missing');
    assert.ok(
      createdBody.secret && /^[0-9a-f]{48}$/.test(createdBody.secret),
      `webhook secret must be 48-char lowercase hex, got: ${createdBody.secret}`,
    );
    assert.strictEqual(createdBody.url, webhookUrl, 'webhook url echo mismatch');
    assert.ok(createdBody.warning, 'POST response must include save-secret warning');

    // --- 2) GET /api/v1/webhooks ------------------------------------------
    const listed = await request({
      hostname: '127.0.0.1',
      port,
      path: '/api/v1/webhooks',
      method: 'GET',
      headers: authHeaders(),
    });
    assert.strictEqual(listed.status, 200, `GET /api/v1/webhooks expected 200, got ${listed.status}: ${listed.raw}`);
    const listedBody = JSON.parse(listed.raw);
    assert.ok(Array.isArray(listedBody) && listedBody.length === 1, `expected 1 webhook in list, got ${listedBody.length}`);
    assert.strictEqual(listedBody[0].id, createdBody.id, 'webhook id mismatch');
    assert.strictEqual(listedBody[0].is_active, true, 'webhook must default to active');
    assert.ok(!('secret' in listedBody[0]), 'GET must not leak secret');

    // --- 3) Upload an asset -> webhook_logs gains a row -------------------
    const uploadRes = await uploadFile(port, token, { filename: 'wh.png', fields: [['source_tool', 'test']] });
    assert.strictEqual(uploadRes.status, 201, `upload expected 201, got ${uploadRes.status}: ${uploadRes.raw}`);
    const uploadBodyParsed = JSON.parse(uploadRes.raw);
    assert.strictEqual(uploadBodyParsed.count, 1, `expected count=1, got ${uploadBodyParsed.count}`);
    const createdAsset = uploadBodyParsed.items[0];
    assert.ok(createdAsset.id, 'uploaded asset must have id');

    // The dispatch is asynchronous (it retries with backoff), so poll the
    // log table instead of sleeping for a fixed amount of time.
    await waitFor(
      async () => {
        const rows = await queryFixture(
          dbName,
          'SELECT id, status, attempts, payload, event FROM webhook_logs WHERE endpoint_id = ?',
          [createdBody.id],
        );
        const row = rows[0];
        return row && row.status === 'done';
      },
      10000,
      'webhook_logs row for asset.created',
    );

    const logRows = await queryFixture(
      dbName,
      'SELECT status, attempts, payload, event FROM webhook_logs WHERE endpoint_id = ?',
      [createdBody.id],
    );
    const logRow = logRows[0];
    assert.ok(logRow, 'webhook_logs row missing for endpoint');
    assert.strictEqual(logRow.event, 'asset.created', `expected event=asset.created, got ${logRow.event}`);
    assert.strictEqual(logRow.status, 'done', `expected status=done, got ${logRow.status}`);
    const envelope = JSON.parse(logRow.payload);
    assert.strictEqual(envelope.event, 'asset.created', 'envelope.event must match');
    assert.ok(envelope.payload && envelope.payload.id === createdAsset.id, 'envelope.payload must echo asset id');
    assert.ok(envelope.ts, 'envelope.ts must be set');

    const assetCreatedCall = captureRef.calls.find((c) => c.method === 'POST' && c.url === '/hook');
    assert.ok(assetCreatedCall, 'capture server did not receive the POST');
    assert.ok(
      (assetCreatedCall.headers['x-dam-signature'] || '').startsWith('sha256='),
      'missing X-DAM-Signature header',
    );
    assert.strictEqual(assetCreatedCall.headers['x-dam-event'], 'asset.created', 'missing X-DAM-Event header');

    // --- 4) PUT the asset -> 'asset.updated' -------------------------------
    const putRes = await request({
      hostname: '127.0.0.1',
      port,
      path: `/api/v1/assets/${createdAsset.id}`,
      method: 'PUT',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ title: 'Renamed by webhook test' }),
    });
    assert.strictEqual(putRes.status, 200, `PUT expected 200, got ${putRes.status}: ${putRes.raw}`);

    await waitFor(
      async () => {
        const rows = await queryFixture(
          dbName,
          "SELECT COUNT(*) AS c FROM webhook_logs WHERE endpoint_id = ? AND event = 'asset.updated'",
          [createdBody.id],
        );
        return rows[0].c >= 1;
      },
      10000,
      'webhook_logs row for asset.updated',
    );

    // --- 4b) the ingest metadata path -> 'asset.metadata_updated' ----------
    // The event exists for the caller that changes metadata *without* going
    // through the admin update route: an ingest integration pushing a new
    // title or tag list is not an admin edit, and a receiver subscribed to
    // the admin event should not have to guess.
    // tenant-lint: allow the endpoint row is read by id inside one tenant
    const rawKey = 'dam_metadata_event_key';
    await db
      .prepare(
        'INSERT INTO api_keys (id, tenant_id, name, key_prefix, key_hash, scopes) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run([
        'key-metadata',
        DEFAULT_TENANT_ID,
        'metadata event key',
        rawKey.slice(0, 12),
        crypto.createHash('sha256').update(rawKey).digest('hex'),
        'read,write',
      ]);

    const metadataRes = await request({
      hostname: '127.0.0.1',
      port,
      path: `/api/ingest/v1/assets/${createdAsset.id}/metadata`,
      method: 'POST',
      headers: { 'X-API-Key': rawKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'renamed by ingest', tags: ['封面'] }),
    });
    assert.strictEqual(
      metadataRes.status,
      200,
      `ingest metadata expected 200, got ${metadataRes.status}: ${metadataRes.raw}`,
    );
    await waitFor(
      async () => {
        const rows = await queryFixture(
          dbName,
          "SELECT COUNT(*) AS c FROM webhook_logs WHERE endpoint_id = ? AND event = 'asset.metadata_updated'",
          [createdBody.id],
        );
        return rows[0].c >= 1;
      },
      10000,
      'webhook_logs row for asset.metadata_updated',
    );

    // --- 5) DELETE the asset -> 'asset.deleted' ----------------------------
    const delRes = await request({
      hostname: '127.0.0.1',
      port,
      path: `/api/v1/assets/${createdAsset.id}`,
      method: 'DELETE',
      headers: authHeaders(),
    });
    assert.strictEqual(delRes.status, 204, `DELETE expected 204, got ${delRes.status}: ${delRes.raw}`);

    await waitFor(
      async () => {
        const rows = await queryFixture(
          dbName,
          "SELECT COUNT(*) AS c FROM webhook_logs WHERE endpoint_id = ? AND event = 'asset.deleted'",
          [createdBody.id],
        );
        return rows[0].c >= 1;
      },
      10000,
      'webhook_logs row for asset.deleted',
    );

    // --- 5b) restore the asset -> 'asset.restored' --------------------------
    // Restoring is the mirror image of the soft delete, and a receiver that
    // tracks the library through events has no other way to learn about it.
    const restoreRes = await request({
      hostname: '127.0.0.1',
      port,
      path: `/api/v1/assets/${createdAsset.id}/restore`,
      method: 'POST',
      headers: authHeaders(),
    });
    assert.strictEqual(
      restoreRes.status,
      200,
      `restore expected 200, got ${restoreRes.status}: ${restoreRes.raw}`,
    );
    await waitFor(
      async () => {
        const rows = await queryFixture(
          dbName,
          "SELECT COUNT(*) AS c FROM webhook_logs WHERE endpoint_id = ? AND event = 'asset.restored'",
          [createdBody.id],
        );
        return rows[0].c >= 1;
      },
      10000,
      'webhook_logs row for asset.restored',
    );

    // --- 6) DELETE /api/v1/webhooks/:id (soft-disable) ----------------------
    const delHook = await request({
      hostname: '127.0.0.1',
      port,
      path: `/api/v1/webhooks/${createdBody.id}`,
      method: 'DELETE',
      headers: authHeaders(),
    });
    assert.strictEqual(delHook.status, 204, `DELETE webhook expected 204, got ${delHook.status}: ${delHook.raw}`);

    const epFinalRows = await queryFixture(
      dbName,
      'SELECT is_active FROM webhook_endpoints WHERE id = ?',
      [createdBody.id],
    );
    assert.strictEqual(epFinalRows[0].is_active, 0, 'DELETE webhook must soft-disable');

    // After the soft-disable, uploading again must NOT enqueue a new log row.
    const countLogs = async () => {
      const rows = await queryFixture(
        dbName,
        'SELECT COUNT(*) AS c FROM webhook_logs WHERE endpoint_id = ?',
        [createdBody.id],
      );
      return rows[0].c;
    };
    const logCountBefore = await countLogs();

    // A different payload: the upload endpoint deduplicates by content hash,
    // so re-sending the same bytes would resurrect the deleted asset
    // instead of creating a new one.
    await uploadFile(port, token, {
      filename: 'wh2.txt',
      contentType: 'text/plain',
      buffer: Buffer.from('a second, different payload'),
    });
    await sleep(500);
    const logCountAfter = await countLogs();
    assert.strictEqual(
      logCountAfter,
      logCountBefore,
      `disabled endpoint must NOT emit; before=${logCountBefore} after=${logCountAfter}`,
    );

    console.log('webhook CRUD + asset event dispatch OK');
  } finally {
    if (typeof captureServer.closeAllConnections === 'function') {
      captureServer.closeAllConnections();
    }
    await new Promise((resolve) => captureServer.close(resolve));
    await close(server);
    await closeDb(app);
    await removeFixture(dbName, storagePath);
  }
}

// --- Phase 5: lifecycle (auth, users, deletion states, chunked upload) ------

async function phaseLifecycle() {
  const { app, dbName, storagePath } = await bootServer('lifecycle');
  const server = await listen(app);
  const port = server.address().port;
  try {
    // --- 1) login ----------------------------------------------------------
    const loginRes = await request({
      hostname: '127.0.0.1',
      port,
      path: '/api/v1/auth/login',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'Admin@123456' }),
    });
    assert.strictEqual(loginRes.status, 200, `login expected 200, got ${loginRes.status}: ${loginRes.raw}`);
    const session = JSON.parse(loginRes.raw);
    assert.ok(session.access_token, 'login must return an access_token');
    assert.ok(session.refresh_token, 'login must return a refresh_token');
    assert.strictEqual(session.token_type, 'bearer', 'login must return token_type=bearer');
    assert.strictEqual(session.user.username, 'admin', 'login must echo the user');
    assert.strictEqual(session.user.status, 'active', 'seeded admin must be active');

    const authHeaders = (extra) => Object.assign({ Authorization: `Bearer ${session.access_token}` }, extra || {});

    // --- 2) refresh rotates the refresh token ------------------------------
    const refreshRes = await request({
      hostname: '127.0.0.1',
      port,
      path: '/api/v1/auth/refresh',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: session.refresh_token }),
    });
    assert.strictEqual(refreshRes.status, 200, `refresh expected 200, got ${refreshRes.status}: ${refreshRes.raw}`);
    const rotated = JSON.parse(refreshRes.raw);
    assert.ok(rotated.access_token, 'refresh must return a new access_token');
    assert.ok(rotated.refresh_token, 'refresh must return a new refresh_token');
    assert.notStrictEqual(rotated.refresh_token, session.refresh_token, 'refresh must rotate the refresh token');

    // The consumed refresh token is burned.
    const reuseRes = await request({
      hostname: '127.0.0.1',
      port,
      path: '/api/v1/auth/refresh',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: session.refresh_token }),
    });
    assert.strictEqual(reuseRes.status, 401, `reusing a refresh token must fail, got ${reuseRes.status}`);

    // --- 3) /auth/me -------------------------------------------------------
    const meRes = await request({
      hostname: '127.0.0.1',
      port,
      path: '/api/v1/auth/me',
      method: 'GET',
      headers: authHeaders(),
    });
    assert.strictEqual(meRes.status, 200, `/auth/me expected 200, got ${meRes.status}: ${meRes.raw}`);
    assert.strictEqual(JSON.parse(meRes.raw).username, 'admin', '/auth/me must return the current user');

    // --- 4) user CRUD ------------------------------------------------------
    const createUserRes = await request({
      hostname: '127.0.0.1',
      port,
      path: '/api/v1/users',
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        username: 'viewer1',
        email: 'viewer1@dam.local',
        password: 'Viewer@123456',
        display_name: 'Viewer One',
        role: 'viewer',
      }),
    });
    assert.strictEqual(createUserRes.status, 201, `POST /users expected 201, got ${createUserRes.status}: ${createUserRes.raw}`);
    const createdUser = JSON.parse(createUserRes.raw);
    assert.ok(createdUser.id, 'created user must have an id');
    assert.strictEqual(createdUser.status, 'active', 'created user must be active');
    assert.strictEqual(createdUser.is_superuser, false, 'a viewer is not a superuser');
    assert.strictEqual(createdUser.display_name, 'Viewer One', 'created user must keep the display name');

    const listUsersRes = await request({
      hostname: '127.0.0.1',
      port,
      path: '/api/v1/users?keyword=viewer1',
      method: 'GET',
      headers: authHeaders(),
    });
    assert.strictEqual(listUsersRes.status, 200, `GET /users expected 200, got ${listUsersRes.status}: ${listUsersRes.raw}`);
    const listedUsers = JSON.parse(listUsersRes.raw);
    assert.strictEqual(listedUsers.total, 1, `expected 1 matching user, got ${listedUsers.total}`);
    assert.strictEqual(listedUsers.items[0].id, createdUser.id, 'listed user id mismatch');

    const updateUserRes = await request({
      hostname: '127.0.0.1',
      port,
      path: `/api/v1/users/${createdUser.id}`,
      method: 'PUT',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ display_name: 'Viewer One (disabled)', status: 'disabled' }),
    });
    assert.strictEqual(updateUserRes.status, 200, `PUT /users/:id expected 200, got ${updateUserRes.status}: ${updateUserRes.raw}`);
    assert.strictEqual(JSON.parse(updateUserRes.raw).status, 'disabled', 'user must be disabled');

    const resetRes = await request({
      hostname: '127.0.0.1',
      port,
      path: `/api/v1/users/${createdUser.id}/reset-password?new_password=Reset@123456`,
      method: 'POST',
      headers: authHeaders(),
    });
    assert.strictEqual(resetRes.status, 204, `reset-password expected 204, got ${resetRes.status}: ${resetRes.raw}`);

    const deleteUserRes = await request({
      hostname: '127.0.0.1',
      port,
      path: `/api/v1/users/${createdUser.id}`,
      method: 'DELETE',
      headers: authHeaders(),
    });
    assert.strictEqual(deleteUserRes.status, 204, `DELETE /users/:id expected 204, got ${deleteUserRes.status}: ${deleteUserRes.raw}`);

    const listAfterDeleteRes = await request({
      hostname: '127.0.0.1',
      port,
      path: '/api/v1/users?keyword=viewer1',
      method: 'GET',
      headers: authHeaders(),
    });
    assert.strictEqual(
      JSON.parse(listAfterDeleteRes.raw).total,
      0,
      'a deleted user must no longer appear in the listing',
    );

    // --- 5) logout invalidates the access token ---------------------------
    const logoutRes = await request({
      hostname: '127.0.0.1',
      port,
      path: '/api/v1/auth/logout',
      method: 'POST',
      headers: authHeaders(),
    });
    assert.strictEqual(logoutRes.status, 204, `logout expected 204, got ${logoutRes.status}: ${logoutRes.raw}`);

    const afterLogoutRes = await request({
      hostname: '127.0.0.1',
      port,
      path: '/api/v1/auth/me',
      method: 'GET',
      headers: authHeaders(),
    });
    assert.strictEqual(afterLogoutRes.status, 401, `a revoked token must be rejected, got ${afterLogoutRes.status}`);

    // --- 6) soft delete -> hidden -> restore --------------------------------
    const freshToken = rotated.access_token;
    const freshAuth = (extra) => Object.assign({ Authorization: `Bearer ${freshToken}` }, extra || {});

    const uploadRes = await uploadFile(port, freshToken, { filename: 'lifecycle.png' });
    assert.strictEqual(uploadRes.status, 201, `upload expected 201, got ${uploadRes.status}: ${uploadRes.raw}`);
    const asset = JSON.parse(uploadRes.raw).items[0];

    const softDeleteRes = await request({
      hostname: '127.0.0.1',
      port,
      path: `/api/v1/assets/${asset.id}`,
      method: 'DELETE',
      headers: freshAuth(),
    });
    assert.strictEqual(softDeleteRes.status, 204, `soft delete expected 204, got ${softDeleteRes.status}: ${softDeleteRes.raw}`);

    const afterDeleteRes = await request({
      hostname: '127.0.0.1',
      port,
      path: `/api/v1/assets/${asset.id}`,
      method: 'GET',
      headers: freshAuth(),
    });
    assert.strictEqual(afterDeleteRes.status, 200, `a soft-deleted asset must still be readable, got ${afterDeleteRes.status}`);
    const deletedAsset = JSON.parse(afterDeleteRes.raw);
    assert.strictEqual(deletedAsset.status, 'deleted', `expected status=deleted, got ${deletedAsset.status}`);
    assert.ok(deletedAsset.deleted_at, 'a soft-deleted asset must carry deleted_at');

    const visibleList = await request({
      hostname: '127.0.0.1',
      port,
      path: '/api/v1/assets?page_size=200',
      method: 'GET',
      headers: freshAuth(),
    });
    const visibleIds = JSON.parse(visibleList.raw).items.map((item) => item.id);
    assert.ok(!visibleIds.includes(asset.id), 'a soft-deleted asset must be hidden from the default listing');

    const trashList = await request({
      hostname: '127.0.0.1',
      port,
      path: '/api/v1/assets?status=deleted&page_size=200',
      method: 'GET',
      headers: freshAuth(),
    });
    const trashIds = JSON.parse(trashList.raw).items.map((item) => item.id);
    assert.ok(trashIds.includes(asset.id), 'a soft-deleted asset must appear in the trash listing');

    const restoreRes = await request({
      hostname: '127.0.0.1',
      port,
      path: `/api/v1/assets/${asset.id}/restore`,
      method: 'POST',
      headers: freshAuth(),
    });
    assert.strictEqual(restoreRes.status, 200, `restore expected 200, got ${restoreRes.status}: ${restoreRes.raw}`);
    const restored = JSON.parse(restoreRes.raw);
    assert.strictEqual(restored.status, 'ready', `expected status=ready after restore, got ${restored.status}`);
    assert.strictEqual(restored.deleted_at, null, 'restore must clear deleted_at');

    // --- 7) permanent delete ------------------------------------------------
    const hardDeleteRes = await request({
      hostname: '127.0.0.1',
      port,
      path: `/api/v1/assets/${asset.id}?permanent=true`,
      method: 'DELETE',
      headers: freshAuth(),
    });
    assert.strictEqual(hardDeleteRes.status, 204, `permanent delete expected 204, got ${hardDeleteRes.status}: ${hardDeleteRes.raw}`);

    const goneRes = await request({
      hostname: '127.0.0.1',
      port,
      path: `/api/v1/assets/${asset.id}`,
      method: 'GET',
      headers: freshAuth(),
    });
    assert.strictEqual(goneRes.status, 404, `a permanently deleted asset must be gone, got ${goneRes.status}`);

    // --- 8) chunked upload --------------------------------------------------
    const chunkSize = 256 * 1024;
    const payload = Buffer.alloc(chunkSize * 2 + 1024, 0x42);
    const initRes = await request({
      hostname: '127.0.0.1',
      port,
      path: '/api/v1/upload/init',
      method: 'POST',
      headers: freshAuth({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        filename: 'chunked.bin',
        file_size: payload.length,
        mime_type: 'application/octet-stream',
        chunk_size: chunkSize,
      }),
    });
    assert.strictEqual(initRes.status, 201, `upload/init expected 201, got ${initRes.status}: ${initRes.raw}`);
    const session2 = JSON.parse(initRes.raw);
    assert.ok(session2.session_id, 'upload/init must return a session_id');
    assert.strictEqual(session2.chunk_size, chunkSize, `expected chunk_size=${chunkSize}, got ${session2.chunk_size}`);
    assert.strictEqual(session2.total_chunks, 3, `expected 3 chunks, got ${session2.total_chunks}`);
    assert.deepStrictEqual(session2.received_chunks, [], 'a fresh session has no chunks');

    for (let index = 0; index < session2.total_chunks; index += 1) {
      const slice = payload.subarray(index * chunkSize, (index + 1) * chunkSize);
      const boundary = '----chunk' + index + Date.now();
      const body = buildMultipart(boundary, [], [
        { name: 'chunk', filename: `${index}.part`, contentType: 'application/octet-stream', buffer: slice },
      ]);
      const chunkRes = await request({
        hostname: '127.0.0.1',
        port,
        path: `/api/v1/upload/chunk/${session2.session_id}?chunk_index=${index}`,
        method: 'PUT',
        headers: {
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': body.length,
          Authorization: `Bearer ${freshToken}`,
        },
        body,
        binary: true,
      });
      assert.strictEqual(chunkRes.status, 200, `chunk ${index} expected 200, got ${chunkRes.status}: ${chunkRes.raw}`);
      const chunkBody = JSON.parse(chunkRes.raw);
      assert.strictEqual(chunkBody.received, index + 1, `expected received=${index + 1}, got ${chunkBody.received}`);
      assert.ok(
        chunkBody.received_chunks.includes(index),
        `chunk ${index} must be listed in received_chunks`,
      );
    }

    const completeRes = await request({
      hostname: '127.0.0.1',
      port,
      path: '/api/v1/upload/complete',
      method: 'POST',
      headers: freshAuth({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ session_id: session2.session_id }),
    });
    assert.strictEqual(completeRes.status, 201, `upload/complete expected 201, got ${completeRes.status}: ${completeRes.raw}`);
    const chunkedAsset = JSON.parse(completeRes.raw);
    assert.strictEqual(chunkedAsset.file_size, payload.length, `expected file_size=${payload.length}, got ${chunkedAsset.file_size}`);
    assert.strictEqual(chunkedAsset.original_name, 'chunked.bin', 'the completed asset must keep the original filename');
    assert.strictEqual(chunkedAsset.source, 'chunked-upload', 'the completed asset must record its source');

    console.log('auth + users + deletion states + chunked upload OK');
  } finally {
    await close(server);
    await closeDb(app);
    await removeFixture(dbName, storagePath);
  }
}

// --- Phase 9: the storage files are not anonymous ----------------------------

/**
 * The stored files are served through a route that checks a signature, not
 * through a static mount.
 *
 * A static mount over the storage directory publishes every tenant's
 * originals to anybody who can name the file. The files are served instead
 * through a signed URL: the server issues the link to a caller who may
 * already see the asset, and the link grants access to that one file until
 * it expires.
 *
 * The phase asserts the three properties that matter:
 *
 *   1. an anonymous request for a stored file does not get the bytes;
 *   2. the tenant that owns the asset gets its own file;
 *   3. another tenant does not — not even with the owner's URL in hand.
 *
 * The manifest index used to sit under the same static root and enumerated
 * every tenant's assets, so it is checked too.
 */
async function phaseStorageScope() {
  const { app, dbName, storagePath } = await bootServer('storage');
  const server = await listen(app);
  const port = server.address().port;
  const db = app.locals.db;

  /**
   * @param {string} requestPath
   * @param {Record<string, string>} [headers]
   * @returns {Promise<{status: number, raw: string}>}
   */
  function get(requestPath, headers) {
    return request({
      hostname: '127.0.0.1',
      port,
      path: requestPath,
      method: 'GET',
      headers: headers || {},
      binary: true,
    });
  }

  /**
   * @param {string} username
   * @param {string} password
   * @returns {Promise<string>}
   */
  async function tokenFor(username, password) {
    const res = await request({
      hostname: '127.0.0.1',
      port,
      path: '/api/v1/auth/login',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    assert.strictEqual(
      res.status,
      200,
      `login(${username}) expected 200, got ${res.status}: ${res.raw}`,
    );
    return JSON.parse(res.raw).access_token;
  }

  /**
   * Upload one PNG for the token's tenant.
   *
   * @param {string} token
   * @param {string} title
   * @returns {Promise<object>} the created asset
   */
  async function uploadFor(token, title) {
    const { boundary, body } = pngUpload(`${title}.png`, [['title', title]]);
    const res = await request({
      hostname: '127.0.0.1',
      port,
      path: '/api/v1/assets/upload',
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': String(body.length),
        Authorization: `Bearer ${token}`,
      },
      body,
      binary: true,
    });
    assert.strictEqual(res.status, 201, `upload(${title}) expected 201, got ${res.status}: ${res.raw}`);
    return JSON.parse(res.raw).items[0];
  }

  try {
    await db
      .prepare('INSERT INTO tenants (id, name, slug) VALUES (?, ?, ?)')
      .run(['tenant-a', '租户 A', 'tenant-a']);
    await db
      .prepare('INSERT INTO tenants (id, name, slug) VALUES (?, ?, ?)')
      .run(['tenant-b', '租户 B', 'tenant-b']);
    for (const [id, tenant, username, password] of [
      ['u-a', 'tenant-a', 'alice', 'Alice@123456'],
      ['u-b', 'tenant-b', 'bob', 'Bob@123456'],
    ]) {
      await db
        .prepare(
          'INSERT INTO users (id, tenant_id, username, email, password_hash, role) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .run([id, tenant, username, `${username}@dam.local`, bcrypt.hashSync(password, 10), 'admin']);
    }

    const aliceToken = await tokenFor('alice', 'Alice@123456');
    const bobToken = await tokenFor('bob', 'Bob@123456');

    const aliceAsset = await uploadFor(aliceToken, 'alice-secret');
    const bobAsset = await uploadFor(bobToken, 'bob-secret');

    // --- 1) an unsigned URL must not work ----------------------------------
    // The URL the API hands out is signed. A caller who guesses the asset id
    // and builds the path by hand must not reach the file — that is what
    // stopped the static mount from publishing the library.
    const unsigned = aliceAsset.original_url.split('?')[0];
    const anonymous = await get(unsigned);
    assert.notStrictEqual(
      anonymous.status,
      200,
      `an unsigned URL must not reach the file, got ${anonymous.status}`,
    );
    assert.ok(
      !String(anonymous.raw).includes('PNG'),
      'the unsigned response must not carry the file bytes',
    );

    // --- 2) the signed URL works for the browser ----------------------------
    // A browser's `<img src>` cannot carry an `Authorization` header, so the
    // signed URL is the only way the frontend can show a picture. It has to
    // work without a credential.
    const signed = await get(aliceAsset.original_url);
    assert.strictEqual(
      signed.status,
      200,
      `the signed URL must open the file, got ${signed.status}`,
    );
    assert.ok(
      signed.raw.length > 0,
      'the signed URL must return the file bytes',
    );

    // --- 3) a signed URL only opens the file it was issued for --------------
    // The signature covers the path, so it cannot be moved onto another
    // asset — not even one of the caller's own.
    const movedSignature = aliceAsset.original_url.replace(
      /\/originals\/[^?]+/,
      `/originals/${bobAsset.id}${path.extname(bobAsset.original_name || '')}`,
    );
    const moved = await get(movedSignature);
    assert.notStrictEqual(
      moved.status,
      200,
      `a signature must not open another file, got ${moved.status}`,
    );

    // --- 4) the owning tenant gets its own file with its token --------------
    const owner = await get(aliceAsset.original_url, {
      Authorization: `Bearer ${aliceToken}`,
    });
    assert.strictEqual(
      owner.status,
      200,
      `the owning tenant must be able to read its own file, got ${owner.status}`,
    );

    // --- 5) another tenant must not, even with a token ----------------------
    const crossTenant = await get(aliceAsset.original_url, {
      Authorization: `Bearer ${bobToken}`,
    });
    assert.notStrictEqual(
      crossTenant.status,
      200,
      `another tenant must not read the file, got ${crossTenant.status}`,
    );
    assert.ok(
      !String(crossTenant.raw).includes('PNG'),
      "the other tenant's response must not carry the file bytes",
    );

    // --- 6) the manifest index must not enumerate the library ---------------
    const manifest = await get('/storage/manifests/index.json');
    assert.notStrictEqual(
      manifest.status,
      200,
      `the manifest index must not be readable without a credential, got ${manifest.status}`,
    );

    // --- 5) a tampered signature must not work -----------------------------
    const tampered = aliceAsset.original_url.replace(/sig=[0-9a-f]+/, 'sig=' + '0'.repeat(64));
    const tamperedRes = await get(tampered, { Authorization: `Bearer ${aliceToken}` });
    assert.notStrictEqual(
      tamperedRes.status,
      200,
      `a tampered signature must not be accepted, got ${tamperedRes.status}`,
    );

    console.log('storage files are scoped to their tenant OK');
  } finally {
    await close(server);
    await closeDb(app);
    await removeFixture(dbName, storagePath);
  }
}

// --- Runner ------------------------------------------------------------------

async function main() {
  await phaseSchema();
  await phaseTenantContext();
  await phaseTenantCredential();
  await phaseTenantIsolation();
  await phaseUpload();
  await phaseFileSizeLimit();
  await phaseWebhooks();
  await phaseLifecycle();
  await phaseStorageScope();
  console.log('all backend tests passed');
}

main().catch((error) => {
  console.error('TEST FAILED:', error && error.stack ? error.stack : error);
  process.exit(1);
});
