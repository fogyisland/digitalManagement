'use strict';

/**
 * Authentication routes.
 *
 * Contract (mirrored by `frontend/src/api/auth.ts`):
 *   POST /auth/login            {username, password}          -> LoginResponse
 *   POST /auth/refresh          {refresh_token}                -> TokenResponse
 *   POST /auth/logout           (Bearer)                       -> 204
 *   GET  /auth/me               (Bearer)                       -> User
 *   POST /auth/change-password  {old_password, new_password}  -> 204
 */

const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { getConfig } = require('../config');
const { issueTokenPair, revokeToken, isRevoked, bearerToken, authRequired, expiresAtOf } = require('../lib/auth');
const { toUser } = require('../lib/dto');
const { asyncHandler } = require('../lib/http');

const MIN_PASSWORD_LENGTH = 6;

/**
 * @param {{db: object}} deps
 * @returns {import('express').Router}
 */
function createAuthRouter({ db }) {
  const router = express.Router();

  router.post('/auth/login', asyncHandler(async (req, res) => {
    const { username, password } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ detail: 'username/password required' });
    }
    // A username is unique *per tenant*, so the same name may exist in more
    // than one. An optional `tenant` selector disambiguates; without one, the
    // credentials have to identify exactly one live user — and a failure is
    // the same 401 a wrong password gets, never a hint that the name is
    // shared between tenants.
    const candidates = await db
      .prepare(
        'SELECT * FROM users WHERE username = ? AND is_active = 1 ORDER BY created_at ASC',
      )
      .all(String(username));
    const matching = candidates.filter((row) =>
      bcrypt.compareSync(String(password), row.password_hash),
    );
    const tenantSelector = req.body && req.body.tenant ? String(req.body.tenant) : '';
    const selected = tenantSelector
      ? matching.filter((row) => row.tenant_id === tenantSelector)
      : matching;
    if (selected.length !== 1) {
      return res.status(401).json({ detail: 'Invalid credentials' });
    }
    const user = selected[0];
    await db
      .prepare('UPDATE users SET last_login_at = NOW() WHERE id = ? AND tenant_id = ?')
      .run(user.id, user.tenant_id);
    const tokens = await issueTokenPair(db, user);
    const fresh = await db
      .prepare('SELECT * FROM users WHERE id = ? AND tenant_id = ?')
      .get(user.id, user.tenant_id);
    return res.json({ ...tokens, user: toUser(fresh) });
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
    await revokeToken(db, payload.jti, expiresAtOf(getConfig().refreshTokenTtl));
    const tokens = await issueTokenPair(db, user);
    return res.json(tokens);
  }));

  router.post('/auth/logout', authRequired(db), asyncHandler(async (req, res) => {
    const { accessTokenTtl, refreshTokenTtl } = getConfig();
    await revokeToken(db, req.token.jti, expiresAtOf(accessTokenTtl));
    // `sid` points at the refresh token that belongs to this session.
    await revokeToken(db, req.token.sid, expiresAtOf(refreshTokenTtl));
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
    return res.status(204).end();
  }));

  return router;
}

module.exports = createAuthRouter;
