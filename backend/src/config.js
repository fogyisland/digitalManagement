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

// `__dirname` is `<repo>/backend/src` — the same depth the values below were
// originally computed at in `server.js`, so the default paths are unchanged.
const SRC_DIR = __dirname;

/** The backend's own directory — the anchor for every relative path. */
const BACKEND_DIR = path.join(SRC_DIR, '..');

const DEFAULT_ACCESS_TOKEN_TTL = '1h';
const DEFAULT_REFRESH_TOKEN_TTL = '30d';

/**
 * Resolve a configured path against the backend directory.
 *
 * A relative path in `.env` must not depend on the working directory: the
 * server is started from `backend/` by the launch scripts, from the repo
 * root by `npm --prefix backend start`, and from `/app` inside a container.
 * Anchoring to the backend directory makes all three behave the same.
 *
 * @param {string | undefined} value the configured value, if any
 * @param {string} fallback the absolute default
 * @returns {string} an absolute path
 */
function resolveFromBackendDir(value, fallback) {
  const raw = String(value || '').trim();
  if (raw.length === 0) return fallback;
  return path.isAbsolute(raw) ? raw : path.join(BACKEND_DIR, raw);
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
 *   dbPath: string,
 *   storageDir: string,
 *   rootDir: string,
 *   maxFileSize: number,
 *   accessTokenTtl: string,
 *   refreshTokenTtl: string,
 *   accessTokenTtlSeconds: number,
 *   refreshTokenTtlSeconds: number,
 *   appBaseUrl: string,
 *   seedSampleAssets: boolean
 * }}
 */
function getConfig() {
  const accessTokenTtl = process.env.ACCESS_TOKEN_TTL || DEFAULT_ACCESS_TOKEN_TTL;
  const refreshTokenTtl = process.env.REFRESH_TOKEN_TTL || DEFAULT_REFRESH_TOKEN_TTL;
  return {
    port: parseInt(process.env.PORT || '8000', 10),
    host: process.env.HOST || '0.0.0.0',
    jwtSecret: process.env.JWT_SECRET || 'dam-dev-secret-change-me-in-production',
    dbPath: resolveFromBackendDir(process.env.DB_PATH, path.join(BACKEND_DIR, 'data', 'dam.db')),
    storageDir: resolveFromBackendDir(process.env.STORAGE_DIR, path.join(BACKEND_DIR, 'storage')),
    rootDir: path.join(BACKEND_DIR, '..'),
    maxFileSize:
      parseInt(process.env.UPLOAD_MAX_FILE_SIZE_MB || '2048', 10) * 1024 * 1024,
    // The sample library is a first-boot convenience, not part of the
    // product data. Tests and production installs turn it off.
    seedSampleAssets: process.env.SEED_SAMPLE_ASSETS !== '0',
    accessTokenTtl,
    refreshTokenTtl,
    accessTokenTtlSeconds: ttlToSeconds(accessTokenTtl),
    refreshTokenTtlSeconds: ttlToSeconds(refreshTokenTtl),
    appBaseUrl: process.env.APP_BASE_URL || '',
  };
}

module.exports = { getConfig, ttlToSeconds };
