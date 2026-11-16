'use strict';

/**
 * The platform layer.
 *
 * Everything in here is deliberately **cross-tenant**: it counts the platform,
 * lists the platform's accounts, and records what the platform layer did. The
 * platform administrator is the one who sees all of it at once — that is what
 * a layer above the tenants is *for*.
 *
 * The reads here cross a tenant boundary on purpose, and each query says so
 * where it is written: the tenant lint asks for a reason next to every query
 * that is not narrowed to a tenant, and this layer is the reason.
 */

const { nanoid } = require('nanoid');
const { ALL_TENANTS, SUPERADMIN_ROLE, loadTenant } = require('./tenant');
const { writeAudit: writeSharedAudit, listAudit: listSharedAudit } = require('./audit');

/** The roles an account may hold inside one tenant. */
const TENANT_ROLES = ['admin', 'editor', 'viewer'];

/** Every role an account may hold on the platform. */
const PLATFORM_ROLES = [...TENANT_ROLES, SUPERADMIN_ROLE];

/**
 * What the platform holds.
 *
 * One query, so the numbers come from the same instant — a platform that
 * counts its tenants and its assets separately can show two truths.
 *
 * @param {object} db
 * @returns {Promise<object>} the platform's totals
 */
async function platformStats(db) {
  // tenant-lint: allow the platform overview counts the platform, not one tenant
  const totals = await db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM tenants) AS tenants,
         (SELECT COUNT(*) FROM tenants WHERE status = 'active') AS active_tenants,
         (SELECT COUNT(*) FROM users) AS accounts,
         (SELECT COUNT(*) FROM users WHERE role = 'superadmin') AS platform_administrators,
         (SELECT COUNT(*) FROM assets WHERE status != 'deleted') AS assets,
         (SELECT COUNT(*) FROM assets WHERE status = 'deleted') AS trashed_assets,
         (SELECT COALESCE(SUM(file_size), 0) FROM assets WHERE status != 'deleted') AS storage_bytes,
         (SELECT COUNT(*) FROM categories) AS categories,
         (SELECT COUNT(*) FROM tags) AS tags,
         (SELECT COUNT(*) FROM request_logs WHERE created_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)) AS requests_24h,
         (SELECT COALESCE(SUM(bytes_in), 0) FROM request_logs WHERE created_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)) AS bytes_in_24h,
         (SELECT COALESCE(SUM(bytes_out), 0) FROM request_logs WHERE created_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)) AS bytes_out_24h,
         (SELECT COUNT(*) FROM request_logs WHERE created_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR) AND status >= 400) AS errors_24h`,
    )
    .get();

  return {
    tenants: Number(totals.tenants),
    active_tenants: Number(totals.active_tenants),
    accounts: Number(totals.accounts),
    platform_administrators: Number(totals.platform_administrators),
    assets: Number(totals.assets),
    trashed_assets: Number(totals.trashed_assets),
    storage_bytes: Number(totals.storage_bytes),
    categories: Number(totals.categories),
    tags: Number(totals.tags),
    requests_24h: Number(totals.requests_24h),
    bytes_in_24h: Number(totals.bytes_in_24h),
    bytes_out_24h: Number(totals.bytes_out_24h),
    errors_24h: Number(totals.errors_24h),
  };
}

/**
 * The platform's account directory.
 *
 * Every account on the platform, whichever tenant it belongs to — the
 * platform administrator has to be able to see who holds an account before it
 * decides what that account may do.
 *
 * @param {object} db
 * @param {{keyword?: string, role?: string, status?: string, limit?: number, offset?: number}} options
 * @returns {Promise<{items: object[], total: number}>}
 */
async function listAccounts(db, options = {}) {
  const keyword = String(options.keyword || '').trim();
  const role = String(options.role || '').trim();
  const status = String(options.status || '').trim();
  const limit = Math.min(Math.max(Number(options.limit) || 50, 1), 200);
  const offset = Math.max(Number(options.offset) || 0, 0);

  const like = `%${keyword}%`;
  const roleValue = PLATFORM_ROLES.includes(role) ? role : '';
  const activeValue = status === 'active' ? 1 : status === 'disabled' ? 0 : -1;

  // tenant-lint: allow the account directory lists every tenant's accounts
  const rows = await db
    .prepare(
      `SELECT id, username, email, display_name, role, is_active, tenant_id,
              last_login_at, created_at
         FROM users
        WHERE (? = '' OR username LIKE ? OR email LIKE ? OR display_name LIKE ?)
          AND (? = '' OR role = ?)
          AND (? = -1 OR is_active = ?)
        ORDER BY created_at DESC
        LIMIT ? OFFSET ?`,
    )
    .all(
      keyword,
      like,
      like,
      like,
      roleValue,
      roleValue,
      activeValue,
      activeValue,
      limit,
      offset,
    );

  // tenant-lint: allow the account directory counts every tenant's accounts
  const counted = await db
    .prepare(
      `SELECT COUNT(*) AS c
         FROM users
        WHERE (? = '' OR username LIKE ? OR email LIKE ? OR display_name LIKE ?)
          AND (? = '' OR role = ?)
          AND (? = -1 OR is_active = ?)`,
    )
    .get(
      keyword,
      like,
      like,
      like,
      roleValue,
      roleValue,
      activeValue,
      activeValue,
    );

  return {
    items: rows.map((row) => ({
      id: row.id,
      username: row.username,
      email: row.email,
      display_name: row.display_name,
      role: row.role,
      status: row.is_active ? 'active' : 'disabled',
      tenant_id: row.tenant_id,
      last_login_at: row.last_login_at,
      created_at: row.created_at,
    })),
    total: Number(counted.c),
  };
}

/**
 * Move an account to another role, another tenant, or both.
 *
 * A platform administrator belongs to no tenant: promoting an account moves
 * it to the wildcard tenant, where the platform keeps the accounts that are
 * not anybody's. Demoting it puts it back into a named tenant — the caller
 * says which one, because the platform does not remember where it came from.
 *
 * @param {object} db
 * @param {string} userId
 * @param {{role?: string, tenant_id?: string, status?: string}} change
 * @returns {Promise<object>} the account as it now is
 * @throws {Error & {status: number, code: string}} 400 when the change makes no sense
 */
async function updateAccount(db, userId, change = {}) {
  // The account is found by its id alone: the platform layer reaches accounts
  // of every tenant, so the tenant is not part of the lookup.
  // tenant-lint: allow the platform layer reaches accounts of every tenant
  const row = await db
    .prepare('SELECT * FROM users WHERE id = ?')
    .get(String(userId));
  if (!row) {
    throw Object.assign(new Error('No such account'), { status: 404, code: 'NO_SUCH_USER' });
  }

  const role = change.role === undefined ? row.role : String(change.role);
  if (!PLATFORM_ROLES.includes(role)) {
    throw Object.assign(
      new Error(`Unknown role '${role}'`),
      { status: 400, code: 'BAD_ROLE' },
    );
  }

  // The wildcard tenant is not a tenant a write may land in — so a platform
  // administrator always sits there, and everybody else sits in a real one.
  let tenantId = row.tenant_id;
  if (change.tenant_id !== undefined) tenantId = String(change.tenant_id);
  if (role === SUPERADMIN_ROLE) {
    tenantId = ALL_TENANTS;
  } else {
    if (!tenantId || tenantId === ALL_TENANTS) {
      throw Object.assign(
        new Error('An account that is not a platform administrator needs a tenant'),
        { status: 400, code: 'TENANT_REQUIRED' },
      );
    }
    const tenant = await loadTenant(db, tenantId);
    if (!tenant) {
      throw Object.assign(
        new Error(`There is no tenant '${tenantId}'`),
        { status: 400, code: 'NO_SUCH_TENANT' },
      );
    }
  }

  const isActive = change.status === undefined
    ? row.is_active
    : change.status === 'active' ? 1 : 0;

  await db
    .prepare('UPDATE users SET role = ?, tenant_id = ?, is_active = ? WHERE id = ?')
    .run(role, tenantId, isActive, row.id);

  return {
    id: row.id,
    username: row.username,
    email: row.email,
    display_name: row.display_name,
    role,
    status: isActive ? 'active' : 'disabled',
    tenant_id: tenantId,
    last_login_at: row.last_login_at,
    created_at: row.created_at,
  };
}

/**
 * Write one entry into the audit log.
 *
 * The platform's own actions are recorded against the wildcard tenant — they
 * belong to no single tenant, and deleting a tenant must not erase the record
 * that it was deleted.
 *
 * @param {object} db
 * @param {{action: string, resourceType: string, resourceId?: string, details?: object, userId?: string, ip?: string}} entry
 * @returns {Promise<void>}
 */
async function writeAudit(db, entry) {
  await writeSharedAudit(db, { tenantId: ALL_TENANTS, ...entry });
}

/**
 * The platform's recent actions.
 *
 * @param {{limit?: number}} options
 * @returns {Promise<object[]>}
 */
async function listAudit(db, options = {}) {
  return listSharedAudit(db, { tenantId: ALL_TENANTS, ...options });
}

module.exports = {
  TENANT_ROLES,
  PLATFORM_ROLES,
  platformStats,
  listAccounts,
  updateAccount,
  writeAudit,
  listAudit,
};
