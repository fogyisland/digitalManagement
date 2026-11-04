'use strict';

/**
 * Signed URLs for the stored files.
 *
 * The files under the storage directory are the product's data, and they
 * belong to one tenant each. Serving them through a static mount would
 * publish every tenant's originals to anybody who could name the file, so
 * the bytes are served through a route that checks a signature instead.
 *
 * A signed URL is a bearer capability with an expiry:
 *
 *   /storage/originals/<id>.png?exp=1762345678&sig=<hmac>
 *
 * The signature covers the asset's tenant, its path relative to the storage
 * directory, and the expiry — so a signature for one tenant's file says
 * nothing about another tenant's file, and it cannot be moved to another
 * path or extended past its expiry.
 *
 * The URL is issued to a caller who may already see the asset, so the link
 * never reveals more than the caller could get from the API anyway. It
 * exists because a browser's `<img src>` cannot carry an `Authorization`
 * header: the frontend puts these URLs straight into the `src` attribute.
 *
 * The signing key is derived from `JWT_SECRET` with an HMAC, so the two
 * credentials are domain-separated: a signature cannot be replayed as a
 * token, and a token cannot be replayed as a signature.
 */

const crypto = require('crypto');
const { getConfig } = require('../config');

/** How long a signed URL stays valid, in seconds. */
const DEFAULT_STORAGE_URL_TTL = 3600;

/** The domain separator for the derived signing key. */
const KEY_DOMAIN = 'dam.storage-url.v1';

/**
 * The signing key, derived from the configured secret.
 *
 * Deriving it means the storage URLs have their own key: leaking one does
 * not compromise the other, and the derivation is stable across restarts,
 * so a URL issued before a restart still works after it.
 *
 * @returns {Buffer}
 */
function signingKey() {
  return crypto
    .createHmac('sha256', getConfig().jwtSecret)
    .update(KEY_DOMAIN)
    .digest();
}

/**
 * How long a signed URL is valid.
 *
 * @returns {number} seconds
 */
function urlTtlSeconds() {
  const raw = process.env.STORAGE_URL_TTL_SECONDS;
  const parsed = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_STORAGE_URL_TTL;
}

/**
 * The signature for one file.
 *
 * @param {string} tenantId the tenant that owns the file
 * @param {string} relativePath the path relative to the storage directory
 * @param {number} expiresAt the expiry, in Unix seconds
 * @returns {string} the hex signature
 */
function signPath(tenantId, relativePath, expiresAt) {
  const message = `${tenantId}\n${relativePath}\n${expiresAt}`;
  return crypto.createHmac('sha256', signingKey()).update(message).digest('hex');
}

/**
 * Compare two strings without leaking where they differ.
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function timingSafeEqual(a, b) {
  const left = Buffer.from(String(a), 'utf8');
  const right = Buffer.from(String(b), 'utf8');
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

/**
 * Build a signed URL for a stored file.
 *
 * @param {string|null|undefined} relativePath e.g. "thumbnails/abc.webp"
 * @param {string|null|undefined} tenantId the tenant that owns the file
 * @param {number} [expiresAt] the expiry, in Unix seconds; defaults to now
 *   plus the configured TTL
 * @returns {string|null} the URL, or `null` when there is no file
 */
function signedStorageUrl(relativePath, tenantId, expiresAt) {
  if (!relativePath) return null;
  const normalized = String(relativePath)
    .split(/[\\/]+/)
    .filter(Boolean)
    .join('/');
  if (!normalized) return null;
  const expiry = Number.isFinite(expiresAt)
    ? Math.floor(expiresAt)
    : Math.floor(Date.now() / 1000) + urlTtlSeconds();
  const signature = signPath(String(tenantId || ''), normalized, expiry);
  return `/storage/${normalized}?exp=${expiry}&sig=${signature}`;
}

/**
 * Check a signed URL's parameters.
 *
 * The path is checked against the signature, so a signature cannot be moved
 * to another file. The expiry is checked against the clock, so a signature
 * cannot outlive its window.
 *
 * @param {string} relativePath the path relative to the storage directory
 * @param {string|null|undefined} tenantId the tenant that owns the file
 * @param {unknown} expiresAt the `exp` parameter
 * @param {unknown} signature the `sig` parameter
 * @param {number} [now] the current Unix time in seconds
 * @returns {{ok: true}|{ok: false, reason: string}}
 */
function verifySignedPath(relativePath, tenantId, expiresAt, signature, now) {
  if (!signature) return { ok: false, reason: 'missing signature' };
  const expiry = Number(expiresAt);
  if (!Number.isFinite(expiry)) return { ok: false, reason: 'malformed expiry' };
  const current = Number.isFinite(now) ? now : Math.floor(Date.now() / 1000);
  if (expiry <= current) return { ok: false, reason: 'expired signature' };
  const expected = signPath(String(tenantId || ''), relativePath, expiry);
  if (!timingSafeEqual(expected, String(signature))) {
    return { ok: false, reason: 'signature mismatch' };
  }
  return { ok: true };
}

module.exports = {
  DEFAULT_STORAGE_URL_TTL,
  signPath,
  signedStorageUrl,
  timingSafeEqual,
  urlTtlSeconds,
  verifySignedPath,
};
