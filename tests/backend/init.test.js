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
const dotenv = require('dotenv');

const { closeWizardDb } = require('../../src/server/routes/init');

// The database the wizard is pointed at lives in the repository's `.env`;
// the configuration is read from the process environment, so the file has to
// be loaded here — the same the server itself does on boot. The suite
// deletes the signing key afterwards, because an unconfigured installation
// is exactly one without one.
dotenv.config({ path: path.resolve(__dirname, '..', '..', '.env') });

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
 * `JWT_SECRET` is deliberately **not** in the process environment: an
 * unconfigured installation is exactly one without a signing key, and the
 * boot has to recognise that and leave the wizard in charge. The seed step
 * sets the variable as a side effect, which is what the restart below relies
 * on.
 *
 * @param {{envFile: string, dbName: string, storagePath: string}} fixture
 * @returns {Promise<import('express').Express>}
 */
async function bootServer(fixture) {
  process.env.DB_NAME = fixture.dbName;
  process.env.STORAGE_DIR = fixture.storagePath;
  delete process.env.JWT_SECRET;
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
    const dbPassword = process.env.DB_PASSWORD || '';
    const database = await request(port, 'POST', '/api/init/database', {
      headers: initHeaders,
      body: {
        host: process.env.DB_HOST || '127.0.0.1',
        port: parseInt(process.env.DB_PORT || '3306', 10),
        user: process.env.DB_USER || 'root',
        password: dbPassword,
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
      written.includes(`DB_PASSWORD=${dbPassword}`),
      'the file must record the database password it was given',
    );
    if (dbPassword === '') {
      assert.ok(
        !/DB_PASSWORD=./.test(written),
        'the empty password must be written as an empty value, not as text',
      );
    }
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

    // --- 6) the seed step hot-reloads the instance ------------------------
    // The operator double-clicks. Both calls have to answer with the same
    // success, not one 200 and one 409 — the frontend button's spinner is a
    // courtesy, not concurrency control.
    const [seed, seedTwin] = await Promise.all([
      request(port, 'POST', '/api/init/seed', { headers: initHeaders }),
      request(port, 'POST', '/api/init/seed', { headers: initHeaders }),
    ]);
    for (const [label, response] of [['first', seed], ['concurrent', seedTwin]]) {
      assert.strictEqual(
        response.status,
        200,
        `the ${label} seed step expected 200, got ${response.status}: ${response.raw}`,
      );
      assert.strictEqual(response.body.ok, true, `the ${label} seed step must report success`);
      assert.strictEqual(
        response.body.api_key,
        undefined,
        'the seed step must not hand out an API key — keys come only from POST /api/v1/api-keys',
      );
      assert.strictEqual(
        response.body.jwt_secret_written,
        true,
        `the ${label} seed step must report that it wrote the secret`,
      );
    }

    const envAfterSeed = fs.readFileSync(envFile, 'utf8');
    const secretMatch = /^JWT_SECRET=(.*)$/m.exec(envAfterSeed);
    assert.ok(secretMatch, 'the seed step must write JWT_SECRET');
    assert.ok(
      secretMatch[1].trim().length >= 32,
      `JWT_SECRET must be at least 32 characters, got ${secretMatch[1].trim().length}`,
    );

    const keys = await querySchema(dbName, 'SELECT id, tenant_id FROM api_keys');
    assert.strictEqual(
      keys.filter((row) => row.tenant_id === tenants[0].id).length,
      0,
      'the seed step must not create a key for the tenant',
    );

    const categories = await querySchema(dbName, 'SELECT id FROM categories');
    assert.strictEqual(categories.length, 4, 'the seed step must create the four starter categories');
    const tags = await querySchema(dbName, 'SELECT id FROM tags');
    assert.strictEqual(tags.length, 8, 'the seed step must create the eight starter tags');

    // The reload happened without a restart: the administrator created on the
    // second page can log in, and the admin API answers them, right now.
    // `bootServer()` boots this module in the same process, and tokens are
    // signed with `getConfig().jwtSecret`, which re-reads `process.env` on
    // every call — so this passing proves the hot load, not a restart.
    const login = await request(port, 'POST', '/api/v1/auth/login', {
      body: { username: 'owner', password: 'Owner@123456' },
    });
    assert.strictEqual(
      login.status,
      200,
      `the administrator must be able to log in without a restart, got ${login.status}: ${login.raw}`,
    );
    const assets = await request(port, 'GET', '/api/v1/assets', {
      headers: { Authorization: `Bearer ${login.body.access_token}` },
    });
    assert.strictEqual(
      assets.status,
      200,
      `the admin API must answer without a restart, got ${assets.status}: ${assets.raw}`,
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

    // The signing key survives the wizard closing: the value the seed wrote
    // is still the value on disk. Rotating it would invalidate every token
    // already handed out.
    const envAfterClose = fs.readFileSync(envFile, 'utf8');
    assert.strictEqual(
      /^JWT_SECRET=(.*)$/m.exec(envAfterClose)[1].trim(),
      secretMatch[1].trim(),
      'a finished instance must not rotate its signing key',
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

    // --- 10) the handle can be pointed at another pool --------------------
    // The hot reload rebinds the running application to the database the
    // operator just typed in. In-flight statements keep the pool they
    // started on; the caller owns closing the old one.
    const { createDb, createPool } = require('../../src/server/lib/db');
    const originalPool = createPool({
      dbHost: process.env.DB_HOST || '127.0.0.1',
      dbPort: parseInt(process.env.DB_PORT || '3306', 10),
      dbUser: process.env.DB_USER || 'root',
      dbPassword: process.env.DB_PASSWORD || '',
      dbName,
    });
    const otherPool = createPool({
      dbHost: process.env.DB_HOST || '127.0.0.1',
      dbPort: parseInt(process.env.DB_PORT || '3306', 10),
      dbUser: process.env.DB_USER || 'root',
      dbPassword: process.env.DB_PASSWORD || '',
      dbName,
    });
    assert.notStrictEqual(otherPool, originalPool, 'the two pools must be distinct objects');
    const rebound = createDb(originalPool);
    assert.strictEqual(rebound.pool, originalPool, 'a fresh handle starts on the pool it was given');

    // A statement created before the rebind must still answer, through the
    // pool that is active at call time.
    const statement = rebound.prepare('SELECT 1 AS n');
    rebound.rebind(otherPool);
    assert.strictEqual(rebound.pool, otherPool, 'after the rebind the handle points at the new pool');
    const row = await statement.get();
    assert.strictEqual(row.n, 1, 'a statement after the rebind must still answer');
    const transactionRow = await rebound.transaction(async (tx) => tx.prepare('SELECT 2 AS n').get());
    assert.strictEqual(transactionRow.n, 2, 'a transaction after the rebind must run on the new pool');

    // The old pool is not swallowed by the handle: the caller can still end it.
    await originalPool.end();
    await otherPool.end();

    // --- 11) only the wizard-owned keys reach the process -----------------
    // The rendered .env carries every template default, so applying the
    // whole file would overwrite the storage directory the process was
    // started with. Only the six keys the wizard owns are applied.
    const { applyEnvToProcess } = require('../../src/server/lib/init');
    const applyEnvFile = path.join(TESTS_DIR, 'test-apply-env.env');
    const savedEnv = {
      DB_NAME: process.env.DB_NAME,
      JWT_SECRET: process.env.JWT_SECRET,
      STORAGE_DIR: process.env.STORAGE_DIR,
      PORT: process.env.PORT,
    };
    fs.writeFileSync(
      applyEnvFile,
      [
        'DB_NAME=dam_reload_test',
        'JWT_SECRET=abc',
        'STORAGE_DIR=./storage',
        'PORT=8000',
        '',
      ].join('\n'),
    );
    process.env.STORAGE_DIR = '/tmp/injected-storage';
    process.env.PORT = '9999';
    try {
      applyEnvToProcess(applyEnvFile);
      assert.strictEqual(
        process.env.DB_NAME,
        'dam_reload_test',
        'the wizard-owned database key must be applied from the file',
      );
      assert.strictEqual(
        process.env.JWT_SECRET,
        'abc',
        'the wizard-owned secret must be applied from the file',
      );
      assert.strictEqual(
        process.env.STORAGE_DIR,
        '/tmp/injected-storage',
        'a template default must not overwrite the storage directory the process was started with',
      );
      assert.strictEqual(
        process.env.PORT,
        '9999',
        'a template default must not overwrite the port the process was started with',
      );
    } finally {
      fs.rmSync(applyEnvFile, { force: true });
      for (const [key, value] of Object.entries(savedEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }

    // --- 12) the application picks up a new .env without restarting -------
    const { reloadConfiguration } = require('../../src/server/lib/reload');
    const reloadDir = path.join(TESTS_DIR, 'test-reload-storage');
    const reloadEnvFile = path.join(TESTS_DIR, 'test-reload.env');
    fs.rmSync(reloadDir, { recursive: true, force: true });
    const reloadEnv = {
      DB_HOST: process.env.DB_HOST || '127.0.0.1',
      DB_PORT: process.env.DB_PORT || '3307',
      DB_USER: process.env.DB_USER || 'dam',
      DB_PASSWORD: process.env.DB_PASSWORD || '',
      DB_NAME: dbName,
    };
    const writeReloadEnv = (overrides = {}) => {
      const values = { ...reloadEnv, JWT_SECRET: 'reload-secret', ...overrides };
      fs.writeFileSync(
        reloadEnvFile,
        Object.entries(values).map(([key, value]) => `${key}=${value}`).join('\n') + '\n',
      );
    };
    writeReloadEnv();
    const reloadEnvSnapshot = {};
    for (const key of ['DB_HOST', 'DB_PORT', 'DB_USER', 'DB_PASSWORD', 'DB_NAME', 'JWT_SECRET', 'STORAGE_DIR', 'SEED_SAMPLE_ASSETS']) {
      reloadEnvSnapshot[key] = process.env[key];
    }
    const poolConfig = {
      dbHost: reloadEnv.DB_HOST,
      dbPort: parseInt(reloadEnv.DB_PORT, 10),
      dbUser: reloadEnv.DB_USER,
      dbPassword: reloadEnv.DB_PASSWORD,
      dbName,
    };
    let reloadDb = null;
    let drainDb = null;
    try {
      process.env.STORAGE_DIR = reloadDir;
      process.env.SEED_SAMPLE_ASSETS = '0';

      reloadDb = createDb(createPool(poolConfig));
      const poolBeforeReload = reloadDb.pool;
      const reload = await reloadConfiguration({ db: reloadDb, envFile: reloadEnvFile });
      assert.deepStrictEqual(reload, { ok: true }, 'the reload must report itself as done');
      assert.notStrictEqual(
        reloadDb.pool,
        poolBeforeReload,
        'the reload must move the handle onto a fresh pool',
      );

      const reloadTenants = await reloadDb.prepare('SELECT id FROM tenants').all();
      assert.ok(reloadTenants.length >= 1, 'the reload must leave a tenant behind');
      const reloadCategories = await reloadDb.prepare('SELECT id FROM categories').all();
      assert.strictEqual(
        reloadCategories.length,
        4,
        'the reload must finish the boot by seeding the starter categories',
      );
      const reloadTags = await reloadDb.prepare('SELECT id FROM tags').all();
      assert.strictEqual(
        reloadTags.length,
        8,
        'the reload must finish the boot by seeding the starter tags',
      );

      // A failure has to reject, not report success: a silent success would
      // close the wizard on an instance that is not configured.
      writeReloadEnv({ DB_USER: 'dam_no_such_user_xyz' });
      await assert.rejects(
        reloadConfiguration({ db: reloadDb, envFile: reloadEnvFile }),
        'a reload against an unreachable database must reject',
      );
      writeReloadEnv();

      // The previous pool is drained, not abandoned: end() waits for the
      // statements already in flight on it (spec §4.6).
      drainDb = createDb(createPool(poolConfig));
      const slowQuery = drainDb.query('SELECT SLEEP(1) AS s');
      const startedAt = Date.now();
      await reloadConfiguration({ db: drainDb, envFile: reloadEnvFile });
      const elapsedMs = Date.now() - startedAt;
      const slow = await slowQuery;
      // SLEEP() answers 0 when it ran to completion and 1 when something
      // interrupted it — the statement must not have been cut short.
      assert.strictEqual(
        slow[0].s,
        0,
        'the statement in flight on the old pool must finish, not be interrupted',
      );
      assert.ok(
        elapsedMs >= 900,
        `the reload must wait for the previous pool to drain, it took ${elapsedMs}ms`,
      );
    } finally {
      if (reloadDb && reloadDb.pool) await reloadDb.pool.end();
      if (drainDb && drainDb.pool) await drainDb.pool.end();
      fs.rmSync(reloadEnvFile, { force: true });
      fs.rmSync(reloadDir, { recursive: true, force: true });
      for (const [key, value] of Object.entries(reloadEnvSnapshot)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }

    // --- 13) the seed creates no API key, and the catalogue seeds per table
    const { seedDatabase } = require('../../src/server/lib/seed');
    const seedDb = app.locals.db;
    const seedTenantId = 'seed-tenant-test';
    const seedStorage = path.join(TESTS_DIR, 'test-seed-storage');
    fs.rmSync(seedStorage, { recursive: true, force: true });
    const countFor = async (table) =>
      (
        await seedDb
          .prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE tenant_id = ?`)
          .get([seedTenantId])
      ).c;
    await seedDb
      .prepare('INSERT INTO tenants (id, name, slug, status) VALUES (?, ?, ?, ?)')
      .run([seedTenantId, '种子租户', seedTenantId, 'active']);

    await seedDatabase(seedDb, seedStorage, { tenantId: seedTenantId, skipSamples: true });
    assert.strictEqual(await countFor('categories'), 4, 'the seed must create the four starter categories');
    assert.strictEqual(await countFor('tags'), 8, 'the seed must create the eight starter tags');
    assert.strictEqual(
      await countFor('api_keys'),
      0,
      'the seed must not hand out an API key — keys come only from POST /api/v1/api-keys',
    );

    // A second seed must not duplicate anything.
    await seedDatabase(seedDb, seedStorage, { tenantId: seedTenantId, skipSamples: true });
    assert.strictEqual(await countFor('categories'), 4, 'a repeated seed must not duplicate the categories');
    assert.strictEqual(await countFor('tags'), 8, 'a repeated seed must not duplicate the tags');

    // The two tables are counted separately: a missing tag set is restored
    // even when the categories are still there.
    await seedDb.prepare('DELETE FROM tags WHERE tenant_id = ?').run([seedTenantId]);
    await seedDatabase(seedDb, seedStorage, { tenantId: seedTenantId, skipSamples: true });
    assert.strictEqual(
      await countFor('tags'),
      8,
      'a missing tag set must be seeded again even though the categories already exist',
    );
    assert.strictEqual(await countFor('categories'), 4, 'the restored tag seed must not touch the categories');
    fs.rmSync(seedStorage, { recursive: true, force: true });

    // --- 14) sample images are opt-in --------------------------------------
    // `getConfig()` re-reads the process environment on every call, so the
    // default is checked by calling it, not by inspecting a cached object.
    const { getConfig } = require('../../src/server/config');
    const sampleFlag = process.env.SEED_SAMPLE_ASSETS;
    try {
      delete process.env.SEED_SAMPLE_ASSETS;
      assert.strictEqual(
        getConfig().seedSampleAssets,
        false,
        'an unset SEED_SAMPLE_ASSETS must mean off — a new installation starts empty',
      );

      process.env.SEED_SAMPLE_ASSETS = '1';
      assert.strictEqual(getConfig().seedSampleAssets, true, 'SEED_SAMPLE_ASSETS=1 must mean on');

      process.env.SEED_SAMPLE_ASSETS = '0';
      assert.strictEqual(getConfig().seedSampleAssets, false, 'SEED_SAMPLE_ASSETS=0 must mean off');
    } finally {
      if (sampleFlag === undefined) delete process.env.SEED_SAMPLE_ASSETS;
      else process.env.SEED_SAMPLE_ASSETS = sampleFlag;
    }

    // --- 15) the template does not make an installation look configured ---
    // Copying `.env.example` to `.env` used to be enough to make the instance
    // skip the wizard — with a placeholder secret nobody had chosen.
    const { hasConfiguration, initStatus } = require('../../src/server/lib/init');
    const templateDir = path.join(TESTS_DIR, 'test-template-env');
    const templateCopy = path.join(templateDir, '.env');
    fs.mkdirSync(templateDir, { recursive: true });
    fs.copyFileSync(path.join(__dirname, '..', '..', '.env.example'), templateCopy);
    // `hasConfiguration` looks at the process environment first; the check
    // is about the file, so the environment must not answer for it.
    const templateSecret = process.env.JWT_SECRET;
    delete process.env.JWT_SECRET;
    try {
      assert.strictEqual(
        hasConfiguration(templateCopy),
        false,
        'a plain copy of .env.example must not count as a configuration',
      );
      const templateStatus = await initStatus({ envFile: templateCopy, db: app.locals.db });
      assert.strictEqual(
        templateStatus.initialized,
        false,
        'a plain copy of .env.example must leave the wizard open',
      );
    } finally {
      if (templateSecret !== undefined) process.env.JWT_SECRET = templateSecret;
      fs.rmSync(templateDir, { recursive: true, force: true });
    }

    // --- 16) a deployment that configures through the environment is set up ---
    // The container in `docker-compose.yml` passes `JWT_SECRET` through the
    // environment and has no `.env` file at all — `.dockerignore` keeps the
    // file out of the image. The boot recognised that (`hasConfiguration`
    // reads the environment), but the wizard did not: it only ever looked at
    // the file. So a running container reported itself as uninitialized — the
    // front end sent every user to the setup wizard, and the wizard's own
    // endpoints stayed open on a live instance, where the database step can
    // repoint the whole thing.
    const { initStatus: statusOf } = require('../../src/server/lib/init');
    const containerSecret = process.env.JWT_SECRET;
    process.env.JWT_SECRET = 'a-container-deployment-secret';
    try {
      const containerStatus = await statusOf({
        envFile: path.join(TESTS_DIR, 'no-such-env-file'),
        db: app.locals.db,
      });
      assert.strictEqual(
        containerStatus.initialized,
        true,
        'an instance whose signing key comes from the environment is configured, ' +
          'not a fresh installation the wizard should be offering to set up again',
      );
    } finally {
      if (containerSecret === undefined) delete process.env.JWT_SECRET;
      else process.env.JWT_SECRET = containerSecret;
    }

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
