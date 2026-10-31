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
const Database = require('better-sqlite3');

const { getConfig } = require('./config');
const { initSchema, seedDatabase } = require('./lib/schema');
const { createUploader, uploadErrorHandler } = require('./lib/upload');

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
const createPublicRouter = require('./routes/public');

const config = getConfig();

// --- Storage layout ---------------------------------------------------------
fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
fs.mkdirSync(config.storageDir, { recursive: true });
fs.mkdirSync(path.join(config.storageDir, 'originals'), { recursive: true });
fs.mkdirSync(path.join(config.storageDir, 'thumbnails'), { recursive: true });
fs.mkdirSync(path.join(config.storageDir, 'placeholders'), { recursive: true });
fs.mkdirSync(path.join(config.storageDir, 'tmp'), { recursive: true });
fs.mkdirSync(path.join(config.storageDir, 'manifests'), { recursive: true });

// --- Database ---------------------------------------------------------------
const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

initSchema(db);
seedDatabase(db, config.storageDir);

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

// --- 404 for unknown API ----------------------------------------------------
app.use('/api', (_req, res) => res.status(404).json({ detail: 'Not found' }));

// --- Static: storage --------------------------------------------------------
app.use('/storage', express.static(config.storageDir, { maxAge: '7d', fallthrough: true }));

// --- Static: frontend build (if exists) -------------------------------------
const FRONTEND_DIST = path.join(config.rootDir, 'frontend', 'dist');
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
      <p>Run <code>cd frontend && npm install && npm run build</code>, then restart the backend.</p>`);
  });
}

// --- Error handling ---------------------------------------------------------
app.use(uploadErrorHandler);
app.use((err, _req, res, _next) => {
  console.error('[error]', err);
  res.status(err.status || 500).json({ detail: err.message || 'Internal error' });
});

// --- Startup: replay pending manifest writes + ensure index.json exists -----
const { replayPendingManifestWrites, writeManifestIndex } = require('./lib/manifest');
replayPendingManifestWrites(db, config.storageDir).catch((e) => {
  console.warn('[manifest] replay failed', e.message);
});
writeManifestIndex(db, config.storageDir).catch((e) => {
  console.warn('[manifest] initial write failed', e.message);
});

// --- Start ------------------------------------------------------------------
if (require.main === module) {
  app.listen(config.port, config.host, () => {
    console.log(`\nDAM backend listening on http://localhost:${config.port}`);
    console.log('  API:    /api/v1/* (admin JWT)');
    console.log('  Public: /api/public/v1/* (API Key)');
    console.log('  Static: /storage/*  (uploaded files)');
    console.log('  Admin:  admin / Admin@123456\n');
  });
}

module.exports = app;
