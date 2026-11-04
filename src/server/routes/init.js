'use strict';

/**
 * Initialisation wizard routes.
 *
 * A fresh installation has no database, no administrator and no secrets, so
 * it cannot serve the admin API. These endpoints are how it becomes one. The
 * wizard is a one-shot: once the instance reports itself initialized, every
 * endpoint except `GET /api/init/status` answers 404.
 *
 * The router is mounted at `/api/init`, so the paths below are relative to
 * that prefix. Contract (mirrored by `frontend/src/api/init.ts`):
 *   GET  /status       -> { initialized, steps }
 *   POST /database     {host, port, user, password, database} -> { ok, database }
 *   POST /admin        {username, password, email?, tenantName} -> { ok, tenant_id, user_id }
 *   POST /seed         -> { ok, api_key, jwt_secret_written }
 *   GET  /env-preview  -> { content }   (secrets masked)
 *   POST /restart      -> 202
 *
 * Every endpoint but `status` requires `X-Init-Token`: the token comes from
 * `INIT_TOKEN` or is generated per boot and printed to the console. A wizard
 * that answers to anybody is a way to take an instance over before its owner
 * reaches it.
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { nanoid } = require('nanoid');
const mysql = require('mysql2/promise');
const { getConfig } = require('../config');
const { initSchema } = require('../lib/schema');
const { seedDatabase } = require('../lib/seed');
const { slugify } = require('../lib/util');
const { asyncHandler } = require('../lib/http');
const {
  readEnvFile,
  writeEnvFile,
  mergeEnv,
  initStatus,
  hasConfiguration,
  isStrongPassword,
} = require('../lib/init');

/** Where the environment file lives; `ENV_FILE` lets the tests redirect it. */
function envFileOf() {
  return process.env.ENV_FILE || path.join(getConfig().rootDir, '.env');
}

/** The `.env.example` template the wizard fills in. */
function templateFileOf() {
  return path.join(getConfig().rootDir, '.env.example');
}

/** The minimum length of a database password the wizard accepts as non-empty. */
const MIN_PASSWORD_LENGTH = 10;

/** The placeholder `.env.example` ships; it is never a real signing key. */
const DEV_PLACEHOLDER_SECRET = 'dam-dev-secret-change-me-in-production';

/**
 * The handle the wizard uses to reach the database it is configuring.
 *
 * The server's own handle points at whatever schema the *last* boot chose —
 * on a fresh installation that is nothing at all, because the boot skipped
 * the database work entirely. The wizard therefore walks its own connection,
 * built from the values it wrote into the environment file, and keeps it for
 * as long as the values stay the same.
 *
 * @param {object|null} serverDb the handle the server booted with, if any
 * @returns {Promise<object|null>} null when no database has been configured
 */
let cachedDb = { key: '', handle: null };

async function usableDb(serverDb) {
  if (serverDb) return serverDb;
  const env = readEnvFile(envFileOf());
  if (!env.DB_NAME) return null;
  const key = [env.DB_HOST, env.DB_PORT, env.DB_USER, env.DB_NAME].join('|');
  if (cachedDb.key === key && cachedDb.handle) return cachedDb.handle;
  if (cachedDb.handle) await cachedDb.handle.pool.end().catch(() => {});
  const { connect } = require('../lib/db');
  const handle = await connect({
    dbHost: env.DB_HOST || '127.0.0.1',
    dbPort: parseInt(env.DB_PORT || '3306', 10),
    dbUser: env.DB_USER || 'root',
    dbPassword: env.DB_PASSWORD || '',
    dbName: env.DB_NAME,
  });
  cachedDb = { key, handle };
  return handle;
}

/**
 * Drop the cached wizard connection.
 *
 * Called when the configuration changes underneath it (the database step
 * repoints the file) and at the end of a test run.
 *
 * @returns {Promise<void>}
 */
async function closeWizardDb() {
  const handle = cachedDb.handle;
  cachedDb = { key: '', handle: null };
  if (handle) await handle.pool.end().catch(() => {});
}

/**
 * @param {{db: object|null, checkToken: (req: import('express').Request) => boolean, onRestart?: () => void}} deps
 * @returns {import('express').Router}
 */
function createInitRouter({ db, checkToken, onRestart }) {
  const router = express.Router();

  // --- the gate -------------------------------------------------------------
  // `status` stays open: the frontend needs it to decide whether to show the
  // wizard at all. Everything else is 404 once the instance is initialized,
  // and 403 without the token.
  router.use(asyncHandler(async (req, res, next) => {
    if (req.path === '/status' && req.method === 'GET') return next();
    const status = await initStatus({ envFile: envFileOf(), db: await usableDb(db) });
    if (status.initialized) {
      return res.status(404).json({ detail: 'Not found' });
    }
    if (!checkToken(req)) {
      return res.status(403).json({ detail: 'Invalid init token' });
    }
    return next();
  }));

  router.get('/status', asyncHandler(async (_req, res) => {
    return res.json(await initStatus({ envFile: envFileOf(), db: await usableDb(db) }));
  }));

  // --- step 1: the database -------------------------------------------------
  router.post('/database', asyncHandler(async (req, res) => {
    const body = req.body || {};
    const host = String(body.host || '127.0.0.1').trim();
    const port = parseInt(body.port, 10) || 3306;
    const user = String(body.user || '').trim();
    const password = body.password === undefined ? '' : String(body.password);
    const database = String(body.database || '').trim();
    if (!user) return res.status(400).json({ detail: 'user required' });
    if (!database) return res.status(400).json({ detail: 'database required' });
    if (!/^[A-Za-z0-9_$-]+$/.test(database)) {
      return res.status(400).json({ detail: 'database name may only contain letters, digits, _ - $' });
    }

    // 1) does the connection work at all?
    let connection;
    try {
      connection = await mysql.createConnection({
        host,
        port,
        user,
        password,
        charset: 'utf8mb4_unicode_ci',
        connectTimeout: 5000,
      });
    } catch (error) {
      return res.status(400).json({ detail: 'Cannot connect to the database' });
    }

    // 2) create the schema and its tables.
    const pool = mysql.createPool({
      host,
      port,
      user,
      password,
      database,
      charset: 'utf8mb4_unicode_ci',
      dateStrings: true,
      waitForConnections: true,
      connectionLimit: 2,
    });
    try {
      const quoted = database.replace(/`/g, '``');
      await connection.query(
        `CREATE DATABASE IF NOT EXISTS \`${quoted}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
      );
      // `initSchema` speaks the app's own handle shape, not a raw pool.
      const { createDb } = require('../lib/db');
      const wizardDb = createDb(pool);
      await initSchema(wizardDb);
      await pool.end();
      pool.end = () => Promise.resolve();
    } catch (error) {
      await pool.end().catch(() => {});
      return res.status(400).json({ detail: `Cannot create the schema: ${error.message}` });
    } finally {
      await connection.end().catch(() => {});
    }

    // 3) record the connection in the environment file. The wizard's cached
    // connection pointed at the previous values and has to be rebuilt.
    await closeWizardDb();
    const envFile = envFileOf();
    // `.env.example` carries a development placeholder for `JWT_SECRET`.
    // Writing it here would make the instance *look* configured before the
    // seed step has generated the real key — and the wizard would close
    // itself. A real secret that is already present is left alone.
    const existingSecret = readEnvFile(envFile).JWT_SECRET || '';
    const keepsSecret =
      existingSecret.trim().length > 0 && existingSecret !== DEV_PLACEHOLDER_SECRET;
    writeEnvFile(
      envFile,
      mergeEnv(envFile, {
        DB_HOST: host,
        DB_PORT: String(port),
        DB_USER: user,
        DB_PASSWORD: password,
        DB_NAME: database,
        ...(keepsSecret ? {} : { JWT_SECRET: '' }),
      }),
      templateFileOf(),
    );

    return res.json({ ok: true, database });
  }));

  // --- step 2: the administrator and the first tenant ------------------------
  router.post('/admin', asyncHandler(async (req, res) => {
    const body = req.body || {};
    const username = String(body.username || '').trim();
    const password = String(body.password || '');
    const email = body.email ? String(body.email).trim() : null;
    const tenantName = String(body.tenantName || '').trim();
    if (!username) return res.status(400).json({ detail: 'username required' });
    if (!tenantName) return res.status(400).json({ detail: 'tenantName required' });
    if (!isStrongPassword(password)) {
      return res.status(400).json({
        detail: `password must be at least ${MIN_PASSWORD_LENGTH} characters and contain letters and digits`,
      });
    }

    // Connect with the values the wizard just wrote. The server's own handle
    // still points at the old schema until the restart.
    const env = readEnvFile(envFileOf());
    if (!env.DB_NAME) {
      return res.status(400).json({ detail: 'The database step has not run yet' });
    }
    const { connect } = require('../lib/db');
    const wizardDb = await connect({
      dbHost: env.DB_HOST || '127.0.0.1',
      dbPort: parseInt(env.DB_PORT || '3306', 10),
      dbUser: env.DB_USER || 'root',
      dbPassword: env.DB_PASSWORD || '',
      dbName: env.DB_NAME,
    });

    try {
      // The tenant: reuse the one an upgraded installation already has, or
      // create the first one.
      const existing = await wizardDb.prepare('SELECT id FROM tenants ORDER BY created_at ASC LIMIT 1').get();
      let tenantId;
      if (existing) {
        tenantId = existing.id;
        await wizardDb
          .prepare('UPDATE tenants SET name = ?, slug = ? WHERE id = ?')
          .run(tenantName, slugify(tenantName), tenantId);
      } else {
        tenantId = nanoid();
        await wizardDb
          .prepare('INSERT INTO tenants (id, name, slug, status) VALUES (?, ?, ?, ?)')
          .run(tenantId, tenantName, slugify(tenantName), 'active');
      }

      const taken = await wizardDb
        .prepare('SELECT id FROM users WHERE tenant_id = ? AND username = ?')
        .get(tenantId, username);
      if (taken) {
        return res.status(409).json({ detail: 'That username is taken in this tenant' });
      }

      const userId = nanoid();
      await wizardDb
        .prepare(
          'INSERT INTO users (id, tenant_id, username, email, password_hash, role, is_active) VALUES (?, ?, ?, ?, ?, ?, 1)',
        )
        .run(userId, tenantId, username, email, bcrypt.hashSync(password, 10), 'admin');

      return res.json({ ok: true, tenant_id: tenantId, user_id: userId });
    } finally {
      await wizardDb.pool.end().catch(() => {});
    }
  }));

  // --- step 3: the secrets and the seed data --------------------------------
  router.post('/seed', asyncHandler(async (_req, res) => {
    const envFile = envFileOf();
    const existing = readEnvFile(envFile);
    // An existing secret is never rotated: doing so would invalidate every
    // token already handed out.
    const jwtSecret =
      existing.JWT_SECRET && existing.JWT_SECRET.trim().length > 0
        ? existing.JWT_SECRET
        : crypto.randomBytes(32).toString('hex');

    writeEnvFile(envFile, mergeEnv(envFile, { JWT_SECRET: jwtSecret }), templateFileOf());
    // The seed runs through this module's own process environment, so the
    // values the wizard wrote have to be visible here too.
    process.env.JWT_SECRET = jwtSecret;

    const env = readEnvFile(envFile);
    const { connect } = require('../lib/db');
    const wizardDb = await connect({
      dbHost: env.DB_HOST || '127.0.0.1',
      dbPort: parseInt(env.DB_PORT || '3306', 10),
      dbUser: env.DB_USER || 'root',
      dbPassword: env.DB_PASSWORD || '',
      dbName: env.DB_NAME,
    });

    try {
      await initSchema(wizardDb);
      const firstTenant = await wizardDb
        .prepare('SELECT id FROM tenants ORDER BY created_at ASC LIMIT 1')
        .get();
      if (!firstTenant) {
        return res.status(400).json({ detail: 'The administrator step has not run yet' });
      }
      // The key is minted *before* the seed runs, so the seed's own
      // placeholder key is skipped and the plaintext the operator is shown
      // here is the one that ends up in the database.
      const existingKey = await wizardDb
        .prepare('SELECT COUNT(*) AS c FROM api_keys WHERE tenant_id = ?')
        .get(firstTenant.id);
      let apiKey = null;
      if (Number(existingKey.c) === 0) {
        apiKey = `dam_${crypto.randomBytes(24).toString('hex')}`;
        await wizardDb
          .prepare(
            'INSERT INTO api_keys (id, tenant_id, name, key_prefix, key_hash, scopes) VALUES (?, ?, ?, ?, ?, ?)',
          )
          .run(
            nanoid(),
            firstTenant.id,
            'Setup Key',
            apiKey.slice(0, 12),
            crypto.createHash('sha256').update(apiKey).digest('hex'),
            'read,upload,delete',
          );
      }

      await seedDatabase(wizardDb, env.STORAGE_DIR || getConfig().storageDir, {
        tenantId: firstTenant.id,
      });

      return res.json({ ok: true, api_key: apiKey, jwt_secret_written: true });
    } finally {
      await wizardDb.pool.end().catch(() => {});
    }
  }));

  // --- the preview ----------------------------------------------------------
  router.get('/env-preview', asyncHandler(async (_req, res) => {
    const env = readEnvFile(envFileOf());
    const masked = { ...env };
    for (const key of Object.keys(masked)) {
      if (/SECRET|PASSWORD|TOKEN/i.test(key) && masked[key]) {
        masked[key] = `${masked[key].slice(0, 4)}${'*'.repeat(8)}`;
      }
    }
    const content = Object.entries(masked)
      .map(([key, value]) => `${key}=${value}`)
      .join('\n');
    return res.json({ content: `${content}\n` });
  }));

  // --- restart --------------------------------------------------------------
  router.post('/restart', asyncHandler(async (_req, res) => {
    if (!hasConfiguration(envFileOf())) {
      return res.status(400).json({ detail: 'The wizard has not written the configuration yet' });
    }
    res.status(202).json({ ok: true, message: 'Restarting — the process manager brings it back' });
    // The response must reach the client before the process goes away.
    if (typeof onRestart === 'function') {
      setTimeout(onRestart, 100);
    } else {
      setTimeout(() => process.exit(0), 100);
    }
  }));

  return router;
}

/**
 * The `X-Init-Token` guard.
 *
 * @param {string} expected
 * @returns {(req: import('express').Request) => boolean}
 */
function tokenChecker(expected) {
  return (req) => {
    const provided = String(req.headers['x-init-token'] || '');
    if (!provided || provided.length !== expected.length) return false;
    // Constant-time: a wizard token is a credential like any other.
    return crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
  };
}

module.exports = createInitRouter;
module.exports.tokenChecker = tokenChecker;
module.exports.envFileOf = envFileOf;
module.exports.closeWizardDb = closeWizardDb;
