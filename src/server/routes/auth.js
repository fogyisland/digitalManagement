'use strict';

/**
 * Authentication routes.
 *
 * Contract (mirrored by `frontend/src/api/auth.ts`):
 *   POST /auth/login            {username, password, tenant?} -> LoginResponse
 *   POST /auth/platform-login   {username, password}          -> LoginResponse
 *   GET  /auth/tenants          (public)                     -> {items: TenantDirectoryEntry[]}
 *   POST /auth/refresh          {refresh_token}                -> TokenResponse
 *   POST /auth/logout           (Bearer)                       -> 204
 *   GET  /auth/me               (Bearer)                       -> User
 *   POST /auth/change-password  {old_password, new_password}  -> 204
 *
 * ## Two doors
 *
 * The login page is the **tenant** door: you name the tenant you are signing
 * into, and the credentials have to belong to it. The platform door
 * (`/auth/platform-login`) is one layer up — it admits platform administrators
 * only, and the session it opens is not narrowed to any tenant.
 */

const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { getConfig } = require('../config');
const { issueTokenPair, revokeToken, revokeUserSessions, isRevoked, bearerToken, authRequired, expiresAtOf } = require('../lib/auth');
const { resolveTenantFromUser, loadTenant, SUPERADMIN_ROLE } = require('../lib/tenant');
const { toUser } = require('../lib/dto');
const { asyncHandler } = require('../lib/http');

const MIN_PASSWORD_LENGTH = 6;

/**
 * The accounts a credential names.
 *
 * A username is unique *per tenant*, so the same name may exist in more than
 * one. The optional `tenant` selector disambiguates; without one, the
 * credentials have to identify exactly one live user — and a failure is the
 * same 401 a wrong password gets, never a hint that the name is shared
 * between tenants.
 *
 * This lookup is the one place where the tenant cannot be a filter: it is
 * what establishes which tenant the credential belongs to.
 *
 * @param {object} db
 * @param {string} username
 * @param {string} password
 * @returns {Promise<object[]>} the live accounts whose password matches
 */
async function matchCredential(db, username, password) {
  // tenant-lint: allow the tenant is what this query establishes
  const candidates = await db
    .prepare('SELECT * FROM users WHERE username = ? AND is_active = 1 ORDER BY created_at ASC')
    .all(String(username));
  return candidates.filter((row) =>
    bcrypt.compareSync(String(password), row.password_hash),
  );
}

/**
 * Sign an account in and answer with its token pair.
 *
 * @param {object} db
 * @param {object} user the account row
 * @returns {Promise<object>} the login response
 */
async function issueSession(db, user) {
  await db
    .prepare('UPDATE users SET last_login_at = NOW() WHERE id = ? AND tenant_id = ?')
    .run(user.id, user.tenant_id);
  const tokens = await issueTokenPair(db, user);
  const fresh = await db
    .prepare('SELECT * FROM users WHERE id = ? AND tenant_id = ?')
    .get(user.id, user.tenant_id);
  return { ...tokens, user: toUser(fresh) };
}

/**
 * @param {{db: object}} deps
 * @returns {import('express').Router}
 */
function createAuthRouter({ db }) {
  const router = express.Router();

  // The tenant directory the login page offers.
  //
  // It is public because the login page has to name a tenant *before* there is
  // a session — and it carries nothing but the id, the name and the state. The
  // assets, the accounts and the counts of a tenant are not anybody's business
  // before they sign in.
  router.get('/auth/tenants', asyncHandler(async (_req, res) => {
    const rows = await db
      .prepare('SELECT id, name, status FROM tenants ORDER BY name ASC')
      .all();
    return res.json({
      items: rows.map((row) => ({ id: row.id, name: row.name, status: row.status })),
    });
  }));

  // The platform door: one layer above every tenant.
  //
  // Only a platform administrator may come through it — a tenant administrator
  // has no business on the layer above their own tenant, so the answer is a
  // refusal rather than a redirect. The session it opens is not narrowed to a
  // tenant: it is the platform's own scope.
  router.post('/auth/platform-login', asyncHandler(async (req, res) => {
    const { username, password } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ detail: 'username/password required' });
    }
    const matching = await matchCredential(db, username, password);
    if (matching.length !== 1) {
      return res.status(401).json({ detail: 'Invalid credentials' });
    }
    const user = matching[0];
    if (user.role !== SUPERADMIN_ROLE) {
      return res.status(403).json({ detail: 'Platform administrator required' });
    }
    return res.json(await issueSession(db, user));
  }));

  router.post('/auth/login', asyncHandler(async (req, res) => {
    const { username, password } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ detail: 'username/password required' });
    }
    const matching = await matchCredential(db, username, password);
    // The tenant door is for the accounts of one tenant. A platform
    // administrator has its own door, one layer up — letting it in here too
    // would blur the two, and a session that says "tenant" while the account
    // may read every tenant is a session that lies.
    if (matching.length === 1 && matching[0].role === SUPERADMIN_ROLE) {
      return res.status(403).json({
        detail: 'This account is a platform administrator — sign in through the platform door',
      });
    }
    const tenantAccounts = matching.filter((row) => row.role !== SUPERADMIN_ROLE);
    const tenantSelector = req.body && req.body.tenant ? String(req.body.tenant) : '';
    // The door names the tenant, so the credential has to belong to it.
    const selected = tenantSelector
      ? tenantAccounts.filter((row) => row.tenant_id === tenantSelector)
      : tenantAccounts;
    if (selected.length !== 1) {
      return res.status(401).json({ detail: 'Invalid credentials' });
    }
    const user = selected[0];
    // The tenant the door names has to be a live tenant: a suspended tenant's
    // accounts cannot sign in through its own door either.
    if (tenantSelector) {
      const named = await loadTenant(db, tenantSelector);
      if (!named) {
        return res.status(403).json({ detail: 'Tenant not found' });
      }
      if (named.status !== 'active') {
        return res.status(403).json({ detail: 'Tenant is suspended' });
      }
    }
    // A suspended tenant's accounts cannot sign in. Suspending a tenant is the
    // platform administrator's way of saying "this tenant stops now" — and it
    // has to stop at the door, not one request later.
    const tenant = await resolveTenantFromUser(db, user);
    if (!tenant) {
      return res.status(403).json({ detail: 'Tenant not found' });
    }
    if (tenant.status !== 'active') {
      return res.status(403).json({ detail: 'Tenant is suspended' });
    }
    return res.json(await issueSession(db, user));
  }));

  router.post('/auth/refresh', asyncHandler(async (req, res) => {
    const provided = (req.body || {}).refresh_token || bearerToken(req);
    if (!provided) {
      return res.status(400).json({ detail: 'refresh_token required' });
    }
    let payload;
    try {
      payload = jwt.verify(String(provided), getConfig().jwtSecret);
    } catch (e) {
      return res.status(401).json({ detail: 'Invalid refresh token' });
    }
    if (payload.typ !== 'refresh') {
      return res.status(401).json({ detail: 'Not a refresh token' });
    }
    if (await isRevoked(db, payload.jti)) {
      return res.status(401).json({ detail: 'Refresh token revoked' });
    }
    // The refresh token carries the tenant it was issued for, exactly like
    // the access token does — a refreshable session cannot be moved.
    if (!payload.tid) {
      return res.status(401).json({ detail: 'Refresh token does not carry a tenant' });
    }
    const user = await db
      .prepare('SELECT * FROM users WHERE id = ? AND tenant_id = ?')
      .get(payload.sub, payload.tid);
    if (!user) return res.status(401).json({ detail: 'User not found' });
    if (!user.is_active) return res.status(403).json({ detail: 'User is disabled' });

    // Rotate: the presented refresh token is burned and a new pair is issued.
    await revokeToken(db, payload.jti, expiresAtOf(getConfig().refreshTokenTtl), payload.tid);
    const tokens = await issueTokenPair(db, user);
    return res.json(tokens);
  }));

  router.post('/auth/logout', authRequired(db), asyncHandler(async (req, res) => {
    const { accessTokenTtl, refreshTokenTtl } = getConfig();
    await revokeToken(db, req.token.jti, expiresAtOf(accessTokenTtl), req.token.tid);
    // `sid` points at the refresh token that belongs to this session.
    await revokeToken(db, req.token.sid, expiresAtOf(refreshTokenTtl), req.token.tid);
    return res.status(204).end();
  }));

  router.get('/auth/me', authRequired(db), asyncHandler(async (req, res) => {
    const row = await db
      .prepare('SELECT * FROM users WHERE id = ? AND tenant_id = ?')
      .get(req.user.id, req.user.tenant_id);
    if (!row) return res.status(404).json({ detail: 'User not found' });
    return res.json(toUser(row));
  }));

  router.post('/auth/change-password', authRequired(db), asyncHandler(async (req, res) => {
    const { old_password, new_password } = req.body || {};
    if (!old_password || !new_password) {
      return res.status(400).json({ detail: 'old_password/new_password required' });
    }
    if (String(new_password).length < MIN_PASSWORD_LENGTH) {
      return res.status(400).json({
        detail: `new_password must be at least ${MIN_PASSWORD_LENGTH} characters`,
      });
    }
    const row = await db
      .prepare('SELECT * FROM users WHERE id = ? AND tenant_id = ?')
      .get(req.user.id, req.user.tenant_id);
    if (!row) return res.status(404).json({ detail: 'User not found' });
    if (!bcrypt.compareSync(String(old_password), row.password_hash)) {
      return res.status(400).json({ detail: 'Current password is incorrect' });
    }
    await db
      .prepare('UPDATE users SET password_hash = ? WHERE id = ? AND tenant_id = ?')
      .run(bcrypt.hashSync(String(new_password), 10), row.id, row.tenant_id);
    // Every *other* session ends here. The one making the request stays
    // alive — the caller is not logged out by its own password change — but
    // a token opened with the old password is dead from now on.
    await revokeUserSessions(db, row.id, row.tenant_id, [req.token.jti, req.token.sid]);
    return res.status(204).end();
  }));

  return router;
}

module.exports = createAuthRouter;
