/**
 * Runtime contract checks — the platform layer.
 *
 * Part of the front↔back guard's runtime half; `tests/lib/runtime-checks.js`
 * owns the runner and the ordering rules.
 *
 * These checks cover the layer *above* the tenants: what the platform holds,
 * who holds an account on it, and what the platform layer did. They drive the
 * frontend's own `api/platform.ts`, so a wrong path or a wrong field name
 * fails here rather than in the browser.
 */

import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import { queryTestDb } from './runtime.js';
import { ADMIN_PASSWORD, ADMIN_USERNAME } from './runtime-checks-identity.js';

/** The platform administrator the check signs in as. */
const SUPERADMIN_USERNAME = 'contract-root';
const SUPERADMIN_PASSWORD = 'Contract@789';

/** The account the check promotes and demotes. */
const SUBJECT_ID = 'contract-platform-user';
const SUBJECT_USERNAME = 'contract-platform-subject';

/**
 * @typedef {import('./runtime-checks.js').RuntimeCheck} RuntimeCheck
 */

/**
 * Sign in as the platform administrator and hand the session back afterwards.
 *
 * @param {object} ctx
 * @returns {Promise<void>}
 */
async function asPlatformAdministrator(ctx) {
  const login = await ctx.authApi.platformLogin(SUPERADMIN_USERNAME, SUPERADMIN_PASSWORD);
  ctx.client.setToken(login.access_token);
  ctx.client.setRefreshToken(login.refresh_token);
}

/**
 * Hand the session back to the seeded administrator — the rest of the suite
 * runs as that account.
 *
 * @param {object} ctx
 * @returns {Promise<void>}
 */
async function asSeededAdministrator(ctx) {
  const back = await ctx.authApi.login(ADMIN_USERNAME, ADMIN_PASSWORD);
  ctx.client.setToken(back.access_token);
  ctx.client.setRefreshToken(back.refresh_token);
}

/** @type {RuntimeCheck[]} */
export const platformChecks = [
  {
    name: 'the platform layer answers for the platform, and only for its administrators',
    async run(ctx) {
      // A tenant administrator is kept out of the layer above their tenant.
      let status = 0;
      try {
        await ctx.platformApi.stats();
        status = 200;
      } catch (error) {
        status = error?.response?.status ?? 0;
      }
      assert.equal(status, 403, 'a tenant administrator must not be able to read the platform layer');

      await asPlatformAdministrator(ctx);

      const stats = await ctx.platformApi.stats();
      assert.ok(stats.tenants >= 1, 'the platform must count its tenants');
      assert.ok(stats.accounts >= 1, 'the platform must count its accounts');
      assert.ok(
        stats.platform_administrators >= 1,
        'the platform must count the accounts that may enter it',
      );
      assert.equal(typeof stats.storage_bytes, 'number', 'the platform must report its storage');
      assert.equal(typeof stats.assets, 'number', 'the platform must count its assets');

      // The account directory reaches across the tenants.
      const directory = await ctx.platformApi.accounts({ keyword: SUPERADMIN_USERNAME });
      assert.ok(directory.items.length >= 1, 'the account directory must find the platform administrator');
      assert.ok(
        directory.items.every((account) => typeof account.tenant_id === 'string'),
        'every account in the directory must say which tenant it belongs to',
      );
      assert.ok(
        directory.total >= directory.items.length,
        'the directory must report how many accounts there are in total',
      );

      await asSeededAdministrator(ctx);
    },
  },

  {
    name: 'the platform layer grants and takes back the platform role, and leaves a trace',
    async run(ctx) {
      // An ordinary tenant account to promote.
      await queryTestDb(
        ctx.dbName,
        'INSERT INTO users (id, tenant_id, username, email, password_hash, role) VALUES (?, ?, ?, ?, ?, ?)',
        [
          SUBJECT_ID,
          'default',
          SUBJECT_USERNAME,
          'platform-subject@contract.test',
          bcrypt.hashSync('Subject@789', 10),
          'admin',
        ],
      );

      await asPlatformAdministrator(ctx);

      // Promoted: the account becomes the platform's own and belongs to no tenant.
      const promoted = await ctx.platformApi.updateAccount(SUBJECT_ID, { role: 'superadmin' });
      assert.equal(promoted.role, 'superadmin', 'the account must hold the platform role');
      assert.equal(promoted.tenant_id, '*', 'a platform administrator belongs to no tenant');

      // Demoted: it goes back into a named tenant.
      const demoted = await ctx.platformApi.updateAccount(SUBJECT_ID, {
        role: 'admin',
        tenant_id: 'default',
      });
      assert.equal(demoted.role, 'admin', 'the account must be a tenant administrator again');
      assert.equal(demoted.tenant_id, 'default', 'the account must be back in its tenant');

      // And the platform layer leaves a trace of what it did.
      const audit = await ctx.platformApi.audit(200);
      assert.ok(
        audit.items.some((entry) => entry.action === 'platform.account.updated'),
        'the audit trail must record what the platform layer did to an account',
      );
      assert.ok(
        audit.items.some((entry) => entry.username === SUPERADMIN_USERNAME),
        'the audit trail must name who did it',
      );

      // The subject account is not wanted by the rest of the suite.
      await queryTestDb(ctx.dbName, 'DELETE FROM users WHERE id = ?', [SUBJECT_ID]);

      await asSeededAdministrator(ctx);
    },
  },
];
