'use strict';

/**
 * Runtime configuration.
 *
 * IMPORTANT: every value is read from `process.env` *inside* the function,
 * never at module load time. The backend test suite re-requires
 * `src/server.js` with a fresh `delete require.cache[...]` between phases and
 * points `DB_PATH` / `STORAGE_DIR` / `PORT` at a different fixture each time.
 * If this module cached the values at require time, every phase would share
 * the first fixture's database and the suite would silently test the wrong
 * thing.
 */

const path = require('path');

// `__dirname` is `<repo>/src/server`.
const SRC_DIR = __dirname;

/**
 * The repository root — the anchor for every relative path.
 *
 * The server, the frontend source and the tests all live under one tree, and
 * the configuration file sits at the root, so a relative path in `.env` is
 * resolved from here rather than from the working directory.
 */
const ROOT_DIR = path.join(SRC_DIR, '..', '..');

const DEFAULT_ACCESS_TOKEN_TTL = '1h';
const DEFAULT_REFRESH_TOKEN_TTL = '30d';

/**
 * The signing key the project ships with.
 *
 * It is public — it is in the repository — so an instance that still uses it
 * signs tokens anybody can forge. The boot says so loudly.
 */
const DEV_PLACEHOLDER_SECRET = 'dam-dev-secret-change-me-in-production';

/**
 * Resolve a configured path against the repository root.
 *
 * A relative path in `.env` must not depend on the working directory: the
 * server is started from the repository root by the launch scripts and by
 * `npm start`, and from `/app` inside a container. Anchoring to the root
 * makes all of them behave the same.
 *
 * @param {string | undefined} value the configured value, if any
 * @param {string} fallback the absolute default
 * @returns {string} an absolute path
 */
function resolveFromRoot(value, fallback) {
  const raw = String(value || '').trim();
  if (raw.length === 0) return fallback;
  return path.isAbsolute(raw) ? raw : path.join(ROOT_DIR, raw);
}

/**
 * Convert a JWT-style duration ("30d", "1h", "15m", "45s") to seconds.
 *
 * @param {string} ttl
 * @returns {number} duration in seconds
 */
function ttlToSeconds(ttl) {
  const match = /^(\d+)\s*([smhd])$/.exec(String(ttl || '').trim());
  if (!match) return 0;
  const amount = parseInt(match[1], 10);
  const unit = match[2];
  const multipliers = { s: 1, m: 60, h: 3600, d: 86400 };
  return amount * multipliers[unit];
}

/**
 * Build the effective configuration from the current environment.
 *
 * @returns {{
 *   port: number,
 *   host: string,
 *   jwtSecret: string,
 *   dbHost: string,
 *   dbPort: number,
 *   dbUser: string,
 *   dbPassword: string,
 *   dbName: string,
 *   dbPoolSize: number,
 *   storageDir: string,
 *   rootDir: string,
 *   maxFileSize: number,
 *   accessTokenTtl: string,
 *   refreshTokenTtl: string,
 *   accessTokenTtlSeconds: number,
 *   refreshTokenTtlSeconds: number,
 *   seedSampleAssets: boolean,
 *   usesDefaultSecret: boolean,
 *   requestLogEnabled: boolean,
 *   requestLogRetentionDays: number
 * }}
 */
function getConfig() {
  const accessTokenTtl = process.env.ACCESS_TOKEN_TTL || DEFAULT_ACCESS_TOKEN_TTL;
  const refreshTokenTtl = process.env.REFRESH_TOKEN_TTL || DEFAULT_REFRESH_TOKEN_TTL;
  const jwtSecret = process.env.JWT_SECRET || DEV_PLACEHOLDER_SECRET;
  return {
    port: parseInt(process.env.PORT || '8000', 10),
    host: process.env.HOST || '0.0.0.0',
    jwtSecret,
    usesDefaultSecret: jwtSecret === DEV_PLACEHOLDER_SECRET,
    dbHost: process.env.DB_HOST || '127.0.0.1',
    dbPort: parseInt(process.env.DB_PORT || '3306', 10),
    dbUser: process.env.DB_USER || 'root',
    dbPassword: process.env.DB_PASSWORD || '',
    dbName: process.env.DB_NAME || 'digital_management',
    dbPoolSize: parseInt(process.env.DB_POOL_SIZE || '10', 10),
    storageDir: resolveFromRoot(process.env.STORAGE_DIR, path.join(ROOT_DIR, 'storage')),
    rootDir: ROOT_DIR,
    maxFileSize:
      parseInt(process.env.UPLOAD_MAX_FILE_SIZE_MB || '2048', 10) * 1024 * 1024,
    // The budget for one request. The files are buffered in memory, so this
    // is what keeps a single request from taking the process down: the
    // per-file limit alone would allow twenty times that in one call.
    // It defaults to the per-file limit — one file's worth per request —
    // and an operator who has the memory can raise it.
    maxRequestSize:
      parseInt(process.env.UPLOAD_MAX_REQUEST_SIZE_MB || '0', 10) * 1024 * 1024 ||
      parseInt(process.env.UPLOAD_MAX_FILE_SIZE_MB || '2048', 10) * 1024 * 1024,
    // The sample library is a first-boot convenience, not part of the
    // product data: a new installation starts with an empty library and the
    // twelve sample images are opt-in.
    seedSampleAssets: process.env.SEED_SAMPLE_ASSETS === '1',
    // The request log is one row per API call. It is worth having — it is the
    // only way to see what the instance was actually asked to do — but it is
    // also the one table that grows on its own, so it is kept for a window
    // rather than forever. An operator who does not want the write at all can
    // turn it off.
    requestLogEnabled: process.env.REQUEST_LOG_ENABLED !== '0',
    requestLogRetentionDays: parseInt(process.env.REQUEST_LOG_RETENTION_DAYS || '30', 10),
    accessTokenTtl,
    refreshTokenTtl,
    accessTokenTtlSeconds: ttlToSeconds(accessTokenTtl),
    refreshTokenTtlSeconds: ttlToSeconds(refreshTokenTtl),
  };
}

module.exports = { getConfig, ttlToSeconds, DEV_PLACEHOLDER_SECRET };
