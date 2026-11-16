/**
 * Runtime contract checks — the tenant context.
 *
 * Part of the front↔back guard's runtime half; `tests/lib/runtime-checks.js`
 * owns the runner and the ordering rules.
 *
 * These checks cover the platform administrator's path end to end, through
 * the frontend's own modules: the tenant registry, and the `X-Tenant` header
 * the picker puts on every request.
 *
 * The role and the tenant are rows in the throw-away schema — there is no
 * API that hands the platform administrator role out, on purpose: a role
 * that can read every tenant is a security boundary, and an endpoint that
 * grants it is a privilege escalation. So the check writes the rows itself.
 */

import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import { queryTestDb } from './runtime.js';
import { ADMIN_PASSWORD, ADMIN_USERNAME } from './runtime-checks-identity.js';

/** The platform administrator the check signs in as. */
const SUPERADMIN_USERNAME = 'contract-root';
const SUPERADMIN_PASSWORD = 'Contract@789';

/** The tenant the check makes the administrator act in. */
const TENANT_ID = 'contract-acme';
const TENANT_NAME = 'Contract Tenant';

/**
 * @typedef {import('./runtime-checks.js').RuntimeCheck} RuntimeCheck
 */

/** @type {RuntimeCheck[]} */
export const tenantChecks = [
  {
    name: 'the tenant registry is closed to a tenant administrator',
    async run(ctx) {
      // The seeded administrator belongs to one tenant and must not learn the
      // names of the others.
      let status = 0;
      try {
        await ctx.tenantsApi.list();
        status = 200;
      } catch (error) {
        status = error?.response?.status ?? 0;
      }
      assert.equal(status, 403, 'a tenant administrator must not be able to read the registry');
    },
  },

  {
    name: 'a platform administrator picks a tenant and every request follows it',
    async run(ctx) {
      await queryTestDb(
        ctx.dbName,
        'INSERT INTO tenants (id, name, slug, status) VALUES (?, ?, ?, ?)',
        [TENANT_ID, TENANT_NAME, 'contract-acme', 'active'],
      );
      await queryTestDb(
        ctx.dbName,
        'INSERT INTO users (id, tenant_id, username, email, password_hash, role) VALUES (?, ?, ?, ?, ?, ?)',
        [
          'contract-root',
          '*',
          SUPERADMIN_USERNAME,
          'root@contract.test',
          bcrypt.hashSync(SUPERADMIN_PASSWORD, 10),
          'superadmin',
        ],
      );

      const login = await ctx.authApi.login(SUPERADMIN_USERNAME, SUPERADMIN_PASSWORD);
      assert.equal(login.user.role, 'superadmin', 'the platform administrator must be able to sign in');
      ctx.client.setToken(login.access_token);
      ctx.client.setRefreshToken(login.refresh_token);

      // The registry the picker reads.
      const registry = await ctx.tenantsApi.list();
      assert.ok(Array.isArray(registry.items), 'the registry must answer with an items array');
      assert.ok(
        registry.items.some((tenant) => tenant.id === TENANT_ID && tenant.name === TENANT_NAME),
        'the registry must list the tenant the request may name',
      );

      // The tenant is picked through the store — the same piece the UI uses.
      ctx.tenantStore.getState().setTenantId(TENANT_ID);

      // The write lands in the tenant that was picked …
      const created = await ctx.categoriesApi.create({ name: 'contract-acme-category' });
      const rows = await queryTestDb(
        ctx.dbName,
        'SELECT tenant_id FROM categories WHERE id = ?',
        [created.id],
      );
      assert.equal(rows[0].tenant_id, TENANT_ID, 'the write must land in the tenant that was picked');

      // … and the read answers with that tenant alone.
      const scoped = await ctx.client.apiGet('/categories');
      assert.ok(Array.isArray(scoped), '/categories must answer with an array');
      assert.ok(
        scoped.every((category) => category.name === 'contract-acme-category'),
        'a narrowed read must show the picked tenant and nothing else',
      );

      // Dropping the selection widens the read again — and the header is
      // gone with it.
      ctx.tenantStore.getState().setTenantId(null);
      const wide = await ctx.client.apiGet('/categories');
      assert.ok(
        wide.length > scoped.length,
        'dropping the tenant selection must widen the read again',
      );

      // The rest of the suite runs as the seeded administrator, so the
      // session is handed back before this check is done.
      const back = await ctx.authApi.login(ADMIN_USERNAME, ADMIN_PASSWORD);
      ctx.client.setToken(back.access_token);
      ctx.client.setRefreshToken(back.refresh_token);
    },
  },
];
