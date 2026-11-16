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

      // The platform administrator has its own door — the tenant door refuses
      // a platform administrator outright, so this is the way in.
      const login = await ctx.authApi.platformLogin(SUPERADMIN_USERNAME, SUPERADMIN_PASSWORD);
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
  {
    name: 'the platform administrator manages the tenants through the same module',
    async run(ctx) {
      const login = await ctx.authApi.platformLogin(SUPERADMIN_USERNAME, SUPERADMIN_PASSWORD);
      ctx.client.setToken(login.access_token);
      ctx.client.setRefreshToken(login.refresh_token);

      // The page's own API: create, rename, remove.
      const created = await ctx.tenantsApi.create({ name: 'Contract Managed', slug: 'contract-managed' });
      assert.equal(created.slug, 'contract-managed', 'the created tenant must carry its slug');
      assert.equal(created.asset_count, 0, 'a new tenant holds nothing yet');

      const renamed = await ctx.tenantsApi.update(created.id, { name: 'Contract Renamed' });
      assert.equal(renamed.name, 'Contract Renamed', 'the rename must land');

      // The counts the operator reads before they suspend or remove a tenant.
      // A new tenant holds nothing, so the numbers have to come from a tenant
      // that *does* hold something — otherwise the check passes on a count
      // that never counted anything.
      await queryTestDb(
        ctx.dbName,
        'INSERT INTO users (id, tenant_id, username, email, password_hash, role) VALUES (?, ?, ?, ?, ?, ?)',
        [
          'contract-count-user',
          created.id,
          'contract-count',
          'count@contract.test',
          bcrypt.hashSync('Count@789', 10),
          'viewer',
        ],
      );
      const counted = (await ctx.tenantsApi.list()).items.find(
        (tenant) => tenant.id === created.id,
      );
      assert.ok(counted, 'the registry must list the tenant that holds the account');
      assert.equal(counted.user_count, 1, 'the registry must count the account the tenant holds');
      assert.equal(counted.asset_count, 0, 'the registry must count the assets the tenant holds');

      const registry = await ctx.tenantsApi.list();
      assert.ok(
        registry.items.some((tenant) => tenant.id === created.id),
        'the registry must list the tenant that was just created',
      );

      await ctx.tenantsApi.remove(created.id);
      const after = await ctx.tenantsApi.list();
      assert.ok(
        !after.items.some((tenant) => tenant.id === created.id),
        'the removed tenant must be gone from the registry',
      );

      // The rest of the suite runs as the seeded administrator.
      const back = await ctx.authApi.login(ADMIN_USERNAME, ADMIN_PASSWORD);
      ctx.client.setToken(back.access_token);
      ctx.client.setRefreshToken(back.refresh_token);
    },
  },

  {
    name: 'the tenant door and the platform door are two doors',
    async run(ctx) {
      // The directory the login page offers is public: the page has to name a
      // tenant *before* there is a session.
      const directory = await ctx.authApi.tenants();
      assert.ok(Array.isArray(directory.items), 'the tenant directory must answer with an items array');

      const rows = await queryTestDb(
        ctx.dbName,
        'SELECT tenant_id FROM users WHERE username = ?',
        [ADMIN_USERNAME],
      );
      const adminTenant = rows[0].tenant_id;
      assert.ok(
        directory.items.some((tenant) => tenant.id === adminTenant),
        'the directory must list the tenant the seeded administrator belongs to',
      );
      assert.ok(
        directory.items.every(
          (tenant) => !('asset_count' in tenant) && !('user_count' in tenant),
        ),
        'the public directory must not say what a tenant holds',
      );

      // The tenant door: the account names the tenant it signs into.
      const tenantLogin = await ctx.authApi.login(ADMIN_USERNAME, ADMIN_PASSWORD, adminTenant);
      assert.ok(tenantLogin.access_token, 'the tenant door must answer with a session');
      assert.equal(
        tenantLogin.user.tenant_id,
        adminTenant,
        'the session must belong to the tenant the door named',
      );

      // The platform door is one layer up: a tenant administrator is refused.
      let status = 0;
      try {
        await ctx.authApi.platformLogin(ADMIN_USERNAME, ADMIN_PASSWORD);
        status = 200;
      } catch (error) {
        status = error?.response?.status ?? 0;
      }
      assert.equal(status, 403, 'a tenant administrator must not be able to use the platform door');

      // And the tenant door does not take a platform administrator either:
      // a session that says "tenant" while the account may read every tenant
      // is a session that lies.
      let tenantDoorStatus = 0;
      try {
        await ctx.authApi.login(SUPERADMIN_USERNAME, SUPERADMIN_PASSWORD);
        tenantDoorStatus = 200;
      } catch (error) {
        tenantDoorStatus = error?.response?.status ?? 0;
      }
      assert.equal(
        tenantDoorStatus,
        403,
        'the tenant door must not sign a platform administrator in',
      );

      // A platform administrator comes through it.
      const platformLogin = await ctx.authApi.platformLogin(SUPERADMIN_USERNAME, SUPERADMIN_PASSWORD);
      assert.ok(platformLogin.access_token, 'the platform door must answer with a session');
      assert.equal(
        platformLogin.user.role,
        'superadmin',
        'the platform door must sign a platform administrator in',
      );

      // The rest of the suite runs as the seeded administrator.
      const back = await ctx.authApi.login(ADMIN_USERNAME, ADMIN_PASSWORD);
      ctx.client.setToken(back.access_token);
      ctx.client.setRefreshToken(back.refresh_token);
    },
  },

  {
    name: 'an account issues an MCP token and the token speaks to the endpoint',
    async run(ctx) {
      const issued = await ctx.mcpApi.create({ name: 'Contract MCP' });
      assert.ok(issued.token, 'the issued token must be shown once');
      assert.ok(
        issued.scopes.includes('read'),
        'an administrator\'s token must carry the read scope',
      );

      // The token is what an MCP client carries: it speaks JSON-RPC over the
      // Streamable HTTP transport, and the answer arrives as an event stream.
      const response = await fetch(`${ctx.origin}/mcp`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: `Bearer ${issued.token}`,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/list',
          params: {},
        }),
      });
      assert.equal(response.status, 200, 'the MCP endpoint must answer the token');
      const frames = (await response.text())
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim());
      assert.ok(frames.length > 0, 'the MCP endpoint must answer with a frame');
      const frame = JSON.parse(frames[frames.length - 1]);
      const names = frame.result.tools.map((tool) => tool.name);
      assert.ok(names.includes('list_assets'), 'the token must be offered the asset list');
      assert.ok(names.includes('delete_asset'), 'an administrator\'s token must be offered the deletes');

      // A revoked token is a dead token.
      await ctx.mcpApi.remove(issued.id);
      const afterRevoke = await fetch(`${ctx.origin}/mcp`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: `Bearer ${issued.token}`,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/list',
          params: {},
        }),
      });
      assert.equal(afterRevoke.status, 401, 'a revoked token must stop working');
    },
  },
];
