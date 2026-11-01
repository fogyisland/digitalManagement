/**
 * Runtime contract checks — the session.
 *
 * Part of the front↔back guard's runtime half; `tests/lib/runtime-checks.js`
 * owns the runner and the ordering rules.
 *
 * These two checks run last, because both of them end the session they are
 * testing. They cover the token rotation — the presented refresh token is
 * burned, so a stolen copy is useless — and the logout, which revokes the
 * access token and the session it belongs to.
 */

import assert from 'node:assert/strict';
import { expectStatus, rawRequest } from './runtime.js';

/** The account the backend seeds on first boot. */
const ADMIN_USERNAME = 'admin';
const ADMIN_PASSWORD = 'Admin@123456';

/**
 * @typedef {import('./runtime-checks.js').RuntimeCheck} RuntimeCheck
 */

/** @type {RuntimeCheck[]} */
export const sessionChecks = [
  {
    name: 'the refresh token rotates — the presented one is burned',
    async run(ctx) {
      const login = await ctx.authApi.login(ADMIN_USERNAME, ADMIN_PASSWORD);
      const rotated = await ctx.authApi.refresh(login.refresh_token);
      assert.ok(rotated.access_token);
      assert.ok(rotated.refresh_token);
      assert.notEqual(rotated.refresh_token, login.refresh_token,
        'a rotation must issue a new refresh token');

      const burned = await rawRequest(ctx.origin, 'POST', '/api/v1/auth/refresh', {
        body: { refresh_token: login.refresh_token },
      });
      assert.equal(burned.status, 401);
      assert.equal(burned.body.detail, 'Refresh token revoked');

      ctx.client.setToken(rotated.access_token);
      ctx.client.setRefreshToken(rotated.refresh_token);
      const me = await ctx.client.apiGet('/auth/me');
      assert.equal(me.username, ADMIN_USERNAME, 'the rotated pair must work');
    },
  },

  {
    name: 'logout revokes the access token and the session',
    async run(ctx) {
      await ctx.authApi.logout();
      // Drop the refresh token first: the client's 401 handler would try to
      // rotate it, and the rotation would fail for a reason that has nothing
      // to do with what this check is about.
      ctx.client.setRefreshToken(null);
      await expectStatus(ctx.client.apiGet('/auth/me'), 401, 'a revoked access token');
    },
  },
];
