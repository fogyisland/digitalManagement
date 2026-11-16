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
 * The tenant a request names in its `X-Tenant` header.
 *
 * @param {import('express').Request} req
 * @returns {string} the reference, or '' when the header is absent
 */
function tenantHeader(req) {
  const raw = req && req.headers ? req.headers['x-tenant'] : '';
  return String(raw || '').trim();
}

/**
 * Resolve a tenant reference to the tenant it names.
 *
 * A reference matches by id, by slug or by name — the three things a caller
 * can reasonably hold. A platform administrator works in the UI, where a
 * tenant is a name, and typing a nanoid would be a chore; an API caller knows
 * the id. The id wins over the slug, and the slug over the name, so a
 * reference that happens to be both a name and an id always means the same
 * tenant.
 *
 * The reference travels in an HTTP header, and a header value has to be a
 * byte string: a tenant whose name is not ASCII cannot be named that way at
 * all — the request is refused before it reaches the server. The id is
 * always ASCII, which is why the UI sends the id and the name is only a
 * convenience for the ASCII ones.
 *
 * @param {object} db
 * @param {string} ref
 * @returns {Promise<{id: string, slug: string, name: string, status: string} | null>}
 */
async function resolveTenantRef(db, ref) {
  const value = String(ref || '').trim();
  if (!value) return null;
  const row = await db
    .prepare(
      `SELECT id, slug, name, status
         FROM tenants
        WHERE id = ? OR slug = ? OR name = ?
        ORDER BY CASE WHEN id = ? THEN 0 WHEN slug = ? THEN 1 ELSE 2 END
        LIMIT 1`,
    )
    .get(value, value, value, value, value);
  if (!row) return null;
  return { id: row.id, slug: row.slug, name: row.name, status: row.status };
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
 * one without the other. A scope that covers every tenant produces an empty
 * fragment — those reads are unfiltered by design. A platform administrator
 * who named a tenant in `X-Tenant` has a scope that covers one tenant, so
 * theirs is filtered like anybody else's.
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
 * header, and the header narrows their scope to that tenant before the
 * handler runs (`resolveScope`). The header is ignored for a caller who
 * already has a tenant — it is not a way out of one.
 *
 * @param {{tenantId: string, isSuperadmin: boolean}} scope
 * @returns {string} the tenant the row belongs to
 * @throws {Error & {status: number}} 400 when no concrete tenant is named
 */
function writeTenantId(scope) {
  if (!scope) {
    throw Object.assign(new Error('A write cannot run without a tenant scope'), {
      status: 403,
      code: 'NO_TENANT_SCOPE',
    });
  }
  if (!isAllTenants(scope)) return scope.tenantId;
  throw Object.assign(
    new Error('A platform administrator must name the tenant to write into (X-Tenant)'),
    { status: 400, code: 'TENANT_REQUIRED' },
  );
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
 * @returns {Promise<string>} the tenant id
 * @throws {Error & {status: number}} 400 when the tenant does not exist
 */
async function resolveWriteTenant(db, scope) {
  const tenantId = writeTenantId(scope);
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
 * The scope a request runs in, once the `X-Tenant` header has been applied.
 *
 * A platform administrator's scope covers every tenant — unless the request
 * names one, in which case the scope narrows to it. The narrowing is the
 * whole point of the header: it turns "every tenant" into "this tenant", for
 * reads as well as writes, so one header means one thing. Without it a
 * platform administrator's reads span the whole platform while their writes
 * have nowhere to land, and every update they try answers 404.
 *
 * The header is ignored for a caller who already has a tenant. It is not a
 * way out of one.
 *
 * @param {object} db
 * @param {{id: string, role: string}} user
 * @param {{id: string, slug: string, name: string, status: string}|null} tenant
 * @param {import('express').Request} req
 * @returns {Promise<{scope: {tenantId: string, isSuperadmin: boolean}|null, tenant: object|null}>}
 * @throws {Error & {status: number}} 400 when the named tenant does not exist
 */
async function resolveScope(db, user, tenant, req) {
  const base = tenantScope(user, tenant);
  if (!base) return { scope: null, tenant };
  if (!isAllTenants(base)) return { scope: base, tenant };

  const named = tenantHeader(req);
  if (!named) return { scope: base, tenant };

  const target = await resolveTenantRef(db, named);
  if (!target) {
    throw Object.assign(new Error(`There is no tenant '${named}'`), {
      status: 400,
      code: 'NO_SUCH_TENANT',
    });
  }
  if (target.status !== 'active') {
    throw Object.assign(new Error(`The tenant '${target.name}' is suspended`), {
      status: 403,
      code: 'TENANT_SUSPENDED',
    });
  }
  // The narrowed scope is an ordinary one-tenant scope: `isSuperadmin` says
  // how far the request reaches, and it no longer reaches past this tenant.
  // Who the caller *is* is `req.user.role` — the role gates read that.
  return { scope: { tenantId: target.id, isSuperadmin: false }, tenant: target };
}

/**
 * The scope a request runs in.
 *
 * The scope says how far a request reaches, not who the caller is:
 *
 *   - `tenantId` — the tenant the request speaks for; `ALL_TENANTS` means
 *     every tenant.
 *   - `isSuperadmin` — whether the scope reaches every tenant. It says the
 *     same thing as `isAllTenants(scope)`, and is kept as a field so a
 *     handler can read it without a helper call.
 *
 * A platform administrator whose request names a tenant gets a scope
 * narrowed to it (`resolveScope`), and then `isSuperadmin` is false — the
 * request no longer reaches past that tenant.
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
  resolveTenantRef,
  resolveScope,
  resolveTenantFromUser,
  resolveWriteTenant,
  tenantScope,
  tenantHeader,
  writeTenantId,
};
