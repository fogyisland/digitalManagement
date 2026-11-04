'use strict';

/**
 * Digital Asset Management — Express composition root.
 *
 * The server is deliberately thin: it owns the lifecycle (config → database
 * → schema → seed → middleware → routes → static → error handling) and wires
 * together the routers that live in `src/routes/`. All business logic sits in
 * `src/lib/` and `src/routes/`.
 *
 * Namespaces:
 *   /api/health, /api/health/ready  — liveness / readiness probes
 *   /api/v1/*                       — admin API, JWT bearer tokens
 *   /api/public/v1/*                — delivery API, API keys
 *   /storage/*                      — uploaded files (static)
 *   /*                              — frontend build output (static)
 */

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

// Load `.env` before anything reads `process.env`. The file is optional: a
// missing one leaves the environment untouched, and every value in it still
// has a default in `config.js`.
//
// `ENV_FILE` redirects the whole environment file — both what is read here
// and what the setup wizard writes — so a test run never touches the
// developer's own configuration.
const ROOT_DIR = path.join(__dirname, '..', '..');
const ENV_FILE = process.env.ENV_FILE || path.join(ROOT_DIR, '.env');
require('dotenv').config({ path: ENV_FILE });

const { getConfig } = require('./config');
const { createDb, createPool, ensureDatabase } = require('./lib/db');
const { initSchema } = require('./lib/schema');
const { seedDatabase } = require('./lib/seed');
const { hasConfiguration, resolveInitToken } = require('./lib/init');
const { createUploader, uploadErrorHandler } = require('./lib/upload');
const { replayPendingManifestWrites, writeManifestIndex } = require('./lib/manifest');

const createAuthRouter = require('./routes/auth');
const createUsersRouter = require('./routes/users');
const createTagsRouter = require('./routes/tags');
const createCategoriesRouter = require('./routes/categories');
const createAssetsRouter = require('./routes/assets');
const createUploadRouter = require('./routes/upload');
const createApiKeysRouter = require('./routes/apikeys');
const createWebhooksRouter = require('./routes/webhooks');
const createStatsRouter = require('./routes/stats');
const createJobsRouter = require('./routes/jobs');
const createInitRouter = require('./routes/init');
const createIngestRouter = require('./routes/ingest');
const createPublicRouter = require('./routes/public');

const config = getConfig();

// --- Storage layout ---------------------------------------------------------
fs.mkdirSync(config.storageDir, { recursive: true });
fs.mkdirSync(path.join(config.storageDir, 'originals'), { recursive: true });
fs.mkdirSync(path.join(config.storageDir, 'thumbnails'), { recursive: true });
fs.mkdirSync(path.join(config.storageDir, 'placeholders'), { recursive: true });
fs.mkdirSync(path.join(config.storageDir, 'tmp'), { recursive: true });
fs.mkdirSync(path.join(config.storageDir, 'manifests'), { recursive: true });

// --- Database ---------------------------------------------------------------
// The pool is lazy: mysql2 connects on the first query, so the handle can
// be handed to the routers immediately. The schema and the seed data are
// created in the background — `app.locals.ready` resolves when the database
// is usable, and the server only starts listening after that.
const db = createDb(createPool(config));

// --- Init wizard ------------------------------------------------------------
// An installation that has never been configured has no database and no
// secrets, so there is nothing to migrate or seed: the wizard is what creates
// them. The marker is the environment file's `JWT_SECRET` — the same one the
// wizard's third step writes. Everything below reads `app.locals.pendingInit`
// to decide whether to skip the boot work.
const isConfigured = hasConfiguration(ENV_FILE);
const initToken = resolveInitToken();

const ready = (async () => {
  if (!isConfigured) {
    // Nothing to prepare: the schema does not exist yet, and creating one
    // against a database the operator has not chosen would be a guess.
    console.log('');
    console.log('[init] this installation has not been set up yet');
    console.log(`[init] open http://localhost:${config.port}/init and use this token:`);
    console.log(`[init]   ${initToken.token}`);
    console.log('');
    return;
  }
  await ensureDatabase(config);
  await initSchema(db);
  await seedDatabase(db, config.storageDir);
  // The manifest index is written on every boot, not only when the process
  // is started as the entry point: the backend is also embedded (the test
  // suite boots this module directly), and a missing index makes
  // `/storage/manifests/index.json` answer 404 for every consumer.
  // The manifest index covers every tenant, so every live tenant's pending
  // writes are replayed before the index is regenerated once.
  try {
    await replayPendingManifestWrites(db, config.storageDir);
    await writeManifestIndex(db, config.storageDir);
  } catch (error) {
    console.warn('[manifest] startup replay failed', error.message);
  }
})();

// --- App --------------------------------------------------------------------
const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

// Request log
app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

// --- Health probes ----------------------------------------------------------
app.get('/api/health', (_req, res) => res.json({ status: 'ok', service: 'dam' }));
app.get('/api/health/ready', (_req, res) => res.json({ status: 'ready', db: 'ok' }));

// --- Admin API --------------------------------------------------------------
const uploader = createUploader();
// --- Init wizard (always mounted; the router closes itself when done) -------
// `checkToken` is bound to the token this boot chose, so a wizard request
// cannot slip past with a token from another instance.
app.use(
  '/api/init',
  createInitRouter({
    db: isConfigured ? db : null,
    checkToken: createInitRouter.tokenChecker(initToken.token),
    onRestart: () => process.exit(0),
  }),
);

app.use(
  '/api/v1',
  createAuthRouter({ db }),
  createUsersRouter({ db }),
  createTagsRouter({ db }),
  createCategoriesRouter({ db }),
  createAssetsRouter({ db, uploader }),
  createUploadRouter({ db, uploader }),
  createApiKeysRouter({ db }),
  createWebhooksRouter({ db }),
  createStatsRouter({ db }),
  createJobsRouter({ db }),
);

// --- Public delivery API ----------------------------------------------------
app.use('/api/public/v1', createPublicRouter({ db, uploader }));

// --- Ingest API (external systems, API key) ---------------------------------
app.use('/api/ingest/v1', createIngestRouter({ db, uploader }));

// --- 404 for unknown API ----------------------------------------------------
app.use('/api', (_req, res) => res.status(404).json({ detail: 'Not found' }));

// --- Static: storage --------------------------------------------------------
app.use('/storage', express.static(config.storageDir, { maxAge: '7d', fallthrough: true }));

// --- Static: frontend build (if exists) -------------------------------------
const FRONTEND_DIST = path.join(config.rootDir, 'dist');
if (fs.existsSync(FRONTEND_DIST)) {
  app.use(express.static(FRONTEND_DIST, { maxAge: '1h' }));
  app.get(/^(?!\/api|\/storage).*/, (_req, res) => {
    res.sendFile(path.join(FRONTEND_DIST, 'index.html'));
  });
  console.log('[static] serving frontend from', FRONTEND_DIST);
} else {
  app.get('/', (_req, res) => {
    res.status(503).type('html').send(`<!doctype html><meta charset="utf-8"><title>DAM</title>
      <style>body{font:14px -apple-system,sans-serif;background:#0d1117;color:#f0f6fc;padding:48px;max-width:640px;margin:0 auto;}</style>
      <h1>DAM frontend is not built</h1>
      <p>Run <code>npm install && npm run build</code>, then restart the backend.</p>`);
  });
}

// --- Error handling ---------------------------------------------------------
app.use(uploadErrorHandler);
app.use((err, _req, res, _next) => {
  console.error('[error]', err);
  res.status(err.status || 500).json({ detail: err.message || 'Internal error' });
});

// --- Startup: the manifest index is written as part of `ready` --------------

// --- Start ------------------------------------------------------------------
// The server starts listening only once the database is reachable and the
// schema exists — a request that arrives earlier would hit a table that is
// not there yet.
if (require.main === module) {
  (async () => {
    try {
      await ready;
    } catch (error) {
      console.error('[startup] the database is not reachable:', error.message);
      process.exit(1);
    }

    app.listen(config.port, config.host, () => {
      console.log(`\nDAM backend listening on http://localhost:${config.port}`);
      console.log(`  Database: ${config.dbUser}@${config.dbHost}:${config.dbPort}/${config.dbName}`);
      console.log('  API:    /api/v1/* (admin JWT)');
      console.log('  Public: /api/public/v1/* (API Key)');
      console.log('  Static: /storage/*  (uploaded files)');
      console.log('  Admin:  admin / Admin@123456\n');
    });
  })();
}

// The database handle and the readiness promise are exposed for the test
// suite, which boots this module without starting a listener.
app.locals.db = db;
app.locals.ready = ready;
app.locals.isConfigured = isConfigured;
app.locals.initToken = initToken.token;

module.exports = app;
