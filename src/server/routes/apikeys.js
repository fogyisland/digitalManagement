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
const { isAllTenants } = require('../lib/tenant');
const { asyncHandler } = require('../lib/http');
const { toMysqlDateTime } = require('../lib/util');

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
 * @param {{db: object}} deps
 * @returns {import('express').Router}
 */
function createApiKeysRouter({ db }) {
  const router = express.Router();

  router.get(
    '/api-keys',
    authRequired(db),
    asyncHandler(async (req, res) => {
      const scope = req.tenantScope;
      // tenant-lint: allow a superadmin reads across every tenant
      const rows = isAllTenants(scope)
        ? await db
            .prepare(
              'SELECT id, name, key_prefix, scopes, is_active, last_used_at, expires_at, created_at FROM api_keys ORDER BY created_at DESC',
            )
            .all()
        : await db
            .prepare(
              'SELECT id, name, key_prefix, scopes, is_active, last_used_at, expires_at, created_at FROM api_keys WHERE tenant_id = ? ORDER BY created_at DESC',
            )
            .all(scope.tenantId);
      return res.json(rows.map(toApiKey));
    }),
  );

  router.post(
    '/api-keys',
    authRequired(db),
    asyncHandler(async (req, res) => {
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

      // MySQL only accepts `YYYY-MM-DD HH:MM:SS` in a DATETIME column, so
      // the client's ISO-8601 value has to be converted first.
      const expiresAt = toMysqlDateTime(expires_at);
      if (expires_at && !expiresAt) {
        return res.status(400).json({ detail: 'expires_at must be a valid date' });
      }

      // A key is born inside the caller's tenant — the tenant is never a
      // request field, since a credential that could name its own tenant
      // would be able to name somebody else's.
      await db
        .prepare(
          'INSERT INTO api_keys (id, tenant_id, name, key_prefix, key_hash, scopes, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          id,
          req.tenantScope.tenantId,
          String(name),
          prefix,
          hash,
          effectiveScopes.join(','),
          expiresAt,
        );

      // The raw key is returned exactly once — it is never stored in clear.
      return res.status(201).json({
        id,
        name: String(name),
        key: raw,
        key_prefix: prefix,
        scopes: effectiveScopes,
        expires_at: expiresAt,
        warning: 'Save this key now. It will not be shown again.',
      });
    }),
  );

  router.put(
    '/api-keys/:id',
    authRequired(db),
    asyncHandler(async (req, res) => {
      const tenantId = req.tenantScope.tenantId;
      const key = await db
        .prepare('SELECT * FROM api_keys WHERE id = ? AND tenant_id = ?')
        .get(req.params.id, tenantId);
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

      // The same conversion as on create: MySQL's DATETIME does not accept
      // the ISO-8601 form the API speaks.
      let nextExpiresAt = key.expires_at;
      if (expires_at !== undefined) {
        nextExpiresAt = toMysqlDateTime(expires_at);
        if (expires_at && !nextExpiresAt) {
          return res.status(400).json({ detail: 'expires_at must be a valid date' });
        }
      }

      await db
        .prepare(
          'UPDATE api_keys SET name = ?, scopes = ?, expires_at = ?, is_active = ? WHERE id = ? AND tenant_id = ?',
        )
        .run(
          name === undefined || name === null ? key.name : String(name),
          nextScopes,
          nextExpiresAt,
          is_active === undefined || is_active === null ? key.is_active : is_active ? 1 : 0,
          key.id,
          tenantId,
        );
      const row = await db
        .prepare('SELECT * FROM api_keys WHERE id = ? AND tenant_id = ?')
        .get(key.id, tenantId);
      return res.json(toApiKey(row));
    }),
  );

  router.delete(
    '/api-keys/:id',
    authRequired(db),
    asyncHandler(async (req, res) => {
      const tenantId = req.tenantScope.tenantId;
      const key = await db
        .prepare('SELECT id FROM api_keys WHERE id = ? AND tenant_id = ?')
        .get(req.params.id, tenantId);
      if (!key) return res.status(404).json({ detail: 'Not found' });
      await db
        .prepare('UPDATE api_keys SET is_active = 0 WHERE id = ? AND tenant_id = ?')
        .run(key.id, tenantId);
      return res.status(204).end();
    }),
  );

  return router;
}

module.exports = createApiKeysRouter;
