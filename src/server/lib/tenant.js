'use strict';

/**
 * Tenant context resolution.
 *
 * A request's tenant comes from the credential, never from the request body:
 * an API key belongs to exactly one tenant, and a management token carries
 * the tenant it was issued for.
 *
 * This module is the only place that knows how a tenant is looked up and how
 * a principal's scope is expressed. The auth middleware resolves the tenant
 * and hangs it on `req.tenant`; the business handlers read the scope from
 * `req.tenantScope` and never guess it.
 */

/** The role that may act across every tenant. */
const SUPERADMIN_ROLE = 'superadmin';

/** The tenant id that stands for "every tenant". */
const ALL_TENANTS = '*';

/** The name shown for the wildcard tenant. */
const ALL_TENANTS_NAME = '全部租户';

/**
 * Load a tenant by its id.
 *
 * The wildcard is not a tenant row — it is a scope, not a tenant — so it
 * resolves to nothing here.
 *
 * @param {object} db
 * @param {string} tenantId
 * @returns {Promise<{id: string, slug: string, name: string, status: string} | null>}
 */
async function loadTenant(db, tenantId) {
  if (!tenantId || tenantId === ALL_TENANTS) return null;
  const row = await db
    .prepare('SELECT id, slug, name, status FROM tenants WHERE id = ?')
    .get([tenantId]);
  if (!row) return null;
  return { id: row.id, slug: row.slug, name: row.name, status: row.status };
}

/**
 * The tenant a user belongs to.
 *
 * A platform administrator belongs to no single tenant: their token carries
 * the wildcard tenant, and their scope covers every tenant. Everybody else
 * belongs to the tenant their own row points at — and to nothing else, so a
 * user whose tenant no longer exists resolves to no tenant at all rather
 * than to a neighbour's.
 *
 * @param {object} db
 * @param {{id: string, role: string, tenant_id: string} | null} user
 * @returns {Promise<{id: string, slug: string, name: string, status: string} | null>}
 */
async function resolveTenantFromUser(db, user) {
  if (!user) return null;
  if (user.role === SUPERADMIN_ROLE) {
    return {
      id: ALL_TENANTS,
      slug: ALL_TENANTS,
      name: ALL_TENANTS_NAME,
      status: 'active',
    };
  }
  return loadTenant(db, user.tenant_id);
}

/**
 * Whether a scope covers every tenant.
 *
 * @param {{tenantId: string}|null|undefined} scope
 * @returns {boolean}
 */
function isAllTenants(scope) {
  return Boolean(scope) && scope.tenantId === ALL_TENANTS;
}

/**
 * The tenant condition for a query.
 *
 * Returns the clause fragment *and* its parameter, so a caller cannot add
 * one without the other. A platform administrator's scope covers every
 * tenant, so the fragment is empty — their reads are unfiltered by design.
 *
 * @param {{tenantId: string, isSuperadmin: boolean}} scope
 * @param {string} [column] the qualified column, e.g. `a.tenant_id`
 * @returns {{sql: string, params: unknown[]}}
 */
function tenantClause(scope, column = 'tenant_id') {
  if (!scope) {
    throw Object.assign(new Error('A query cannot run without a tenant scope'), {
      status: 403,
      code: 'NO_TENANT_SCOPE',
    });
  }
  if (isAllTenants(scope)) return { sql: '', params: [] };
  return { sql: `${column} = ?`, params: [scope.tenantId] };
}

/**
 * The tenant a write lands in.
 *
 * A platform administrator's scope covers every tenant, so it names none —
 * and a row that names the wildcard belongs to nobody. No tenant admin can
 * read it, and an account created against it cannot authenticate: there is
 * no tenant row for the wildcard to resolve to, so `loadTenant` answers
 * nothing and every request the new account makes is refused with "Tenant
 * not found".
 *
 * So a write has to name a concrete tenant. Everybody else gets it from
 * their credential; a platform administrator names it in the `X-Tenant`
 * header. The header is ignored for a caller who already has a tenant — it
 * is not a way out of one.
 *
 * @param {{tenantId: string, isSuperadmin: boolean}} scope
 * @param {import('express').Request} req
 * @returns {string} the tenant the row belongs to
 * @throws {Error & {status: number}} 400 when no concrete tenant is named
 */
function writeTenantId(scope, req) {
  if (!scope) {
    throw Object.assign(new Error('A write cannot run without a tenant scope'), {
      status: 403,
      code: 'NO_TENANT_SCOPE',
    });
  }
  if (!isAllTenants(scope)) return scope.tenantId;
  const named = String((req.headers && req.headers['x-tenant']) || '').trim();
  if (!named) {
    throw Object.assign(
      new Error('A platform administrator must name the tenant to write into (X-Tenant)'),
      { status: 400, code: 'TENANT_REQUIRED' },
    );
  }
  return named;
}

/**
 * The tenant a write lands in, checked against the tenants that exist.
 *
 * A name that does not resolve to a tenant row would produce the same
 * orphan a wildcard produces, so it is refused here rather than at the
 * first read of the row.
 *
 * @param {object} db
 * @param {{tenantId: string, isSuperadmin: boolean}} scope
 * @param {import('express').Request} req
 * @returns {Promise<string>} the tenant id
 * @throws {Error & {status: number}} 400 when the tenant does not exist
 */
async function resolveWriteTenant(db, scope, req) {
  const tenantId = writeTenantId(scope, req);
  const tenant = await loadTenant(db, tenantId);
  if (!tenant) {
    throw Object.assign(new Error(`There is no tenant '${tenantId}'`), {
      status: 400,
      code: 'NO_SUCH_TENANT',
    });
  }
  return tenant.id;
}

/**
 * The scope a request runs in.
 *
 * `isSuperadmin` is the flag the business layer reads: a superadmin's reads
 * are not filtered, their writes still name the tenant they write into.
 *
 * @param {{id: string, role: string} | null} user
 * @param {{id: string} | null} tenant
 * @returns {{tenantId: string, isSuperadmin: boolean} | null}
 */
function tenantScope(user, tenant) {
  if (!user) return null;
  if (user.role === SUPERADMIN_ROLE) {
    return { tenantId: ALL_TENANTS, isSuperadmin: true };
  }
  if (!tenant) return null;
  return { tenantId: tenant.id, isSuperadmin: false };
}

module.exports = {
  SUPERADMIN_ROLE,
  ALL_TENANTS,
  ALL_TENANTS_NAME,
  isAllTenants,
  tenantClause,
  loadTenant,
  resolveTenantFromUser,
  resolveWriteTenant,
  tenantScope,
  writeTenantId,
};
