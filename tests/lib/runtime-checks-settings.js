/**
 * Runtime contract checks — the instance's own settings.
 *
 * Part of the front↔back guard's runtime half; `tests/lib/runtime-checks.js`
 * owns the runner and the ordering rules.
 *
 * These checks cover the two things that used to be environment variables and
 * are now settings: the address this instance answers at, and the origins that
 * are allowed to call it from a browser. What matters about them is not that
 * they can be stored — it is that they *take effect*: the address has to show
 * up in the links the instance hands out, and the cross-origin list has to
 * decide what a browser is allowed to do, both without a restart.
 *
 * They run after the asset checks, because one of them needs an asset to look
 * at — the links that carry the address are the links to a file.
 *
 * They drive the frontend's own `api/settings.ts` and `api/platform.ts`, so a
 * wrong path or a wrong field name fails here rather than in the browser.
 */

import assert from 'node:assert/strict';
import { expectStatus, rawRequest, TINY_PNG } from './runtime.js';
import { asPlatformAdministrator, asSeededAdministrator } from './runtime-checks-platform.js';

/**
 * @typedef {import('./runtime-checks.js').RuntimeCheck} RuntimeCheck
 */

/** The address the check puts into the settings. */
const ACCESS_DOMAIN = 'dam.contract.test';
const ACCESS_DOMAIN_URL = 'https://dam.contract.test';

/** The origin the check allows to call the instance. */
const ALLOWED_ORIGIN = 'https://ui.contract.test';

/** The origin the check does *not* allow. */
const OTHER_ORIGIN = 'https://other.contract.test';

/** @type {RuntimeCheck[]} */
export const settingsChecks = [
  {
    name: 'the address and the cross-origin list are the platform administrator\'s business',
    async run(ctx) {
      // A tenant administrator is kept out of the platform's own settings.
      let status = 0;
      try {
        await ctx.platformApi.settings();
        status = 200;
      } catch (error) {
        status = error?.response?.status ?? 0;
      }
      assert.equal(status, 403, 'a tenant administrator must not be able to read the platform settings');

      await asPlatformAdministrator(ctx);

      const settings = await ctx.platformApi.settings();
      assert.equal(typeof settings.access_domain, 'string', 'the settings must carry an address');
      assert.ok(Array.isArray(settings.cors_origins), 'the settings must carry a list of origins');

      // An address that cannot be a URL is refused, and the refusal has a code
      // the interface can translate.
      const error = await expectStatus(
        ctx.platformApi.saveSettings({ access_domain: 'ftp://not-a-web-address' }),
        400,
        'an address that is not http',
      );
      assert.equal(error.response.data.code, 'BAD_ACCESS_DOMAIN');

      // The address is cleaned up: the scheme is filled in, the trailing slash
      // is dropped, and the same origin twice is only one origin.
      const saved = await ctx.platformApi.saveSettings({
        access_domain: `${ACCESS_DOMAIN}/`,
        cors_origins: [ALLOWED_ORIGIN, ALLOWED_ORIGIN],
      });
      assert.equal(saved.access_domain, ACCESS_DOMAIN_URL, 'the address must be cleaned up');
      assert.deepEqual(saved.cors_origins, [ALLOWED_ORIGIN], 'the origins must be de-duplicated');

      // It takes effect at once — no restart, no redeploy.
      const again = await ctx.platformApi.settings();
      assert.equal(again.access_domain, ACCESS_DOMAIN_URL, 'the new address must be in effect at once');

      // Changing one thing does not quietly throw another away.
      const onlyDomain = await ctx.platformApi.saveSettings({ access_domain: ACCESS_DOMAIN });
      assert.deepEqual(
        onlyDomain.cors_origins,
        [ALLOWED_ORIGIN],
        'changing the address must not clear the cross-origin list',
      );

      // The platform layer leaves a trace of what it did.
      const audit = await ctx.platformApi.audit(200);
      assert.ok(
        audit.items.some((entry) => entry.action === 'platform.settings.updated'),
        'the audit trail must record the change of the settings',
      );

      await asSeededAdministrator(ctx);

      // Every signed-in account may read the address — it is the address the
      // instance answers at, not a secret.
      const instance = await ctx.settingsApi.get();
      assert.equal(instance.access_domain, ACCESS_DOMAIN_URL, 'a signed-in account must see the address');
      assert.equal(
        instance.cors_origins,
        undefined,
        'the cross-origin list is not everybody\'s business',
      );
    },
  },

  {
    name: 'the links the instance hands out carry the address it says it has',
    async run(ctx) {
      // Start from a known state: no address. The check before this one left
      // one behind, and "the links are relative" is only true without it.
      await asPlatformAdministrator(ctx);
      await ctx.platformApi.saveSettings({ access_domain: '' });
      await asSeededAdministrator(ctx);

      // An asset to look at: the links that carry the address are links to a
      // file, so there has to be a file.
      const file = new File([TINY_PNG], 'settings-check.png', { type: 'image/png' });
      const uploaded = await ctx.assetsApi.upload(file, { title: 'settings-check' });
      const asset = uploaded.items[0];
      assert.ok(
        String(asset.thumbnail_url).startsWith('/storage/'),
        'without an address the links stay relative',
      );

      await asPlatformAdministrator(ctx);
      await ctx.platformApi.saveSettings({ access_domain: ACCESS_DOMAIN });
      await asSeededAdministrator(ctx);

      const detail = await ctx.assetsApi.get(asset.id);
      assert.ok(
        String(detail.thumbnail_url).startsWith(`${ACCESS_DOMAIN_URL}/storage/`),
        'the link must carry the address the platform says the instance has',
      );
      assert.ok(
        String(detail.original_url).startsWith(`${ACCESS_DOMAIN_URL}/storage/`),
        'every link to a file must carry the address',
      );

      // The cross-origin list decides who may call the instance. A browser
      // that is not on the list gets no permission — the answer says so by
      // not carrying the header that grants it.
      const allowed = await rawRequest(ctx.origin, 'GET', '/api/health', {
        headers: { Origin: ALLOWED_ORIGIN },
      });
      assert.equal(allowed.status, 200, 'the instance must answer an allowed origin');
      assert.equal(
        allowed.headers['access-control-allow-origin'],
        ALLOWED_ORIGIN,
        'an allowed origin must be told that it may call the instance',
      );

      const refused = await rawRequest(ctx.origin, 'GET', '/api/health', {
        headers: { Origin: OTHER_ORIGIN },
      });
      assert.equal(
        refused.headers['access-control-allow-origin'],
        undefined,
        'an origin that is not on the list must not be given permission',
      );

      // The address itself is always one of the allowed origins: the
      // interface is served from there, so it is talking to itself.
      const own = await rawRequest(ctx.origin, 'GET', '/api/health', {
        headers: { Origin: ACCESS_DOMAIN_URL },
      });
      assert.equal(
        own.headers['access-control-allow-origin'],
        ACCESS_DOMAIN_URL,
        'the instance\'s own address must always be allowed',
      );

      // Back to no address: the links are relative again, so the checks that
      // follow still see the library it always was.
      await asPlatformAdministrator(ctx);
      await ctx.platformApi.saveSettings({ access_domain: '' });
      await asSeededAdministrator(ctx);

      const relative = await ctx.assetsApi.get(asset.id);
      assert.ok(
        String(relative.thumbnail_url).startsWith('/storage/'),
        'clearing the address must make the links relative again',
      );

      await ctx.assetsApi.remove(asset.id, true);
    },
  },
];
