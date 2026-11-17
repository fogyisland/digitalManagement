/**
 * Runtime contract checks — the front↔back guard's runtime half.
 *
 * Every check drives the **frontend's own API modules** against a real
 * backend. Nothing here re-implements the request: if `src/api/assets.ts`
 * sends the wrong path, the wrong field name or the wrong verb, the check
 * fails here — not in the browser.
 *
 * The checks live in ten files, one per area of the system:
 *
 *   - `runtime-checks-identity.js`     — login, tokens, list envelopes, catalogue
 *   - `runtime-checks-tenants.js`      — the tenant registry, the two doors
 *   - `runtime-checks-platform.js`     — the layer above the tenants
 *   - `runtime-checks-tenant.js`       — writing has to land in a tenant, and
 *                                        the interface has to say so
 *   - `runtime-checks-assets.js`       — the asset lifecycle, including the
 *                                        three deletion states
 *   - `runtime-checks-settings.js`     — the address the instance answers at,
 *                                        and who may call it
 *   - `runtime-checks-integrations.js` — API keys, delivery, chunked upload,
 *                                        import-by-URL, ComfyUI, webhooks
 *   - `runtime-checks-init.js`         — the first-boot wizard
 *   - `runtime-checks-time.js`         — how the interface reads a timestamp
 *   - `runtime-checks-session.js`      — token rotation and logout
 *
 * They run in that order and share one context: later checks depend on the
 * state earlier ones created (the uploaded asset, the API key, …).
 * `ctx.state` is that shared scratch space. The order is not arbitrary —
 * the session checks come last because they end the session, and the
 * webhook check comes after every check that produces an asset event.
 *
 * The settings checks sit after the asset checks because one of them looks at
 * the links to a file, and there has to be a file to look at.
 *
 * The time checks come first because they read nothing from the instance:
 * they are about how the interface turns a timestamp into something a person
 * reads, and every other check writes timestamps for them to read.
 *
 * Negative cases go through `rawRequest` rather than the axios instance: a
 * rejected axios call triggers the client's 401 handler, which clears the
 * stored tokens and would break every check after it.
 */

import { assetChecks } from './runtime-checks-assets.js';
import { identityChecks } from './runtime-checks-identity.js';
import { initChecks } from './runtime-checks-init.js';
import { integrationChecks } from './runtime-checks-integrations.js';
import { platformChecks } from './runtime-checks-platform.js';
import { sessionChecks } from './runtime-checks-session.js';
import { settingsChecks } from './runtime-checks-settings.js';
import { tenantChecks } from './runtime-checks-tenants.js';
import { tenantWriteChecks } from './runtime-checks-tenant.js';
import { timeChecks } from './runtime-checks-time.js';

/**
 * @typedef {object} CheckContext
 * @property {string} origin the test server's origin, e.g. `http://127.0.0.1:41234`
 * @property {string} srcDir the frontend source directory the checks read from
 * @property {any} client the `src/api/client.ts` module
 * @property {any} authApi
 * @property {any} assetsApi
 * @property {any} usersApi
 * @property {any} tagsApi
 * @property {any} categoriesApi
 * @property {any} apiKeysApi
 * @property {any} webhooksApi
 * @property {any} platformApi the platform layer's own API
 * @property {any} formatUtils the interface's time helpers (`utils/format.ts`)
 * @property {any} initSteps the wizard's step module
 * @property {(form: {url: string, title?: string}) => Promise<any>} importUrlByUrl
 * @property {(jobId: string) => Promise<any|null>} lookupComfyUiJob
 * @property {(jobId: string, payload?: object) => Promise<any>} registerAssetByComfyJob
 * @property {Record<string, any>} state scratch space shared between checks
 */

/**
 * @typedef {object} RuntimeCheck
 * @property {string} name a human readable description
 * @property {(ctx: CheckContext) => Promise<void>} run
 */

/**
 * Every check, in the order they run.
 *
 * The tenant checks sit right after the identity ones: they need a session
 * to begin with (the first of them checks that a tenant administrator is
 * kept out of the registry), and they give the session back before they
 * finish — the rest of the suite runs as the seeded administrator, which is
 * what it has always assumed.
 *
 * The platform checks follow the tenant ones for the same reason, and for one
 * more: the platform administrator they sign in as is the account the tenant
 * checks created.
 *
 * The tenant-write checks sit right after the platform ones: they need that
 * platform administrator, and they end by handing the session back to the
 * seeded administrator, the way every group of checks does.
 */
export const runtimeChecks = [
  ...timeChecks,
  ...identityChecks,
  ...tenantChecks,
  ...platformChecks,
  ...tenantWriteChecks,
  ...assetChecks,
  ...settingsChecks,
  ...integrationChecks,
  ...initChecks,
  ...sessionChecks,
];

/**
 * Run every check in order.
 *
 * The first failure aborts the run and names the check that failed — a
 * contract break is much easier to read as "the chunked upload assembles the
 * parts in index order failed" than as a stack trace pointing at an
 * assertion 200 lines below the actual mistake.
 *
 * @param {CheckContext} ctx
 * @returns {Promise<string[]>} the names of the checks that passed
 */
export async function runRuntimeChecks(ctx) {
  const passed = [];
  for (const check of runtimeChecks) {
    try {
      await check.run(ctx);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`runtime check "${check.name}" failed: ${message}`, { cause: error });
    }
    passed.push(check.name);
  }
  return passed;
}
