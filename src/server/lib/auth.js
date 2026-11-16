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
const {
  resolveTenantFromUser,
  resolveScope,
  tenantScope,
  loadTenant,
  SUPERADMIN_ROLE,
} = require('./tenant');
const { DEFAULT_TENANT_ID } = require('./tenant-schema');

/**
 * Issue a fresh access/refresh token pair for a user.
 *
 * Both tokens carry `tid` — the tenant the credential speaks for. The
 * tenant is written into the token at signing time and never travels with
 * the request, so a token cannot be pointed at another tenant later.
 *
 * @param {object} db
 * @param {{id: string, role: string, tenant_id: string}} user
 * @returns {Promise<{access_token: string, refresh_token: string, token_type: string, expires_in: number}>}
 */
async function issueTokenPair(db, user) {
  const { jwtSecret, accessTokenTtl, refreshTokenTtl, accessTokenTtlSeconds } = getConfig();
  const accessJti = nanoid();
  const refreshJti = nanoid();
  const tenantId = user.tenant_id ?? null;

  const accessToken = jwt.sign(
    // `sid` ties the access token to its refresh token so a logout can
    // revoke the whole session in one call.
    { sub: user.id, role: user.role, typ: 'access', jti: accessJti, sid: refreshJti, tid: tenantId },
    jwtSecret,
    { expiresIn: accessTokenTtl },
  );
  const refreshToken = jwt.sign(
    { sub: user.id, typ: 'refresh', jti: refreshJti, tid: tenantId },
    jwtSecret,
    { expiresIn: refreshTokenTtl },
  );

  // Best-effort bookkeeping of when each token dies so the revocation table
  // can be pruned later without unbounded growth.
  try {
    await db
      .prepare(
        'REPLACE INTO token_registry (jti, user_id, kind, expires_at) VALUES (?, ?, ?, ?)',
      )
      .run(accessJti, user.id, 'access', expiresAtOf(accessTokenTtl));
    await db
      .prepare(
        'REPLACE INTO token_registry (jti, user_id, kind, expires_at) VALUES (?, ?, ?, ?)',
      )
      .run(refreshJti, user.id, 'refresh', expiresAtOf(refreshTokenTtl));
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
 * Absolute expiry timestamp (SQL DATETIME format) for a TTL string.
 *
 * @param {string} ttl e.g. "1h", "30d"
 * @returns {string} "YYYY-MM-DD HH:MM:SS" in UTC
 */
function expiresAtOf(ttl) {
  return new Date(Date.now() + ttlToMs(ttl)).toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * Read a DATETIME column value back as an instant.
 *
 * The pool runs with `dateStrings`, so a DATETIME comes back as the naive
 * string `YYYY-MM-DD HH:MM:SS`. V8 parses that non-ISO form as LOCAL time,
 * which would shift every comparison by the server's UTC offset. The server
 * writes UTC (`SET time_zone = '+00:00'`), so the value is re-read as UTC.
 *
 * The naive form is the same one the interface reads, and the two must not
 * drift apart: the server compares a stored expiry against the clock, and the
 * interface renders a stored heartbeat against the clock, and both have to
 * be talking about the same instant.
 *
 * @param {string|Date|null|undefined} value
 * @returns {Date|null}
 */
function parseDateTime(value) {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) return value;
  const text = String(value);
  const naive = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(\.\d+)?$/.exec(text);
  if (naive) return new Date(`${naive[1]}T${naive[2]}${naive[3] || ''}Z`);
  return new Date(text);
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
 * @param {object} db
 * @param {string|undefined|null} jti
 * @param {string} expiresAt
 * @param {string} [tenantId] the tenant the token was issued for
 * @returns {Promise<void>}
 */
async function revokeToken(db, jti, expiresAt, tenantId) {
  if (!jti) return;
  try {
    // `revoked_tokens.tenant_id` is `NOT NULL`, and a row that names no
    // tenant is refused by the database — which would leave the token alive.
    // The column's own default is the migration's tenant, so a caller that
    // does not know the tenant falls back to it.
    await db
      .prepare(
        "REPLACE INTO revoked_tokens (jti, tenant_id, expires_at, created_at) VALUES (?, ?, ?, NOW())",
      )
      .run(jti, tenantId || DEFAULT_TENANT_ID, expiresAt);
  } catch (e) {
    console.warn('[auth] revoke failed:', e.message);
  }
}

/**
 * Revoke every session a user holds.
 *
 * A password change or a reset has to end the sessions that were opened with
 * the old one. A token that outlives the password it was issued against is a
 * credential the owner cannot take back by changing their password — which
 * is exactly what a password change is supposed to mean.
 *
 * @param {object} db
 * @param {string} userId
 * @param {string} [tenantId] the tenant the sessions belong to
 * @param {string[]} [keepJtis] token ids to leave alive — the session that
 *   is doing the changing, so it is not logged out by its own request
 * @returns {Promise<number>} how many tokens were revoked
 */
async function revokeUserSessions(db, userId, tenantId, keepJtis) {
  if (!userId) return 0;
  const keep = new Set((keepJtis || []).filter(Boolean));
  try {
    const rows = await db
      .prepare('SELECT jti, expires_at FROM token_registry WHERE user_id = ?')
      .all(userId);
    let revoked = 0;
    for (const row of rows) {
      if (keep.has(row.jti)) continue;
      await revokeToken(db, row.jti, row.expires_at, tenantId);
      revoked += 1;
    }
    return revoked;
  } catch (e) {
    // The password is already changed; failing to end the old sessions is
    // worth a warning, but it must not fail the request that changed it.
    console.warn('[auth] session revocation failed:', e.message);
    return 0;
  }
}

/**
 * @param {object} db
 * @param {string|undefined|null} jti
 * @returns {Promise<boolean>}
 */
async function isRevoked(db, jti) {
  if (!jti) return false;
  try {
    const row = await db
      .prepare('SELECT 1 AS x FROM revoked_tokens WHERE jti = ?')
      .get(jti);
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
 * The database calls are asynchronous, so the lookup runs inside an async
 * IIFE. Express 4 does not await a middleware's return value, so a rejected
 * promise would never reach the error handler — the `.catch(next)` hands the
 * failure to Express instead, which is what a synchronous throw used to do.
 *
 * @param {object} db
 * @returns {import('express').RequestHandler}
 */
function authRequired(db) {
  return (req, res, next) => {
    (async () => {
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
      // A token without a tenant cannot be allowed to reach a handler: the
      // tenant is what every business query is filtered by, so a token that
      // does not carry one would query the whole library.
      if (!payload.tid) {
        return res.status(401).json({ detail: 'Token does not carry a tenant' });
      }
      // The token names the tenant, the user's row has to agree with it: a
      // token that outlived a move to another tenant stops working.
      const user = await db
        .prepare(
          'SELECT id, username, role, is_active, tenant_id FROM users WHERE id = ? AND tenant_id = ?',
        )
        .get(payload.sub, payload.tid);
      if (!user) return res.status(401).json({ detail: 'User not found' });
      if (!user.is_active) return res.status(403).json({ detail: 'User is disabled' });
      if (await isRevoked(db, payload.jti)) {
        return res.status(401).json({ detail: 'Token revoked' });
      }
      const tenant = await resolveTenantFromUser(db, user);
      if (!tenant) return res.status(403).json({ detail: 'Tenant not found' });
      if (tenant.status !== 'active') {
        return res.status(403).json({ detail: 'Tenant is suspended' });
      }
      // The `X-Tenant` header narrows a platform administrator's scope to one
      // tenant — for reads as well as writes. It is read here, in one place,
      // so that "the tenant this request speaks for" has a single answer for
      // the whole request. A caller who already has a tenant is not affected:
      // the header is not a way out of one.
      const resolved = await resolveScope(db, user, tenant, req);
      req.user = {
        id: user.id,
        username: user.username,
        role: user.role,
        tenant_id: user.tenant_id,
      };
      req.token = payload;
      req.tenant = resolved.tenant;
      req.tenantScope = resolved.scope;
      return next();
    })().catch(next);
  };
}

/**
 * Middleware: require an admin-role access token.
 *
 * @param {object} db
 * @returns {import('express').RequestHandler}
 */
function adminRequired(db) {
  const requireAuth = authRequired(db);
  return (req, res, next) => {
    requireAuth(req, res, (err) => {
      // `authRequired` only calls the callback on success; a failure it
      // forwarded to the error handler arrives here as `err`.
      if (err) return next(err);
      // A platform administrator is at least an administrator: they may
      // manage every tenant, so they may manage the users of every tenant.
      if (req.user.role !== 'admin' && req.user.role !== SUPERADMIN_ROLE) {
        return res.status(403).json({ detail: 'Admin role required' });
      }
      return next();
    });
  };
}

/**
 * Middleware: require a platform-administrator access token.
 *
 * The gate reads the *role*, not the scope. A platform administrator who
 * narrowed their request to one tenant with `X-Tenant` still is one — the
 * header chooses which tenant the request speaks for, it does not unmake
 * the account. And a tenant admin never passes this gate, however wide
 * their scope is: there is no tenant admin whose scope is wide.
 *
 * @param {object} db
 * @returns {import('express').RequestHandler}
 */
function superadminRequired(db) {
  const requireAuth = authRequired(db);
  return (req, res, next) => {
    requireAuth(req, res, (err) => {
      if (err) return next(err);
      if (req.user.role !== SUPERADMIN_ROLE) {
        return res.status(403).json({ detail: 'Platform administrator role required' });
      }
      return next();
    });
  };
}

/**
 * Middleware: require a valid API key carrying the given scope.
 *
 * @param {object} db
 * @param {string} requiredScope
 * @returns {import('express').RequestHandler}
 */
function apiKeyRequired(db, requiredScope) {
  return (req, res, next) => {
    (async () => {
      const provided = req.headers['x-api-key'] || req.query.api_key;
      if (!provided) return res.status(401).json({ detail: 'Missing API key' });
      const hash = crypto.createHash('sha256').update(provided).digest('hex');
      // The key carries the tenant it was created in — the key *is* the
      // tenant's credential, so the tenant comes from the row and never
      // from the request.
      const key = await db
        .prepare(
          `SELECT id, name, key_prefix, key_hash, scopes, is_active, last_used_at,
                  expires_at, created_at, tenant_id
             FROM api_keys WHERE key_hash = ? AND is_active = 1`,
        )
        .get(hash);
      if (!key) return res.status(401).json({ detail: 'Invalid API key' });
      const expiresAt = parseDateTime(key.expires_at);
      if (expiresAt && expiresAt < new Date()) {
        return res.status(401).json({ detail: 'API key expired' });
      }
      const scopes = String(key.scopes || '')
        .split(',')
        .map((scope) => scope.trim())
        .filter(Boolean);
      if (requiredScope && !scopes.includes(requiredScope) && !scopes.includes('*')) {
        return res.status(403).json({ detail: `Missing scope: ${requiredScope}` });
      }
      const tenant = await loadTenant(db, key.tenant_id);
      if (!tenant) return res.status(403).json({ detail: 'Tenant not found' });
      if (tenant.status !== 'active') {
        return res.status(403).json({ detail: 'Tenant is suspended' });
      }
      // The row was just read, so its own tenant is the condition: the
      // bookkeeping update cannot touch another tenant's key.
      await db
        .prepare('UPDATE api_keys SET last_used_at = NOW() WHERE id = ? AND tenant_id = ?')
        .run(key.id, key.tenant_id);
      req.apiKey = key;
      req.tenant = tenant;
      // A key speaks for exactly one tenant — never for all of them.
      req.tenantScope = tenantScope(
        { id: key.id, role: 'api-key', tenant_id: key.tenant_id },
        tenant,
      );
      return next();
    })().catch(next);
  };
}

module.exports = {
  issueTokenPair,
  revokeToken,
  revokeUserSessions,
  isRevoked,
  bearerToken,
  authRequired,
  adminRequired,
  superadminRequired,
  apiKeyRequired,
  expiresAtOf,
  parseDateTime,
};
