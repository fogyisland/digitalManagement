'use strict';

/**
 * Authentication primitives: token issuing, verification, revocation and the
 * Express middlewares that guard the admin API and the public delivery API.
 *
 * Two token kinds exist and they are NOT interchangeable:
 *   - access  token  — short lived (default 1h), carries `typ: 'access'`
 *   - refresh token  — long lived (default 30d), carries `typ: 'refresh'`
 *
 * Both carry a `jti` so a single session can be revoked (logout) or rotated
 * (refresh) without a server-side session store.
 */

const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { nanoid } = require('nanoid');
const { getConfig } = require('../config');

/**
 * Issue a fresh access/refresh token pair for a user.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {{id: string, role: string}} user
 * @returns {{access_token: string, refresh_token: string, token_type: string, expires_in: number}}
 */
function issueTokenPair(db, user) {
  const { jwtSecret, accessTokenTtl, refreshTokenTtl, accessTokenTtlSeconds } = getConfig();
  const accessJti = nanoid();
  const refreshJti = nanoid();

  const accessToken = jwt.sign(
    // `sid` ties the access token to its refresh token so a logout can
    // revoke the whole session in one call.
    { sub: user.id, role: user.role, typ: 'access', jti: accessJti, sid: refreshJti },
    jwtSecret,
    { expiresIn: accessTokenTtl },
  );
  const refreshToken = jwt.sign(
    { sub: user.id, typ: 'refresh', jti: refreshJti },
    jwtSecret,
    { expiresIn: refreshTokenTtl },
  );

  // Best-effort bookkeeping of when each token dies so the revocation table
  // can be pruned later without unbounded growth.
  try {
    db.prepare(
      'INSERT OR REPLACE INTO token_registry (jti, user_id, kind, expires_at) VALUES (?, ?, ?, ?)',
    ).run(accessJti, user.id, 'access', expiresAtOf(accessTokenTtl));
    db.prepare(
      'INSERT OR REPLACE INTO token_registry (jti, user_id, kind, expires_at) VALUES (?, ?, ?, ?)',
    ).run(refreshJti, user.id, 'refresh', expiresAtOf(refreshTokenTtl));
  } catch (e) {
    console.warn('[auth] token registry write failed:', e.message);
  }

  return {
    access_token: accessToken,
    refresh_token: refreshToken,
    token_type: 'bearer',
    expires_in: accessTokenTtlSeconds,
  };
}

/**
 * Absolute expiry timestamp (SQLite datetime format) for a TTL string.
 *
 * @param {string} ttl e.g. "1h", "30d"
 * @returns {string} "YYYY-MM-DD HH:MM:SS" in UTC
 */
function expiresAtOf(ttl) {
  return new Date(Date.now() + ttlToMs(ttl)).toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * @param {string} ttl
 * @returns {number} milliseconds
 */
function ttlToMs(ttl) {
  const match = /^(\d+)\s*([smhd])$/.exec(String(ttl || '').trim());
  if (!match) return 0;
  const multipliers = { s: 1000, m: 60000, h: 3600000, d: 86400000 };
  return parseInt(match[1], 10) * multipliers[match[2]];
}

/**
 * Mark a token id as revoked until it would have expired anyway.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string|undefined|null} jti
 * @param {string} expiresAt
 */
function revokeToken(db, jti, expiresAt) {
  if (!jti) return;
  try {
    db.prepare(
      'INSERT OR REPLACE INTO revoked_tokens (jti, expires_at, created_at) VALUES (?, ?, datetime(\'now\'))',
    ).run(jti, expiresAt);
  } catch (e) {
    console.warn('[auth] revoke failed:', e.message);
  }
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string|undefined|null} jti
 * @returns {boolean}
 */
function isRevoked(db, jti) {
  if (!jti) return false;
  try {
    const row = db.prepare('SELECT 1 AS x FROM revoked_tokens WHERE jti = ?').get(jti);
    return !!row;
  } catch (e) {
    console.warn('[auth] revocation lookup failed:', e.message);
    return false;
  }
}

/**
 * Extract the bearer token from the Authorization header.
 *
 * @param {import('express').Request} req
 * @returns {string|null}
 */
function bearerToken(req) {
  const header = req.headers.authorization || '';
  return header.startsWith('Bearer ') ? header.slice(7) : null;
}

/**
 * Middleware: require a valid, non-revoked access token.
 *
 * @param {import('better-sqlite3').Database} db
 * @returns {import('express').RequestHandler}
 */
function authRequired(db) {
  return (req, res, next) => {
    const token = bearerToken(req);
    if (!token) return res.status(401).json({ detail: 'Missing token' });
    let payload;
    try {
      payload = jwt.verify(token, getConfig().jwtSecret);
    } catch (e) {
      return res.status(401).json({ detail: 'Invalid token' });
    }
    if (payload.typ === 'refresh') {
      return res.status(401).json({ detail: 'Refresh token cannot be used as an access token' });
    }
    const user = db
      .prepare('SELECT id, username, role, is_active FROM users WHERE id = ?')
      .get(payload.sub);
    if (!user) return res.status(401).json({ detail: 'User not found' });
    if (!user.is_active) return res.status(403).json({ detail: 'User is disabled' });
    if (isRevoked(db, payload.jti)) return res.status(401).json({ detail: 'Token revoked' });
    req.user = { id: user.id, username: user.username, role: user.role };
    req.token = payload;
    return next();
  };
}

/**
 * Middleware: require an admin-role access token.
 *
 * @param {import('better-sqlite3').Database} db
 * @returns {import('express').RequestHandler}
 */
function adminRequired(db) {
  const requireAuth = authRequired(db);
  return (req, res, next) => {
    requireAuth(req, res, () => {
      if (req.user.role !== 'admin') {
        return res.status(403).json({ detail: 'Admin role required' });
      }
      return next();
    });
  };
}

/**
 * Middleware: require a valid API key carrying the given scope.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} requiredScope
 * @returns {import('express').RequestHandler}
 */
function apiKeyRequired(db, requiredScope) {
  return (req, res, next) => {
    const provided = req.headers['x-api-key'] || req.query.api_key;
    if (!provided) return res.status(401).json({ detail: 'Missing API key' });
    const hash = crypto.createHash('sha256').update(provided).digest('hex');
    const key = db
      .prepare('SELECT * FROM api_keys WHERE key_hash = ? AND is_active = 1')
      .get(hash);
    if (!key) return res.status(401).json({ detail: 'Invalid API key' });
    if (key.expires_at && new Date(key.expires_at) < new Date()) {
      return res.status(401).json({ detail: 'API key expired' });
    }
    const scopes = String(key.scopes || '')
      .split(',')
      .map((scope) => scope.trim())
      .filter(Boolean);
    if (requiredScope && !scopes.includes(requiredScope) && !scopes.includes('*')) {
      return res.status(403).json({ detail: `Missing scope: ${requiredScope}` });
    }
    db.prepare("UPDATE api_keys SET last_used_at = datetime('now') WHERE id = ?").run(key.id);
    req.apiKey = key;
    return next();
  };
}

module.exports = {
  issueTokenPair,
  revokeToken,
  isRevoked,
  bearerToken,
  authRequired,
  adminRequired,
  apiKeyRequired,
  expiresAtOf,
};
