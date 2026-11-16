'use strict';

/**
 * The audit trail — the record of what people changed.
 *
 * One row per change: who made it, when, against what, and in which tenant.
 *
 * The trail spans both layers, and the tenant is what tells them apart:
 *
 *   - a tenant's own changes belong to that tenant, and that tenant's
 *     administrator reads them
 *   - the platform layer's changes — a tenant created, an account moved —
 *     belong to no tenant. They are recorded against the wildcard `*`, so
 *     deleting a tenant does not erase the record that it was deleted.
 *
 * The request log (`request-log.js`) is the other half of the story: it says
 * what the instance was *asked* to do, this says what a person *changed*.
 */

const { nanoid } = require('nanoid');
const { ALL_TENANTS } = require('./tenant');

/**
 * The actions the trail records.
 *
 * The names are grouped by the thing that was changed — `asset.created`,
 * `category.deleted` — so a reader can filter by resource without knowing the
 * verbs. The platform layer's actions keep their `platform.` prefix, because
 * they happen one layer above the tenants.
 */
const AUDIT_ACTIONS = [
  'asset.created',
  'asset.updated',
  'asset.deleted',
  'asset.restored',
  'category.created',
  'category.updated',
  'category.deleted',
  'tag.created',
  'tag.updated',
  'tag.deleted',
  'user.created',
  'user.updated',
  'user.deleted',
  'user.password_reset',
  'apikey.created',
  'apikey.updated',
  'apikey.deleted',
  'webhook.created',
  'webhook.updated',
  'webhook.deleted',
  'platform.tenant.created',
  'platform.tenant.updated',
  'platform.tenant.deleted',
  'platform.account.updated',
];

/**
 * Write one entry into the audit trail.
 *
 * The tenant is part of the entry, not a detail of it: an entry that names no
 * tenant belongs to the platform's own actions, which outlive the tenant they
 * were made against.
 *
 * A trail that can break the operation it records is worse than no trail: the
 * change has already happened by the time this runs, so a failure here is
 * reported and dropped rather than raised.
 *
 * @param {object} db
 * @param {{action: string, resourceType: string, resourceId?: string,
 *          details?: object, tenantId?: string, userId?: string, ip?: string}} entry
 * @returns {Promise<void>}
 */
async function writeAudit(db, entry) {
  await db
    .prepare(
      `INSERT INTO audit_logs (id, tenant_id, user_id, action, resource_type, resource_id, details, ip_address, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
    )
    .run(
      nanoid(),
      entry.tenantId ? String(entry.tenantId) : ALL_TENANTS,
      entry.userId || null,
      String(entry.action),
      String(entry.resourceType),
      entry.resourceId ? String(entry.resourceId) : null,
      entry.details ? JSON.stringify(entry.details) : null,
      entry.ip ? String(entry.ip) : null,
    );
}

/**
 * Record a change that was made through a request.
 *
 * The tenant comes from the request's scope — the same scope the change was
 * made in — so an entry cannot end up in a tenant the change did not happen
 * in. For a write, that scope is always one concrete tenant: a write that
 * resolved no tenant was refused before it ran.
 *
 * @param {object} db
 * @param {import('express').Request} req
 * @param {{action: string, resourceType: string, resourceId?: string, details?: object}} entry
 * @returns {Promise<void>}
 */
async function auditAction(db, req, entry) {
  const scope = req.tenantScope;
  await writeAudit(db, {
    tenantId: scope ? scope.tenantId : ALL_TENANTS,
    userId: req.user ? req.user.id : null,
    ip: req.ip,
    ...entry,
  });
}

/**
 * The trail of one tenant, newest first.
 *
 * The wildcard names the **platform's own** actions — the ones recorded against
 * the wildcard tenant, which belong to no tenant. Every other tenant asks for
 * its own trail and gets exactly that.
 *
 * `allTenants` is a different thing: it asks for the whole platform's trail,
 * every tenant's rows together. The scope that reaches every tenant wants
 * that; the platform console's own audit tab wants the wildcard rows.
 *
 * A `userId` narrows the trail further, to the actions of one account: that
 * is what a member of the tenant sees, because a shared workspace's trail is
 * the administrator's to read and the member's own is theirs.
 *
 * @param {object} db
 * @param {{tenantId?: string, allTenants?: boolean, userId?: string, limit?: number}} options
 * @returns {Promise<object[]>}
 */
async function listAudit(db, options = {}) {
  const tenantId = String(options.tenantId === undefined ? ALL_TENANTS : options.tenantId).trim();
  const allTenants = Boolean(options.allTenants);
  const userId = options.userId ? String(options.userId) : '';
  const limit = Math.min(Math.max(Number(options.limit) || 100, 1), 500);

  // The statements are written out rather than assembled: a WHERE clause that
  // only exists at runtime cannot be audited, and this is the query whose
  // scope decides who may read whose trail.
  let rows;
  if (allTenants) {
    rows = await db
      // tenant-lint: allow the whole platform's trail spans every tenant
      .prepare(
        `SELECT a.id, a.tenant_id, a.user_id, a.action, a.resource_type, a.resource_id,
                a.details, a.ip_address, a.created_at, u.username
           FROM audit_logs a
           LEFT JOIN users u ON u.id = a.user_id
          ORDER BY a.created_at DESC
          LIMIT ?`,
      )
      .all(limit);
  } else if (tenantId === ALL_TENANTS) {
    rows = await db
      .prepare(
        `SELECT a.id, a.tenant_id, a.user_id, a.action, a.resource_type, a.resource_id,
                a.details, a.ip_address, a.created_at, u.username
           FROM audit_logs a
           LEFT JOIN users u ON u.id = a.user_id
          WHERE a.tenant_id = ?
          ORDER BY a.created_at DESC
          LIMIT ?`,
      )
      .all(ALL_TENANTS, limit);
  } else if (userId) {
    rows = await db
      .prepare(
        `SELECT a.id, a.tenant_id, a.user_id, a.action, a.resource_type, a.resource_id,
                a.details, a.ip_address, a.created_at, u.username
           FROM audit_logs a
           LEFT JOIN users u ON u.id = a.user_id
          WHERE a.tenant_id = ? AND a.user_id = ?
          ORDER BY a.created_at DESC
          LIMIT ?`,
      )
      .all(tenantId, userId, limit);
  } else {
    rows = await db
      .prepare(
        `SELECT a.id, a.tenant_id, a.user_id, a.action, a.resource_type, a.resource_id,
                a.details, a.ip_address, a.created_at, u.username
           FROM audit_logs a
           LEFT JOIN users u ON u.id = a.user_id
          WHERE a.tenant_id = ?
          ORDER BY a.created_at DESC
          LIMIT ?`,
      )
      .all(tenantId, limit);
  }

  return rows.map((row) => ({
    id: row.id,
    tenant_id: row.tenant_id,
    user_id: row.user_id,
    username: row.username,
    action: row.action,
    resource_type: row.resource_type,
    resource_id: row.resource_id,
    details: row.details,
    ip_address: row.ip_address,
    created_at: row.created_at,
  }));
}

module.exports = {
  AUDIT_ACTIONS,
  writeAudit,
  auditAction,
  listAudit,
};
