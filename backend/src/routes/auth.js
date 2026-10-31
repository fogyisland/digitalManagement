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

const MIN_PASSWORD_LENGTH = 6;

/**
 * @param {{db: import('better-sqlite3').Database}} deps
 * @returns {import('express').Router}
 */
function createAuthRouter({ db }) {
  const router = express.Router();

  router.post('/auth/login', (req, res) => {
    const { username, password } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ detail: 'username/password required' });
    }
    const user = db
      .prepare('SELECT * FROM users WHERE username = ? AND is_active = 1')
      .get(String(username));
    if (!user || !bcrypt.compareSync(String(password), user.password_hash)) {
      return res.status(401).json({ detail: 'Invalid credentials' });
    }
    db.prepare("UPDATE users SET last_login_at = datetime('now') WHERE id = ?").run(user.id);
    const tokens = issueTokenPair(db, user);
    const fresh = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
    return res.json({ ...tokens, user: toUser(fresh) });
  });

  router.post('/auth/refresh', (req, res) => {
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
    if (isRevoked(db, payload.jti)) {
      return res.status(401).json({ detail: 'Refresh token revoked' });
    }
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(payload.sub);
    if (!user) return res.status(401).json({ detail: 'User not found' });
    if (!user.is_active) return res.status(403).json({ detail: 'User is disabled' });

    // Rotate: the presented refresh token is burned and a new pair is issued.
    revokeToken(db, payload.jti, expiresAtOf(getConfig().refreshTokenTtl));
    const tokens = issueTokenPair(db, user);
    return res.json(tokens);
  });

  router.post('/auth/logout', authRequired(db), (req, res) => {
    const { accessTokenTtl, refreshTokenTtl } = getConfig();
    revokeToken(db, req.token.jti, expiresAtOf(accessTokenTtl));
    // `sid` points at the refresh token that belongs to this session.
    revokeToken(db, req.token.sid, expiresAtOf(refreshTokenTtl));
    return res.status(204).end();
  });

  router.get('/auth/me', authRequired(db), (req, res) => {
    const row = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    if (!row) return res.status(404).json({ detail: 'User not found' });
    return res.json(toUser(row));
  });

  router.post('/auth/change-password', authRequired(db), (req, res) => {
    const { old_password, new_password } = req.body || {};
    if (!old_password || !new_password) {
      return res.status(400).json({ detail: 'old_password/new_password required' });
    }
    if (String(new_password).length < MIN_PASSWORD_LENGTH) {
      return res.status(400).json({
        detail: `new_password must be at least ${MIN_PASSWORD_LENGTH} characters`,
      });
    }
    const row = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    if (!row) return res.status(404).json({ detail: 'User not found' });
    if (!bcrypt.compareSync(String(old_password), row.password_hash)) {
      return res.status(400).json({ detail: 'Current password is incorrect' });
    }
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(
      bcrypt.hashSync(String(new_password), 10),
      row.id,
    );
    return res.status(204).end();
  });

  return router;
}

module.exports = createAuthRouter;
