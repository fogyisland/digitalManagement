'use strict';

/**
 * API key routes.
 *
 * Contract (mirrored by `frontend/src/api/apikeys.ts`):
 *   GET    /api-keys     -> ApiKey[]
 *   POST   /api-keys     {name, scopes[], expires_at?} -> ApiKeyCreated
 *   PUT    /api-keys/:id {name?, scopes[]?, expires_at?, is_active?} -> ApiKey
 *   DELETE /api-keys/:id -> 204   (soft disable — the row is kept for audit)
 *
 * `scopes` is stored as a CSV string in the database and exposed as an
 * array on the wire, so the frontend never has to split it.
 */

const express = require('express');
const crypto = require('crypto');
const { nanoid } = require('nanoid');
const { authRequired } = require('../lib/auth');
const { toApiKey } = require('../lib/dto');

const DEFAULT_SCOPES = ['read', 'upload'];
const KNOWN_SCOPES = ['read', 'upload', 'delete', 'write', '*'];

/**
 * Accept both an array and a CSV string; always return a clean array.
 *
 * @param {unknown} value
 * @returns {string[]}
 */
function normalizeScopes(value) {
  if (Array.isArray(value)) {
    return value.map((scope) => String(scope).trim()).filter(Boolean);
  }
  if (typeof value === 'string') {
    return value
      .split(',')
      .map((scope) => scope.trim())
      .filter(Boolean);
  }
  return [];
}

/**
 * @param {{db: import('better-sqlite3').Database}} deps
 * @returns {import('express').Router}
 */
function createApiKeysRouter({ db }) {
  const router = express.Router();

  router.get('/api-keys', authRequired(db), (_req, res) => {
    const rows = db
      .prepare(
        'SELECT id, name, key_prefix, scopes, is_active, last_used_at, expires_at, created_at FROM api_keys ORDER BY created_at DESC',
      )
      .all();
    return res.json(rows.map(toApiKey));
  });

  router.post('/api-keys', authRequired(db), (req, res) => {
    const { name, scopes, expires_at, description } = req.body || {};
    if (!name) return res.status(400).json({ detail: 'name required' });
    const scopeList = normalizeScopes(scopes);
    const effectiveScopes = scopeList.length ? scopeList : DEFAULT_SCOPES;
    const unknown = effectiveScopes.filter((scope) => !KNOWN_SCOPES.includes(scope));
    if (unknown.length) {
      return res.status(400).json({ detail: `Unsupported scopes: ${unknown.join(', ')}` });
    }

    const raw = `dam_${crypto.randomBytes(24).toString('hex')}`;
    const hash = crypto.createHash('sha256').update(raw).digest('hex');
    const prefix = raw.slice(0, 12);
    const id = nanoid();
    db.prepare(
      'INSERT INTO api_keys (id, name, key_prefix, key_hash, scopes, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(id, String(name), prefix, hash, effectiveScopes.join(','), expires_at || null);

    // The raw key is returned exactly once — it is never stored in clear.
    return res.status(201).json({
      id,
      name: String(name),
      key: raw,
      key_prefix: prefix,
      scopes: effectiveScopes,
      expires_at: expires_at || null,
      warning: 'Save this key now. It will not be shown again.',
    });
  });

  router.put('/api-keys/:id', authRequired(db), (req, res) => {
    const key = db.prepare('SELECT * FROM api_keys WHERE id = ?').get(req.params.id);
    if (!key) return res.status(404).json({ detail: 'Not found' });
    const { name, scopes, expires_at, is_active } = req.body || {};

    let nextScopes = key.scopes;
    if (scopes !== undefined && scopes !== null) {
      const scopeList = normalizeScopes(scopes);
      const unknown = scopeList.filter((scope) => !KNOWN_SCOPES.includes(scope));
      if (unknown.length) {
        return res.status(400).json({ detail: `Unsupported scopes: ${unknown.join(', ')}` });
      }
      nextScopes = scopeList.join(',');
    }

    db.prepare(
      'UPDATE api_keys SET name = ?, scopes = ?, expires_at = ?, is_active = ? WHERE id = ?',
    ).run(
      name === undefined || name === null ? key.name : String(name),
      nextScopes,
      expires_at === undefined ? key.expires_at : expires_at || null,
      is_active === undefined || is_active === null ? key.is_active : is_active ? 1 : 0,
      key.id,
    );
    const row = db.prepare('SELECT * FROM api_keys WHERE id = ?').get(key.id);
    return res.json(toApiKey(row));
  });

  router.delete('/api-keys/:id', authRequired(db), (req, res) => {
    const key = db.prepare('SELECT id FROM api_keys WHERE id = ?').get(req.params.id);
    if (!key) return res.status(404).json({ detail: 'Not found' });
    db.prepare('UPDATE api_keys SET is_active = 0 WHERE id = ?').run(key.id);
    return res.status(204).end();
  });

  return router;
}

module.exports = createApiKeysRouter;
