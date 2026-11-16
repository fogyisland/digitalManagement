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
 *   /mcp                            — MCP (AI clients), per-account tokens
 *   /storage/*                      — the stored files (signed URLs)
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
const { reloadConfiguration } = require('./lib/reload');
const { createUploader, uploadErrorHandler, reapExpiredUploadSessions } = require('./lib/upload');
const { createRequestLogger, pruneRequestLogs } = require('./lib/request-log');
const { allowedOrigins, refreshSettings } = require('./lib/platform-settings');
const { mountDocs } = require('./lib/openapi');
const { asyncHandler } = require('./lib/http');
const { replayPendingManifestWrites, writeManifestIndex } = require('./lib/manifest');

const createAuthRouter = require('./routes/auth');
const createAuditRouter = require('./routes/audit');
const createSettingsRouter = require('./routes/settings');
const createUsersRouter = require('./routes/users');
const createTenantsRouter = require('./routes/tenants');
const createPlatformRouter = require('./routes/platform');
const createMcpTokensRouter = require('./routes/mcp-tokens');
const createMcpRouter = require('./routes/mcp');
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
const createStorageRouter = require('./routes/storage');
const createManifestRouter = require('./routes/manifest');

const config = getConfig();

/** How often the expired upload sessions are reclaimed. */
const UPLOAD_SESSION_SWEEP_MS = 10 * 60 * 1000;

/** How often the request log loses the rows that fell out of the retention window. */
const REQUEST_LOG_SWEEP_MS = 60 * 60 * 1000;

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

// Whether the request log may write. The table the log writes into is created
// with the rest of the schema, so before that — while the setup wizard is
// still open — there is nowhere to write to, and the logger stays out of the
// way instead of failing on every call.
let requestLogReady = false;

// What the seed did on this boot. The startup banner quotes it: only a seed
// that actually created the administrator knows its password.
let seededAdmin = null;

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
  seededAdmin = (await seedDatabase(db, config.storageDir)).admin;
  // The platform's own settings: the address this instance is reached at and
  // the origins allowed to call it. The CORS check reads them from memory, so
  // they have to be in memory before the first request arrives.
  await refreshSettings(db);
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

  // An upload session that is never completed keeps its chunks on disk. The
  // sessions that ran out of time are reclaimed at boot and then every few
  // minutes, so an abandoned upload does not fill the disk.
  const sweepUploads = async () => {
    try {
      await reapExpiredUploadSessions(db, config.storageDir);
    } catch (error) {
      console.warn('[upload] session sweep failed', error.message);
    }
  };
  await sweepUploads();
  const sweepTimer = setInterval(sweepUploads, UPLOAD_SESSION_SWEEP_MS);
  // The timer must not hold the process open on its own.
  if (typeof sweepTimer.unref === 'function') sweepTimer.unref();

  // The request log grows by one row per API call. The rows that fell out of
  // the retention window are dropped at boot and then every hour, so the log
  // cannot fill the disk on its own.
  const sweepRequestLog = async () => {
    try {
      const dropped = await pruneRequestLogs(db, config.requestLogRetentionDays);
      if (dropped > 0) {
        console.log(`[request-log] dropped ${dropped} row(s) past the retention window`);
      }
    } catch (error) {
      console.warn('[request-log] the sweep failed:', error.message);
    }
  };
  await sweepRequestLog();
  const requestLogTimer = setInterval(sweepRequestLog, REQUEST_LOG_SWEEP_MS);
  if (typeof requestLogTimer.unref === 'function') requestLogTimer.unref();

  // The schema exists now, so the request log has a table to write into.
  requestLogReady = true;
})();

// --- App --------------------------------------------------------------------
const app = express();
// The application serves its own frontend from its own port, so a browser
// never needs a cross-origin call to it. The allow-list is therefore empty
// by default: a deployment that *is* called from another origin has to say
// so, because an open policy hands every origin on the internet the same
// access to the API.
//
// The list is a platform setting rather than an environment variable, so it
// is read from the database and can change while the instance runs. The check
// runs on every request, so it reads the last known value from memory rather
// than asking the database each time.
app.use(
  cors({
    origin: (origin, callback) => {
      // A request without an Origin header is not a browser asking from
      // another site — a curl, a server-to-server call, the same origin.
      if (!origin) return callback(null, true);
      return callback(null, allowedOrigins().includes(origin));
    },
    credentials: false,
  }),
);
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

// Request log
app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

// The stored half of the request log: one row per API call, with the bytes
// that came in and went out. The console line above says what happened; this
// says it in a form the platform layer can count.
if (config.requestLogEnabled) {
  app.use(createRequestLogger({ db, isReady: () => requestLogReady }));
}

// --- Health probes ----------------------------------------------------------
app.get('/api/health', (_req, res) => res.json({ status: 'ok', service: 'dam' }));
// The readiness probe answers what it says: it touches the database. A probe
// that answers "ready" without asking anything is a probe that keeps a
// broken instance in the load balancer.
app.get('/api/health/ready', asyncHandler(async (_req, res) => {
  try {
    await db.prepare('SELECT 1 AS x').get();
    return res.json({ status: 'ready', db: 'ok' });
  } catch (error) {
    return res.status(503).json({ status: 'not-ready', db: 'error', detail: error.message });
  }
}));

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
    // The wizard finishes by moving the running application onto the
    // database it just wrote into the file — no restart, no operator.
    reload: async () => {
      const result = await reloadConfiguration({ db, envFile: ENV_FILE });
      app.locals.isConfigured = true;
      app.locals.ready = Promise.resolve();
      // The wizard brought the schema with it, so the request log has a table
      // to write into from here on.
      requestLogReady = true;
      // The wizard may have written the platform settings as well, so the
      // address and the cross-origin list are read again.
      await refreshSettings(db);
      // The wizard kept a connection of its own while it configured the
      // instance; the application now has its own pool on the same schema,
      // so the wizard's is one too many.
      await createInitRouter.closeWizardDb();
      return result;
    },
  }),
);

app.use(
  '/api/v1',
  createAuthRouter({ db }),
  // The audit trail of the tenant this request speaks for. It sits beside the
  // admin API because it is the tenant's own record of what its people
  // changed — the platform layer has its own, one layer up.
  createAuditRouter({ db }),
  // The address this instance is reached at. Everybody may read it — the
  // interface shows it — but only the platform administrator may change it.
  createSettingsRouter({ db }),
  createUsersRouter({ db }),
  // The tenant registry. Only a platform administrator may read it — it is
  // the list they pick from when they choose which tenant to act in, and
  // they are the ones who decide how many tenants there are.
  createTenantsRouter({ db }),
  // The platform layer: what the platform holds, who holds an account on it,
  // and what the platform layer did. One layer above the tenants.
  createPlatformRouter({ db }),
  // The MCP tokens: one per account per client.
  createMcpTokensRouter({ db }),
  createTagsRouter({ db }),
  createCategoriesRouter({ db }),
  createAssetsRouter({ db, uploader }),
  createUploadRouter({ db }),
  createApiKeysRouter({ db }),
  createWebhooksRouter({ db }),
  createStatsRouter({ db }),
  createJobsRouter({ db }),
  // The manifest index is the library's own listing. It used to be a static
  // file under the storage root, which enumerated every tenant's assets to
  // anybody; it is served here, to an authenticated caller, scoped to their
  // tenant.
  createManifestRouter({ db }),
);

// --- Public delivery API ----------------------------------------------------
app.use('/api/public/v1', createPublicRouter({ db, uploader }));

// --- Ingest API (external systems, API key) ---------------------------------
app.use('/api/ingest/v1', createIngestRouter({ db, uploader }));

// --- MCP (AI clients) -------------------------------------------------------
// The MCP endpoint lives outside `/api/v1`: it carries its own credential — a
// per-account MCP token — and speaks its own protocol, so it neither uses nor
// interferes with the admin API's session tokens. An MCP client is configured
// with a URL, and that URL is the one it expects to find.
app.use('/mcp', createMcpRouter({ db }));

// --- The documentation --------------------------------------------------------
// The instance documents itself: `/docs` (Swagger UI), `/redoc` (ReDoc) and
// `/openapi.json` (the specification itself). They are mounted before the
// frontend's catch-all, so the SPA never answers them.
mountDocs(app);

// --- 404 for unknown API ----------------------------------------------------
app.use('/api', (_req, res) => res.status(404).json({ detail: 'Not found' }));

// --- The stored files --------------------------------------------------------
// The files are served through a route that checks a signature or a token,
// not through a static mount: a static mount over the storage directory
// would publish every tenant's originals to anybody who could name the file.
// This is a file route, not an API route — the frontend puts the URL
// straight into an `<img src>`, which cannot carry an `Authorization`
// header, so the URL cannot live under `/api`.
app.use('/storage', createStorageRouter({ db }));

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
  const status = err.status || 500;
  // A 4xx is the client's mistake and is part of normal operation — a stack
  // trace for it is noise that hides the 5xx that matters.
  if (status >= 500) {
    console.error('[error]', err);
  } else {
    console.warn(`[error] ${status} ${err.code || ''} ${err.message || ''}`.trim());
  }
  // An error that names itself — `TENANT_REQUIRED`, `NO_SUCH_TENANT` — keeps
  // its name in the response. A caller that has to branch on the reason (the
  // platform administrator's write path does) cannot read it out of a
  // sentence.
  const body = { detail: err.message || 'Internal error' };
  if (err.code) body.code = err.code;
  res.status(status).json(body);
});

// --- Startup: the manifest index is written as part of `ready` --------------

// --- Start ------------------------------------------------------------------
// The server starts listening only once the database is reachable and the
// schema exists — a request that arrives earlier would hit a table that is
// not there yet.

/**
 * The accounts that can open a door on this instance.
 *
 * The banner used to advertise `admin / Admin@123456` on every boot. That
 * password only exists when the seed created the account itself: an instance
 * that came through the setup wizard, or one whose tenant already had users,
 * has a different administrator and a password nobody here knows. Printing
 * the default anyway sends the operator to a door that does not open.
 *
 * @param {object} db
 * @returns {Promise<Array<{tenant_id: string, username: string, role: string}>>}
 */
async function listLoginAccounts(db) {
  return db
    .prepare(
      `SELECT tenant_id, username, role FROM users
       WHERE is_active = 1
       ORDER BY tenant_id, username`,
    )
    .all();
}

/**
 * Print the accounts that exist, and the password only when it is known.
 *
 * @param {Array<{tenant_id: string, username: string, role: string}>} accounts
 * @param {{created: boolean, username: string, password: string|null}|null} seeded
 */
function printAccounts(accounts, seeded) {
  if (!accounts.length) {
    console.log('  Accounts: none yet — finish the setup wizard to create one');
    return;
  }
  console.log('  Accounts:');
  for (const account of accounts) {
    console.log(
      `    tenant=${account.tenant_id.padEnd(12)}${account.username.padEnd(16)}${account.role}`,
    );
  }
  if (seeded && seeded.created) {
    console.log(`  New administrator: ${seeded.username} / ${seeded.password}`);
  } else if (seeded) {
    console.log('  (this boot did not create an administrator — no default password to show)');
  }
}

if (require.main === module) {
  (async () => {
    try {
      await ready;
    } catch (error) {
      console.error('[startup] the database is not reachable:', error.message);
      process.exit(1);
    }

    const accounts = await listLoginAccounts(db);
    app.listen(config.port, config.host, () => {
      console.log(`\nDAM backend listening on http://localhost:${config.port}`);
      console.log(`  Database: ${config.dbUser}@${config.dbHost}:${config.dbPort}/${config.dbName}`);
      console.log('  API:    /api/v1/* (admin JWT)');
      console.log('  Public: /api/public/v1/* (API Key)');
      console.log('  Files:  /storage/*  (signed URLs)');
      printAccounts(accounts, seededAdmin);
      console.log('');
      if (config.usesDefaultSecret) {
        // The signing key the project ships with is public. An instance that
        // still uses it signs tokens anybody can forge, so it is worth a
        // line on the console that says so.
        console.warn('');
        console.warn('  [security] JWT_SECRET is still the placeholder the project ships with.');
        console.warn('  [security] Every token this instance signs can be forged. Set a');
        console.warn('  [security] real one in .env (or the environment) before exposing it.');
        console.warn('');
      }
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
