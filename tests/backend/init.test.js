'use strict';

/**
 * Init wizard test.
 *
 * The wizard is the only way a fresh installation becomes usable: it tests
 * the database connection, creates the schema, the administrator and the
 * first tenant, then writes the secrets. It is also the only part of the
 * server that writes a configuration file, so the atomicity of that write
 * matters.
 *
 * The suite boots the real server module against a throw-away schema and a
 * throw-away `.env` (`ENV_FILE`), so it never touches the developer's own
 * configuration.
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const assert = require('assert');
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');

const { closeWizardDb } = require('../../src/server/routes/init');

const TESTS_DIR = __dirname;
const PORT = 0;
const JWT_SECRET = 'init-test-jwt-secret';

/**
 * The schema name for this run — dropped before and after.
 *
 * @returns {string}
 */
function schemaName() {
  return `dam_test_init_${process.pid}`;
}

/**
 * An empty `envFile` the wizard can write, in its own directory.
 *
 * @returns {string}
 */
function envFilePath() {
  const dir = path.join(TESTS_DIR, 'test-init-env');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, '.env');
}

/**
 * Connect as the admin account (no schema selected).
 *
 * @returns {Promise<import('mysql2/promise').Connection>}
 */
function adminConnection() {
  return mysql.createConnection({
    host: process.env.DB_HOST || '127.0.0.1',
    port: parseInt(process.env.DB_PORT || '3306', 10),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    charset: 'utf8mb4_unicode_ci',
  });
}

/**
 * Drop the fixture schema.
 *
 * @param {string} dbName
 * @returns {Promise<void>}
 */
async function dropSchema(dbName) {
  try {
    const connection = await adminConnection();
    try {
      await connection.query(`DROP DATABASE IF EXISTS \`${dbName}\``);
    } finally {
      await connection.end();
    }
  } catch (error) {
    // Disposable fixture; the failure is reported by the assertion that
    // needed it, not here.
  }
}

/**
 * Perform an HTTP request and collect the response.
 *
 * @param {number} port
 * @param {string} method
 * @param {string} requestPath
 * @param {{body?: object, headers?: Record<string, string>}} [options]
 * @returns {Promise<{status: number, body: any, raw: string}>}
 */
function request(port, method, requestPath, options = {}) {
  const payload = options.body === undefined ? null : JSON.stringify(options.body);
  const headers = { ...(options.headers || {}) };
  if (payload !== null) {
    headers['Content-Type'] = 'application/json';
    headers['Content-Length'] = Buffer.byteLength(payload);
  }
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port, path: requestPath, method, headers },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let body = null;
          try {
            body = raw.length ? JSON.parse(raw) : null;
          } catch (error) {
            body = null;
          }
          resolve({ status: res.statusCode, body, raw });
        });
      },
    );
    req.on('error', reject);
    if (payload !== null) req.write(payload);
    req.end();
  });
}

/**
 * Start the server module on an OS-assigned port.
 *
 * @param {import('express').Express} app
 * @returns {Promise<import('http').Server>}
 */
function listen(app) {
  return new Promise((resolve, reject) => {
    const server = app.listen(PORT, '127.0.0.1', () => resolve(server));
    server.on('error', reject);
  });
}

/**
 * Stop a server and drop its keep-alive sockets.
 *
 * @param {import('http').Server} server
 * @returns {Promise<void>}
 */
function close(server) {
  return new Promise((resolve) => {
    server.close(() => resolve());
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
  });
}

/**
 * Close the pool the server module opened.
 *
 * @param {import('express').Express} app
 * @returns {Promise<void>}
 */
async function closeDb(app) {
  const pool = app && app.locals && app.locals.db && app.locals.db.pool;
  if (pool) await pool.end();
}

/**
 * Boot the server module against the fixture configuration.
 *
 * @param {{envFile: string, dbName: string, storagePath: string}} fixture
 * @returns {Promise<import('express').Express>}
 */
async function bootServer(fixture) {
  process.env.DB_NAME = fixture.dbName;
  process.env.STORAGE_DIR = fixture.storagePath;
  process.env.JWT_SECRET = JWT_SECRET;
  process.env.SEED_SAMPLE_ASSETS = '0';
  process.env.ENV_FILE = fixture.envFile;
  process.env.INIT_TOKEN = 'integration-init-token';
  delete require.cache[require.resolve('../../src/server/server')];
  const app = require('../../src/server/server');
  await app.locals.ready;
  return app;
}

/**
 * Query the fixture schema directly.
 *
 * @param {string} dbName
 * @param {string} sql
 * @param {unknown[]} [params]
 * @returns {Promise<object[]>}
 */
async function querySchema(dbName, sql, params = []) {
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST || '127.0.0.1',
    port: parseInt(process.env.DB_PORT || '3306', 10),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: dbName,
    dateStrings: true,
  });
  try {
    const [rows] = await connection.execute(sql, params);
    return rows;
  } finally {
    await connection.end();
  }
}

/**
 * Wait until the server reports the wizard is finished.
 *
 * @param {number} port
 * @param {string} token
 * @param {number} timeoutMs
 * @returns {Promise<void>}
 */
async function waitInitialized(port, token, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await request(port, 'GET', '/api/init/status', {
      headers: { 'X-Init-Token': token },
    });
    if (response.status === 200 && response.body && response.body.initialized === true) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('the wizard never reported the instance as initialized');
}

/**
 * @returns {Promise<void>}
 */
async function main() {
  const dbName = schemaName();
  const envFile = envFilePath();
  const storagePath = path.join(TESTS_DIR, 'test-storage-init');
  fs.rmSync(storagePath, { recursive: true, force: true });
  await dropSchema(dbName);

  const INIT_TOKEN = 'integration-init-token';
  const initHeaders = { 'X-Init-Token': INIT_TOKEN };

  let app = await bootServer({ envFile, dbName, storagePath });
  let server = await listen(app);
  let port = server.address().port;

  try {
    // --- 1) a fresh instance reports itself as uninitialized ---------------
    const status = await request(port, 'GET', '/api/init/status');
    assert.strictEqual(status.status, 200, `status expected 200, got ${status.status}`);
    assert.strictEqual(
      status.body.initialized,
      false,
      'a fresh installation must not report itself as initialized',
    );
    assert.ok(status.body.steps, 'the status must report the step state');

    // --- 2) the wizard endpoints refuse a request without the token -------
    const unauthenticated = await request(port, 'POST', '/api/init/database', {
      body: { host: '127.0.0.1', port: 3306, user: 'root', password: '', database: dbName },
    });
    assert.strictEqual(
      unauthenticated.status,
      403,
      `a wizard call without the token must be refused, got ${unauthenticated.status}`,
    );
    assert.ok(
      !fs.existsSync(envFile),
      'a refused wizard call must not write the environment file',
    );

    // --- 3) the database step writes the connection values ----------------
    const database = await request(port, 'POST', '/api/init/database', {
      headers: initHeaders,
      body: {
        host: process.env.DB_HOST || '127.0.0.1',
        port: parseInt(process.env.DB_PORT || '3306', 10),
        user: process.env.DB_USER || 'root',
        password: process.env.DB_PASSWORD || '',
        database: dbName,
      },
    });
    assert.strictEqual(
      database.status,
      200,
      `database step expected 200, got ${database.status}: ${database.raw}`,
    );
    assert.ok(fs.existsSync(envFile), 'the database step must create the environment file');
    const written = fs.readFileSync(envFile, 'utf8');
    assert.ok(written.includes(`DB_NAME=${dbName}`), 'the file must record the database name');
    assert.ok(/DB_USER=/.test(written), 'the file must record the database user');
    assert.ok(
      !/DB_PASSWORD=./.test(written),
      'the empty password must be written as an empty value, not as text',
    );
    assert.ok(
      fs.readFileSync(envFile, 'utf8').includes('# --- Database'),
      'the template comments must survive the write',
    );

    // The schema exists now.
    const tables = await querySchema(
      dbName,
      'SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?',
      [dbName],
    );
    assert.ok(
      tables.some((row) => row.name === 'tenants'),
      'the database step must create the schema',
    );

    // --- 4) a bad connection is refused and writes nothing ----------------
    const badEnv = path.join(path.dirname(envFile), '.env-bad');
    fs.rmSync(badEnv, { force: true });
    process.env.ENV_FILE = badEnv;
    delete require.cache[require.resolve('../../src/server/lib/init')];
    const badApp = await bootServer({ envFile: badEnv, dbName, storagePath });
    const badServer = await listen(badApp);
    const badPort = badServer.address().port;
    try {
      const rejected = await request(badPort, 'POST', '/api/init/database', {
        headers: initHeaders,
        body: {
          host: '127.0.0.1',
          port: 1,
          user: 'nobody',
          password: 'wrong',
          database: 'dam_never_created',
        },
      });
      assert.strictEqual(
        rejected.status,
        400,
        `an unreachable database must answer 400, got ${rejected.status}: ${rejected.raw}`,
      );
      assert.ok(
        !fs.existsSync(badEnv),
        'a failed connection attempt must not write the environment file',
      );
    } finally {
      await close(badServer);
      await closeDb(badApp);
      await closeWizardDb();
    }
    process.env.ENV_FILE = envFile;

    // --- 5) the administrator step creates the tenant and its owner -------
    const weak = await request(port, 'POST', '/api/init/admin', {
      headers: initHeaders,
      body: { username: 'owner', password: 'short1', tenantName: '第一租户' },
    });
    assert.strictEqual(weak.status, 400, `a weak password must answer 400, got ${weak.status}`);
    assert.strictEqual(
      (await querySchema(dbName, 'SELECT COUNT(*) AS c FROM users'))[0].c,
      0,
      'a rejected administrator step must not insert a user',
    );

    const admin = await request(port, 'POST', '/api/init/admin', {
      headers: initHeaders,
      body: {
        username: 'owner',
        password: 'Owner@123456',
        email: 'owner@example.com',
        tenantName: '第一租户',
      },
    });
    assert.strictEqual(admin.status, 200, `admin step expected 200, got ${admin.status}: ${admin.raw}`);

    const tenants = await querySchema(dbName, 'SELECT id, name, slug FROM tenants');
    assert.strictEqual(tenants.length, 1, 'the administrator step must create exactly one tenant');
    assert.strictEqual(tenants[0].name, '第一租户', 'the tenant must keep the name it was given');

    const users = await querySchema(
      dbName,
      'SELECT id, username, password_hash, role, tenant_id FROM users',
    );
    assert.strictEqual(users.length, 1, 'the administrator step must create exactly one user');
    assert.strictEqual(users[0].username, 'owner');
    assert.strictEqual(users[0].role, 'admin');
    assert.strictEqual(users[0].tenant_id, tenants[0].id, 'the owner must belong to the tenant');
    assert.ok(
      bcrypt.compareSync('Owner@123456', users[0].password_hash),
      'the password must be stored as a bcrypt hash',
    );

    // Calling it twice must not create a second tenant.
    const again = await request(port, 'POST', '/api/init/admin', {
      headers: initHeaders,
      body: { username: 'owner2', password: 'Owner@123456', tenantName: '第二租户' },
    });
    assert.strictEqual(again.status, 200, `a second admin must be accepted, got ${again.status}: ${again.raw}`);
    const tenantsAfter = await querySchema(dbName, 'SELECT id, name FROM tenants');
    assert.strictEqual(tenantsAfter.length, 1, 'a repeated admin step must not create a second tenant');
    assert.strictEqual(
      tenantsAfter[0].id,
      tenants[0].id,
      'the repeated admin step must reuse the tenant it created',
    );

    // --- 6) the seed step writes the secrets ------------------------------
    const seed = await request(port, 'POST', '/api/init/seed', { headers: initHeaders });
    assert.strictEqual(seed.status, 200, `seed step expected 200, got ${seed.status}: ${seed.raw}`);
    assert.ok(seed.body.api_key, 'the seed step must hand out the first API key');
    assert.ok(
      String(seed.body.api_key).startsWith('dam_'),
      'the API key must carry the project prefix',
    );

    const envAfterSeed = fs.readFileSync(envFile, 'utf8');
    const secretMatch = /^JWT_SECRET=(.*)$/m.exec(envAfterSeed);
    assert.ok(secretMatch, 'the seed step must write JWT_SECRET');
    assert.ok(
      secretMatch[1].trim().length >= 32,
      `JWT_SECRET must be at least 32 characters, got ${secretMatch[1].trim().length}`,
    );

    const keys = await querySchema(dbName, 'SELECT id, tenant_id, key_hash FROM api_keys');
    const seededKeys = keys.filter((row) => row.tenant_id === tenants[0].id);
    assert.strictEqual(seededKeys.length, 1, 'the seed step must create one key for the tenant');

    const delivery = await request(port, 'GET', '/api/public/v1/delivery/assets', {
      headers: { 'X-API-Key': seed.body.api_key },
    });
    assert.strictEqual(
      delivery.status,
      200,
      `the handed-out key must work, got ${delivery.status}: ${delivery.raw}`,
    );

    // --- 7) the instance is initialized now -------------------------------
    const finalStatus = await request(port, 'GET', '/api/init/status');
    assert.strictEqual(
      finalStatus.body.initialized,
      true,
      'once both conditions hold the instance must report itself as initialized',
    );
    assert.deepStrictEqual(
      finalStatus.body.steps,
      { database: true, admin: true, seed: true },
      'every step must report itself as done',
    );

    // --- 8) the wizard closes behind itself -------------------------------
    const closed = await request(port, 'POST', '/api/init/seed', { headers: initHeaders });
    assert.strictEqual(
      closed.status,
      404,
      `a finished instance must close the wizard, got ${closed.status}`,
    );
    const statusStillOpen = await request(port, 'GET', '/api/init/status');
    assert.strictEqual(
      statusStillOpen.status,
      200,
      'the status endpoint stays open so the frontend can decide where to go',
    );

    // --- 9) the restarted server reads the file it wrote ------------------
    await close(server);
    await closeDb(app);
    // Reset the process environment to what the file says, then boot again:
    // that is what a real restart does.
    process.env.DB_NAME = dbName;
    process.env.STORAGE_DIR = storagePath;
    process.env.SEED_SAMPLE_ASSETS = '0';
    delete process.env.JWT_SECRET;
    app = await bootServer({ envFile, dbName, storagePath });
    server = await listen(app);
    port = server.address().port;

    const afterRestart = await request(port, 'GET', '/api/init/status');
    assert.strictEqual(
      afterRestart.body.initialized,
      true,
      'a restart must find the instance initialized',
    );

    // The boot must not seed a second tenant behind the wizard's back: the
    // tenant the operator named is the installation's only tenant, and its
    // owner is the only administrator.
    const tenantsAfterRestart = await querySchema(dbName, 'SELECT id, name FROM tenants');
    assert.strictEqual(
      tenantsAfterRestart.length,
      1,
      `the boot must not add a tenant, found: ${tenantsAfterRestart.map((t) => t.name).join(', ')}`,
    );
    const usersAfterRestart = await querySchema(dbName, 'SELECT username FROM users ORDER BY username');
    assert.deepStrictEqual(
      usersAfterRestart.map((row) => row.username),
      ['owner', 'owner2'],
      'the boot must not seed an administrator into a configured instance',
    );

    console.log('init wizard OK');
  } finally {
    await close(server);
    await closeDb(app);
    // The wizard keeps a connection of its own while it configures the
    // instance; a live pool would keep the process alive after the last
    // assertion.
    await closeWizardDb();
    await dropSchema(dbName);
    fs.rmSync(path.join(TESTS_DIR, 'test-init-env'), { recursive: true, force: true });
    fs.rmSync(storagePath, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error('TEST FAILED:', error && error.stack ? error.stack : error);
  process.exit(1);
});
