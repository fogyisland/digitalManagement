/**
 * Runtime contract checks — identity and catalogue.
 *
 * Part of the front↔back guard's runtime half; `tests/lib/runtime-checks.js`
 * owns the runner and the ordering rules.
 *
 * These checks cover the session entry points and the catalogue endpoints:
 * login, the bearer token, the canonical list envelope, and the create /
 * update / delete cycle of users, tags and categories.
 *
 * Negative cases go through `rawRequest` rather than the axios instance: a
 * rejected axios call triggers the client's 401 handler, which clears the
 * stored tokens and would break every check after it.
 */

import assert from 'node:assert/strict';
import { rawRequest } from './runtime.js';

/** The account the backend seeds on first boot. */
const ADMIN_USERNAME = 'admin';
const ADMIN_PASSWORD = 'Admin@123456';

/**
 * @typedef {import('./runtime-checks.js').RuntimeCheck} RuntimeCheck
 */

/** @type {RuntimeCheck[]} */
export const identityChecks = [
  {
    name: 'login issues a token pair and echoes the profile',
    async run(ctx) {
      const login = await ctx.authApi.login(ADMIN_USERNAME, ADMIN_PASSWORD);
      assert.ok(typeof login.access_token === 'string' && login.access_token.length > 0,
        'login must return an access token');
      assert.ok(typeof login.refresh_token === 'string' && login.refresh_token.length > 0,
        'login must return a refresh token');
      assert.equal(login.token_type, 'bearer');
      assert.equal(login.user.username, ADMIN_USERNAME);
      assert.equal(login.user.role, 'admin');
      ctx.client.setToken(login.access_token);
      ctx.client.setRefreshToken(login.refresh_token);
      ctx.state.login = login;
    },
  },

  {
    name: 'GET /auth/me sees the bearer token',
    async run(ctx) {
      const me = await ctx.client.apiGet('/auth/me');
      assert.equal(me.username, ADMIN_USERNAME);
      assert.equal(me.role, 'admin');
      assert.equal(me.status, 'active');
      assert.equal(me.is_superuser, true);
    },
  },

  {
    name: 'a wrong password is rejected with 401',
    async run(ctx) {
      const result = await rawRequest(ctx.origin, 'POST', '/api/v1/auth/login', {
        body: { username: ADMIN_USERNAME, password: 'definitely-not-the-password' },
      });
      assert.equal(result.status, 401);
      assert.equal(result.body.detail, 'Invalid credentials');
    },
  },

  {
    name: 'every list endpoint answers the canonical envelope',
    async run(ctx) {
      const assets = await ctx.client.apiGet('/assets');
      assert.ok(Array.isArray(assets.items), '/assets must return an items array');
      assert.equal(typeof assets.total, 'number');
      assert.equal(typeof assets.page, 'number');
      assert.equal(typeof assets.page_size, 'number');
      assert.equal(typeof assets.total_pages, 'number');

      assert.ok(Array.isArray(await ctx.client.apiGet('/categories')));
      assert.ok(Array.isArray(await ctx.client.apiGet('/tags')));
      assert.ok(Array.isArray(await ctx.client.apiGet('/api-keys')));
      assert.ok(Array.isArray(await ctx.client.apiGet('/webhooks')));

      const users = await ctx.client.apiGet('/users');
      assert.ok(Array.isArray(users.items), '/users must return an items array');
      assert.equal(users.items.some((user) => user.username === ADMIN_USERNAME), true);

      const stats = await ctx.client.apiGet('/stats');
      assert.equal(typeof stats.total, 'number');
      assert.equal(typeof stats.total_size, 'number');
      assert.ok(Array.isArray(stats.recent));

      const dashboard = await ctx.client.apiGet('/stats/dashboard');
      assert.equal(typeof dashboard.summary.total_assets, 'number');
      assert.ok(Array.isArray(dashboard.upload_trend));
      assert.ok(Array.isArray(dashboard.recent_assets));
    },
  },

  {
    name: 'the user endpoints create, update, reset the password and delete',
    async run(ctx) {
      const username = 'contract-user';
      const created = await ctx.usersApi.create({
        username,
        password: 'Contract@123',
        email: 'contract@example.test',
        display_name: 'Contract User',
        role: 'editor',
      });
      assert.equal(created.username, username);
      assert.equal(created.role, 'editor');
      assert.equal(created.status, 'active');
      assert.equal(created.is_superuser, false);

      const page = await ctx.usersApi.list({ keyword: username });
      assert.equal(page.items.length, 1, 'the keyword filter must find exactly one user');
      assert.equal(page.items[0].id, created.id);

      const updated = await ctx.usersApi.update(created.id, { display_name: 'Renamed Contract User' });
      assert.equal(updated.display_name, 'Renamed Contract User');
      assert.equal(updated.role, 'editor', 'an update must not change the role implicitly');

      await ctx.usersApi.resetPassword(created.id, 'Contract@456');
      const relogin = await rawRequest(ctx.origin, 'POST', '/api/v1/auth/login', {
        body: { username, password: 'Contract@456' },
      });
      assert.equal(relogin.status, 200, 'the reset password must be the one that logs in');
      assert.equal(relogin.body.user.id, created.id);

      await ctx.usersApi.remove(created.id);
      const after = await ctx.usersApi.list({ keyword: username });
      assert.equal(after.items.length, 0, 'the deleted user must be gone');
    },
  },

  {
    name: 'the tag endpoints create, update and delete',
    async run(ctx) {
      const created = await ctx.tagsApi.create({ name: 'contract-crud-tag', color: '#ff8800' });
      assert.equal(created.name, 'contract-crud-tag');
      assert.equal(created.slug, 'contract-crud-tag');
      assert.equal(created.color, '#ff8800');

      const updated = await ctx.tagsApi.update(created.id, {
        name: 'contract-crud-tag-2',
        color: '#00ff88',
      });
      assert.equal(updated.name, 'contract-crud-tag-2');
      assert.equal(updated.slug, 'contract-crud-tag-2');
      assert.equal(updated.color, '#00ff88');

      await ctx.tagsApi.remove(created.id);
      const tags = await ctx.tagsApi.all();
      assert.equal(tags.some((tag) => tag.id === created.id), false,
        'the deleted tag must be gone');
    },
  },

  {
    name: 'the category endpoints create, update and delete',
    async run(ctx) {
      const created = await ctx.categoriesApi.create({
        name: 'Contract Category',
        description: 'created by the contract guard',
      });
      assert.equal(created.name, 'Contract Category');
      assert.equal(created.slug, 'contract-category');
      assert.equal(created.description, 'created by the contract guard');

      const updated = await ctx.categoriesApi.update(created.id, {
        description: 'updated by the contract guard',
      });
      assert.equal(updated.description, 'updated by the contract guard');
      assert.equal(updated.name, 'Contract Category', 'an update must keep the name');

      await ctx.categoriesApi.remove(created.id);
      const categories = await ctx.categoriesApi.list();
      assert.equal(categories.some((category) => category.id === created.id), false,
        'the deleted category must be gone');
    },
  },
];
