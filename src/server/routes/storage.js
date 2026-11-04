'use strict';

/**
 * The stored files.
 *
 * The files under the storage directory are the product's data, and each one
 * belongs to a tenant. They used to be served by a static mount over the
 * whole directory, which published every tenant's originals to anybody who
 * could name the file. They are served here instead, behind a check:
 *
 *   - a **signed URL** — `/storage/originals/<id>.png?exp=…&sig=…` — which
 *     the server issued to a caller who may already see the asset. It grants
 *     access to that one file until it expires, and it is what the frontend
 *     puts into `<img src>`, because a browser's image request cannot carry
 *     an `Authorization` header;
 *   - or a **bearer token** whose tenant owns the asset, for the API
 *     consumers that fetch the bytes themselves.
 *
 * A URL without a valid signature is refused, so guessing an asset id buys
 * nothing — the id is not the credential, the signature is. A request that
 * carries both a signature and a token must have them agree, so a token
 * from another tenant cannot ride in on somebody else's link.
 *
 * The manifest index is deliberately not served here. It enumerates the
 * whole library, so it belongs to the authenticated API, not to a file
 * route — see `/api/v1/manifest` below.
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const { getConfig } = require('../config');
const { verifySignedPath } = require('../lib/storage-url');
const { asyncHandler } = require('../lib/http');

/** The subdirectories that hold an asset's files. */
const FILE_KINDS = ['originals', 'thumbnails', 'placeholders'];

/** The content types the stored files can have. */
const MIME_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.pdf': 'application/pdf',
  '.json': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
  '.zip': 'application/zip',
};

/**
 * The content type for a file name.
 *
 * @param {string} fileName
 * @returns {string}
 */
function contentTypeFor(fileName) {
  return MIME_TYPES[path.extname(fileName).toLowerCase()] || 'application/octet-stream';
}

/**
 * The asset id inside a stored file's name.
 *
 * The files are named after the asset — `<assetId>.<ext>` — so the id can be
 * read back out of the path. The id is not a credential: it says which row
 * the file belongs to, and the row decides who may read it.
 *
 * @param {string} relativePath
 * @returns {string|null}
 */
function assetIdOf(relativePath) {
  const name = path.posix.basename(relativePath);
  const dot = name.indexOf('.');
  const id = dot === -1 ? name : name.slice(0, dot);
  return id.length > 0 ? id : null;
}

/**
 * Resolve a request path to a file inside the storage directory.
 *
 * The result is checked against the storage root, so a path that tries to
 * climb out of it (`../../etc/passwd`) resolves to nothing.
 *
 * @param {string} storageDir
 * @param {string} relativePath
 * @returns {string|null} the absolute path, or `null` when it escapes
 */
function resolveInside(storageDir, relativePath) {
  const root = path.resolve(storageDir);
  const absolute = path.resolve(root, relativePath);
  if (absolute !== root && !absolute.startsWith(root + path.sep)) return null;
  return absolute;
}

/**
 * @param {{db: object}} deps
 * @returns {import('express').Router}
 */
function createStorageRouter({ db }) {
  const router = express.Router();

  /**
   * Read the asset a stored file belongs to.
   *
   * The lookup is by the asset's primary key, so it names no tenant: which
   * tenant may read the file is decided by the caller — the signature or the
   * token — and compared against the row's own tenant below.
   *
   * @param {string} id
   * @returns {Promise<object|null>}
   */
  async function findAsset(id) {
    return db
      .prepare('SELECT id, tenant_id, storage_path, thumbnail_path, mime_type, original_name FROM assets WHERE id = ?')
      .get(String(id));
  }

  /**
   * Whether the asset really owns this file.
   *
   * @param {object} asset
   * @param {string} relativePath
   * @returns {boolean}
   */
  function assetOwnsPath(asset, relativePath) {
    const stored = String(asset.storage_path || '');
    const thumbnail = String(asset.thumbnail_path || '');
    const normalized = relativePath.split(path.sep).join('/');
    return (
      stored.split(path.sep).join('/') === normalized ||
      thumbnail.split(path.sep).join('/') === normalized
    );
  }

  router.get(
    '/*',
    asyncHandler(async (req, res) => {
      const relativePath = decodeURIComponent(req.params[0] || '').replace(/^\/+/, '');
      const segments = relativePath.split('/').filter(Boolean);
      if (segments.length !== 2) {
        return res.status(404).json({ detail: 'Not found' });
      }
      const [kind, fileName] = segments;
      if (!FILE_KINDS.includes(kind)) {
        // The manifest and every other directory under the storage root are
        // not files this route serves.
        return res.status(404).json({ detail: 'Not found' });
      }

      const assetId = assetIdOf(fileName);
      if (!assetId) {
        return res.status(404).json({ detail: 'Not found' });
      }

      const asset = await findAsset(assetId);
      if (!asset) {
        return res.status(404).json({ detail: 'Not found' });
      }
      if (!assetOwnsPath(asset, relativePath)) {
        return res.status(404).json({ detail: 'Not found' });
      }

      // --- the two ways in --------------------------------------------------
      const expiry = req.query.exp;
      const signature = req.query.sig;
      const hasSignature = expiry !== undefined || signature !== undefined;
      if (hasSignature) {
        const verdict = verifySignedPath(relativePath, asset.tenant_id, expiry, signature);
        if (!verdict.ok) {
          return res.status(403).json({ detail: 'The link is not valid' });
        }
      } else {
        // No signature: the caller has to prove who they are with a token,
        // and the token's tenant has to own the file.
        const scope = await resolveTokenScope(req, db);
        if (!scope) {
          return res.status(401).json({ detail: 'Missing token' });
        }
        if (scope.tenantId !== asset.tenant_id) {
          return res.status(404).json({ detail: 'Not found' });
        }
      }

      // A request that carries *both* a signature and a token must have them
      // agree: a token from another tenant does not get to ride in on
      // somebody else's signed link. The browser case sends no token, and the
      // API case sends no signature, so neither is affected.
      const tokenScope = await resolveTokenScope(req, db);
      if (tokenScope && tokenScope.tenantId !== asset.tenant_id) {
        return res.status(404).json({ detail: 'Not found' });
      }

      const absolute = resolveInside(getConfig().storageDir, relativePath);
      if (!absolute || !fs.existsSync(absolute)) {
        return res.status(404).json({ detail: 'Not found' });
      }

      const stat = fs.statSync(absolute);
      res.setHeader('Content-Type', contentTypeFor(fileName));
      res.setHeader('Content-Length', String(stat.size));
      res.setHeader('Cache-Control', 'private, max-age=3600');
      return res.sendFile(absolute);
    }),
  );

  return router;
}

/**
 * Resolve the tenant scope of a bearer token on the request.
 *
 * The storage route is mounted outside the admin API, so it cannot use the
 * `authRequired` middleware directly — that one answers the request itself.
 * This reads the same token and produces the same scope, or `null` when the
 * request carries no usable token.
 *
 * @param {import('express').Request} req
 * @param {object} db
 * @returns {Promise<{tenantId: string, isSuperadmin: boolean}|null>}
 */
async function resolveTokenScope(req, db) {
  const { bearerToken } = require('../lib/auth');
  const jwt = require('jsonwebtoken');
  const { getConfig: config } = require('../config');
  const { resolveTenantFromUser, tenantScope } = require('../lib/tenant');

  const token = bearerToken(req);
  if (!token) return null;
  let payload;
  try {
    payload = jwt.verify(token, config().jwtSecret);
  } catch (error) {
    return null;
  }
  if (!payload || !payload.tid) return null;
  const user = await db
    .prepare('SELECT id, username, role, is_active, tenant_id FROM users WHERE id = ? AND tenant_id = ?')
    .get(payload.sub, payload.tid);
  if (!user || !user.is_active) return null;
  const tenant = await resolveTenantFromUser(db, user);
  if (!tenant || tenant.status !== 'active') return null;
  return tenantScope(user, tenant);
}

module.exports = createStorageRouter;
module.exports.FILE_KINDS = FILE_KINDS;
module.exports.assetIdOf = assetIdOf;
module.exports.contentTypeFor = contentTypeFor;
module.exports.resolveInside = resolveInside;
