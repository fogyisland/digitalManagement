'use strict';

/**
 * The per-account MCP tokens.
 *
 * An MCP token is the credential an AI client carries. It speaks for exactly
 * one account, and it inherits that account's tenant and role: a viewer holds
 * a token that can read, an editor holds one that can also write, a platform
 * administrator holds one that spans the platform until a request narrows it
 * with `X-Tenant`.
 *
 * The token is stored the way an API key is — hashed, with a prefix kept so
 * the interface can show which token is which — and it is shown in clear
 * exactly once, when it is issued.
 *
 * ## Why a token and not the session token
 *
 * A session token is short lived and belongs to a browser. An MCP client is
 * not a browser: it holds one credential for as long as it is connected, and
 * it must be revocable on its own. A separate row per client gives the
 * account that is using it a way to cut one client off without ending every
 * other session.
 */

const crypto = require('crypto');
const { nanoid } = require('nanoid');
const { resolveTenantFromUser, resolveScope, isAllTenants } = require('./tenant');

/** The scopes a token may carry. */
const MCP_SCOPES = ['read', 'write', 'delete'];

/**
 * What each role may do through MCP.
 *
 * The role decides — the token never carries more than its account can do,
 * and a token that asks for more is narrowed to what the account allows.
 */
const ROLE_SCOPES = {
  viewer: ['read'],
  editor: ['read', 'write'],
  admin: ['read', 'write', 'delete'],
  superadmin: ['read', 'write', 'delete'],
};

/**
 * @param {string} value
 * @returns {string} the hex digest
 */
function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

/**
 * Mint a token.
 *
 * @returns {{token: string, prefix: string, hash: string}}
 */
function mintToken() {
  const raw = `dam_mcp_${crypto.randomBytes(24).toString('hex')}`;
  return { token: raw, prefix: raw.slice(0, 16), hash: sha256(raw) };
}

/**
 * The scopes an account's tokens may carry.
 *
 * @param {string} role
 * @returns {string[]}
 */
function scopesForRole(role) {
  return (ROLE_SCOPES[role] || ROLE_SCOPES.viewer).slice();
}

/**
 * Normalize a requested scope list.
 *
 * A request may ask for less than the role allows, never for more.
 *
 * @param {unknown} value
 * @param {string[]} allowed
 * @returns {string[]}
 */
function normalizeScopes(value, allowed) {
  const asked = Array.isArray(value)
    ? value.map((scope) => String(scope).trim()).filter(Boolean)
    : String(value || '')
        .split(',')
        .map((scope) => scope.trim())
        .filter(Boolean);
  const usable = asked.filter((scope) => MCP_SCOPES.includes(scope) && allowed.includes(scope));
  return usable.length ? usable : allowed.slice();
}

/**
 * Issue a token for an account.
 *
 * @param {object} db
 * @param {{id: string, role: string, tenant_id: string}} user
 * @param {{name?: string, scopes?: string[]}} input
 * @returns {Promise<object>} the token row, with the clear token in `token`
 */
async function issueMcpToken(db, user, input = {}) {
  const name = String(input.name || '').trim() || `${user.username} 的 MCP 接入`;
  const scopes = normalizeScopes(input.scopes, scopesForRole(user.role));
  const minted = mintToken();
  const id = nanoid();

  await db
    .prepare(
      'INSERT INTO mcp_tokens (id, tenant_id, user_id, name, token_prefix, token_hash, scopes) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    .run([id, user.tenant_id, user.id, name, minted.prefix, minted.hash, scopes.join(',')]);

  return {
    id,
    name,
    token: minted.token,
    token_prefix: minted.prefix,
    scopes,
    is_active: true,
    last_used_at: null,
    created_at: null,
    tenant_id: user.tenant_id,
    user_id: user.id,
  };
}

/**
 * The token rows one caller may see.
 *
 * The scope decides how far the list reaches, exactly as it decides how far
 * every other read reaches:
 *
 *   - a platform administrator who named no tenant sees the whole platform
 *   - a platform administrator who named one sees that tenant's tokens
 *   - an administrator sees their own tenant's tokens — who else holds a
 *     credential is worth knowing
 *   - everybody else sees their own
 *
 * @param {object} db
 * @param {object} user
 * @param {{tenantId: string, isSuperadmin: boolean}} scope
 * @param {boolean} includeTenant when true, every account of the tenant is
 *   listed — an administrator sees who else holds a credential
 * @returns {Promise<object[]>}
 */
async function listMcpTokens(db, user, scope, includeTenant) {
  const tenantId = scope.tenantId;
  if (isAllTenants(scope)) {
    // tenant-lint: allow a platform administrator reads across every tenant
    return db
      .prepare(
        `SELECT id, tenant_id, user_id, name, token_prefix, scopes, is_active, last_used_at, created_at
           FROM mcp_tokens ORDER BY created_at DESC`,
      )
      .all();
  }
  if (includeTenant) {
    return db
      .prepare(
        `SELECT id, tenant_id, user_id, name, token_prefix, scopes, is_active, last_used_at, created_at
           FROM mcp_tokens WHERE tenant_id = ? ORDER BY created_at DESC`,
      )
      .all(tenantId);
  }
  return db
    .prepare(
      `SELECT id, tenant_id, user_id, name, token_prefix, scopes, is_active, last_used_at, created_at
         FROM mcp_tokens WHERE tenant_id = ? AND user_id = ? ORDER BY created_at DESC`,
    )
    .all(tenantId, user.id);
}

/**
 * Revoke a token.
 *
 * The row is kept and switched off rather than deleted, so the audit trail
 * still shows that the credential existed.
 *
 * Who may cut off which credential:
 *
 *   - a platform administrator who named no tenant may cut off any token on
 *     the platform
 *   - an administrator may cut off any token of the tenant the request speaks
 *     for — including their own
 *   - everybody else may cut off their own token and nothing else
 *
 * @param {object} db
 * @param {string} id
 * @param {{scope: {tenantId: string, isSuperadmin: boolean}, userId: string, isAdmin: boolean}} options
 * @returns {Promise<boolean>} whether a row was switched off
 */
async function revokeMcpToken(db, id, options = {}) {
  const { scope, userId, isAdmin } = options;
  if (isAllTenants(scope)) {
    // tenant-lint: allow a platform administrator revokes any tenant's token
    const result = await db.prepare('UPDATE mcp_tokens SET is_active = 0 WHERE id = ?').run(String(id));
    return result.changes > 0;
  }
  if (isAdmin) {
    const result = await db
      .prepare('UPDATE mcp_tokens SET is_active = 0 WHERE id = ? AND tenant_id = ? AND is_active = 1')
      .run(String(id), scope.tenantId);
    return result.changes > 0;
  }
  const result = await db
    .prepare(
      'UPDATE mcp_tokens SET is_active = 0 WHERE id = ? AND tenant_id = ? AND user_id = ? AND is_active = 1',
    )
    .run(String(id), scope.tenantId, userId);
  return result.changes > 0;
}

/**
 * Resolve a presented token into the account it speaks for.
 *
 * @param {object} db
 * @param {string|null|undefined} presented the token the client sent
 * @param {import('express').Request} [req] the request, so `X-Tenant` can
 *   narrow a platform administrator's scope
 * @returns {Promise<{token: object, user: object, tenant: object, scope: object, scopes: string[]}|null>}
 */
async function resolveMcpPrincipal(db, presented, req) {
  if (!presented) return null;

  const row = await db
    .prepare(
      `SELECT id, tenant_id, user_id, name, token_prefix, scopes, is_active, last_used_at, created_at
         FROM mcp_tokens WHERE token_hash = ? AND is_active = 1`,
    )
    .get(sha256(presented));
  if (!row) return null;

  // The account behind the token still has to exist, still has to be active,
  // and still has to belong to the tenant the token was issued in — a token
  // outliving its account is a credential nobody can take back.
  const user = await db
    .prepare('SELECT id, username, role, is_active, tenant_id FROM users WHERE id = ? AND tenant_id = ?')
    .get([row.user_id, row.tenant_id]);
  if (!user || !user.is_active) return null;

  const tenant = await resolveTenantFromUser(db, user);
  if (!tenant) return null;
  // A suspended tenant's tokens stop working, exactly like its sessions do.
  if (tenant.status !== 'active') return null;

  const resolved = await resolveScope(db, user, tenant, req);
  return {
    token: row,
    user,
    tenant: resolved.tenant,
    scope: resolved.scope,
    scopes: scopesForRole(user.role),
  };
}

/**
 * Note that a token was used.
 *
 * @param {object} db
 * @param {string} tokenId
 * @param {string} tenantId
 * @returns {Promise<void>}
 */
async function touchMcpToken(db, tokenId, tenantId) {
  try {
    await db
      .prepare('UPDATE mcp_tokens SET last_used_at = NOW() WHERE id = ? AND tenant_id = ?')
      .run(String(tokenId), tenantId);
  } catch (error) {
    // The bookkeeping update must never fail the call it is bookkeeping for.
    console.warn('[mcp] last_used_at update failed:', error.message);
  }
}

module.exports = {
  MCP_SCOPES,
  ROLE_SCOPES,
  sha256,
  mintToken,
  scopesForRole,
  normalizeScopes,
  issueMcpToken,
  listMcpTokens,
  revokeMcpToken,
  resolveMcpPrincipal,
  touchMcpToken,
};
