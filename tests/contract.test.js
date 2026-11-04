/**
 * Front ↔ back API contract guard.
 *
 * Run with `npm test` from `frontend/`. Two independent checks run back to
 * back; both must pass.
 *
 * ---------------------------------------------------------------------------
 * Part A — static route lint
 * ---------------------------------------------------------------------------
 * The backend's route table is **derived from the source**, not hard-coded:
 * `backend/src/server.js` mounts router factories, each factory file
 * registers `router.<verb>('<path>')`. `tests/lib/backend-routes.js` puts
 * those three facts together and checks the wiring in both directions — a
 * route file nobody mounts, a factory without a file, a router mounted
 * outside an `/api` namespace, a literal path shadowed by a parameterised
 * one — all fail the run.
 *
 * Every HTTP call site in `src/` is then matched against that table.
 *
 * The check that matters most: the axios instance in `src/api/client.ts`
 * already points at `/api/v1`, so a call site that *also* carries the prefix
 * would be sent to `/api/v1/api/v1/...` and answer 404. That was the state
 * of the whole legacy API layer — every login, list and upload silently
 * 404'd. A path that still carries the prefix is a hard failure here, and a
 * call site with **no** matching backend route is a hard failure too. There
 * is no allow-list of known gaps any more: the frontend and the backend are
 * one system, so a gap between them is a bug, not a to-do item.
 *
 * Call sites whose path is built at runtime cannot be checked statically.
 * They are counted and listed — separated into the ones that merely forward a
 * parameter and the ones that name a route the check cannot resolve — so the
 * summary never claims more coverage than it has.
 *
 * ---------------------------------------------------------------------------
 * Part B — runtime integration
 * ---------------------------------------------------------------------------
 * A real backend is started on an isolated database and storage directory,
 * and the frontend's own API modules are imported and driven against it:
 * login, token rotation, the list endpoints, the multipart upload under the
 * backend's `files` field name, the three deletion states, the chunked
 * upload, the import-by-URL guard, the delivery API and its scopes.
 *
 * This is the part that would have caught the original double-prefix bug
 * and the `file` vs `files` multipart mismatch — both of which are silent
 * at compile time and fatal at runtime.
 *
 * The user's live `backend/data/dam.db` is never touched: the server is
 * spawned with `DB_PATH` and `STORAGE_DIR` pointing at a fresh temp dir.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ADMIN_NAMESPACE,
  buildRouteIndex,
  findShadowingProblems,
  parseBackendRoutes,
} from './lib/backend-routes.js';
import { parseFrontendCallSites } from './lib/frontend-calls.js';
import {
  installBrowserGlobals,
  installTypeScriptResolver,
  loadFrontendApis,
  startBackend,
  waitForHealth,
} from './lib/runtime.js';
import { runRuntimeChecks } from './lib/runtime-checks.js';
import { loadInitSteps } from './lib/runtime-checks-init.js';
import { describeExemptions, findUnscopedQueries } from './lib/tenant-lint.js';
import { findComposedClauseProblems } from './lib/tenant-clause-fixtures.js';
import { findEventVocabularyDrift } from './lib/event-parity.js';
import { MAX_SOURCE_LINES, findOversizedFiles } from './lib/file-size.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const BACKEND_SRC = path.join(REPO_ROOT, 'src', 'server', 'server.js');
const BACKEND_ROUTES = path.join(REPO_ROOT, 'src', 'server', 'routes');
const SERVER_DIR = path.join(REPO_ROOT, 'src', 'server');
const SRC_DIR = path.join(REPO_ROOT, 'src', 'client');

/* ==========================================================================
   Part A — static route lint
   ========================================================================== */

/**
 * Check the shared axios instance still points at the namespace the backend
 * mounts the admin API under.
 *
 * @param {string[]} violations
 */
function checkBaseUrl(violations) {
  const clientSource = fs.readFileSync(path.join(SRC_DIR, 'api', 'client.ts'), 'utf8');
  const match = /baseURL\s*:\s*(['"`])([^'"`]+)\1/.exec(clientSource);
  if (match === null) {
    violations.push('src/api/client.ts — no baseURL found on the shared axios instance');
    return;
  }
  if (match[2] !== ADMIN_NAMESPACE) {
    violations.push(
      `src/api/client.ts baseURL is "${match[2]}" — expected "${ADMIN_NAMESPACE}"`,
    );
  }
}

/**
 * Run Part A.
 *
 * @returns {{callSites: number, backendRoutes: number, dynamic: number, forwarded: number}}
 */
function runStaticLint() {
  const { routes, problems } = parseBackendRoutes({
    serverFile: BACKEND_SRC,
    routesDir: BACKEND_ROUTES,
    repoRoot: REPO_ROOT,
  });
  const violations = [...problems];
  violations.push(...findShadowingProblems(routes));

  const index = buildRouteIndex(routes, ADMIN_NAMESPACE);
  const { sites, skipped } = parseFrontendCallSites({ srcDir: SRC_DIR, repoRoot: REPO_ROOT });

  for (const site of sites) {
    const where = `${site.file}:${site.line}`;

    if (site.method === 'PATCH') {
      violations.push(`${where} uses PATCH — the backend serves no PATCH route`);
      continue;
    }

    if (site.rawPath.startsWith('/api/v1')) {
      violations.push(
        `${where} path "${site.rawPath}" still carries the /api/v1 prefix — ` +
          'the axios instance already points there, so the request resolves to ' +
          `/api/v1${site.rawPath} and answers 404`,
      );
      continue;
    }

    const key = `${site.method} ${site.path}`;
    if (!index.has(key)) {
      violations.push(`${where} ${site.method} ${site.path} — no matching backend route`);
    }
  }

  checkBaseUrl(violations);

  assert.deepEqual(
    violations,
    [],
    `API contract lint failed:\n${violations.map((v) => `  - ${v}`).join('\n')}`,
  );

  // Every business query has to carry the tenant condition. This is the
  // half of the multi-tenant design that does not rely on a handler
  // remembering: the SQL is read as text and a missing `tenant_id` fails the
  // build, naming the file and line.
  const unscoped = findUnscopedQueries({ srcDir: SERVER_DIR, repoRoot: REPO_ROOT });
  assert.deepEqual(
    unscoped,
    [],
    `tenant-scope lint failed (add "tenant_id" to the query, or list it as an ` +
      `exemption with a reason):\n${unscoped.map((v) => `  - ${v}`).join('\n')}`,
  );
  console.log(
    `tenant-scope lint OK — every business query names a tenant ` +
      `(${describeExemptions().length} exemption(s))`,
  );

  // The text check above cannot see a condition assembled at runtime. Where a
  // statement defers to a builder via the `-- tenant` marker, the builder
  // itself is audited: the tenant fragment has to be the one the conditions
  // are joined onto, and no fragment may carry a bare OR that escapes it. The
  // fixtures under `tests/fixtures/tenant-lint/` are the rule's own tests —
  // without them a rule that silently stopped matching would look like a pass.
  const composed = findComposedClauseProblems();
  assert.deepEqual(
    composed,
    [],
    `tenant composed-clause lint failed:\n${composed.map((v) => `  - ${v}`).join('\n')}`,
  );
  console.log('tenant composed-clause lint OK — every marker-bearing builder is auditable');

  // A source file nobody can hold in their head is the file nobody reviews.
  // The limit is the project's own (CLAUDE.md §1.3), checked over the server
  // source — the half this plan grew past it.
  const oversized = findOversizedFiles({ dirs: [SERVER_DIR], repoRoot: REPO_ROOT });
  assert.deepEqual(
    oversized,
    [],
    `source file length lint failed (split the file; the limit is ${MAX_SOURCE_LINES} lines):\n` +
      oversized.map((entry) => `  - ${entry.file} — ${entry.lines} lines`).join('\n'),
  );
  console.log(`source file length OK — every server file is within ${MAX_SOURCE_LINES} lines`);

  // The webhook vocabulary exists twice — once in the backend, once in the
  // frontend — and the two have to agree: an event the UI offers but the
  // backend rejects is a subscription the user can never fix, and an event
  // the backend sends but the UI never offers is invisible.
  const drift = findEventVocabularyDrift({ repoRoot: REPO_ROOT });
  assert.deepEqual(
    drift,
    [],
    `webhook event vocabulary drift:\n${drift.map((v) => `  - ${v}`).join('\n')}`,
  );
  console.log('event vocabulary parity OK — backend and frontend agree');

  console.log(
    `static route lint OK — ${sites.length} call sites checked against ` +
      `${index.size} backend routes in ${ADMIN_NAMESPACE}`,
  );

  const dynamic = skipped.filter((entry) => entry.kind === 'dynamic');
  const forwarded = skipped.filter((entry) => entry.kind === 'forwarded');
  const resolved = sites.filter((site) => site.isResolved === true);

  if (resolved.length > 0) {
    console.log(`${resolved.length} call site(s) build their path at runtime and were resolved to a literal:`);
    for (const site of resolved) {
      console.log(`  - ${site.file}:${site.line} → ${site.method} ${site.path}`);
    }
  }
  if (dynamic.length > 0) {
    console.log(`${dynamic.length} call site(s) build their path at runtime and are NOT statically checked:`);
    for (const entry of dynamic) {
      console.log(`  - ${entry.file}:${entry.line} — ${entry.reason}`);
    }
  }
  if (forwarded.length > 0) {
    console.log(`${forwarded.length} call site(s) forward a path from a parameter — no route is named there:`);
    for (const entry of forwarded) {
      console.log(`  - ${entry.file}:${entry.line} — ${entry.reason}`);
    }
  }

  return {
    callSites: sites.length,
    backendRoutes: index.size,
    resolved: resolved.length,
    dynamic: dynamic.length,
    forwarded: forwarded.length,
  };
}

/* ==========================================================================
   Part B — runtime integration
   ========================================================================== */

/**
 * Run Part B.
 *
 * @returns {Promise<number>} the number of checks that passed
 */
async function runRuntimeIntegration() {
  installBrowserGlobals();
  installTypeScriptResolver();

  const server = await startBackend({ backendEntry: BACKEND_SRC });
  try {
    await waitForHealth(server.port, server.child);

    const apis = await loadFrontendApis(SRC_DIR);
    // The browser resolves the relative baseURL against the page origin; in
    // Node we point the very same instance at the test server.
    apis.client.apiClient.defaults.baseURL = `${server.origin}/api/v1`;

    // The wizard's step mapping is pure logic, so it is loaded straight from
    // the frontend source — the check and the wizard read the same function.
    const initSteps = await loadInitSteps(SRC_DIR);

    const context = { origin: server.origin, srcDir: SRC_DIR, ...apis, initSteps, state: {} };
    const passed = await runRuntimeChecks(context);
    console.log(`runtime integration OK — ${passed.length} checks passed`);
    return passed.length;
  } catch (error) {
    console.error('--- backend log ---');
    console.error(server.log().trim());
    throw error;
  } finally {
    await server.stop();
  }
}

/* ==========================================================================
   Entry point
   ========================================================================== */

async function main() {
  runStaticLint();

  // The static half needs nothing but the source tree; the runtime half
  // needs a MySQL server. `CONTRACT_STATIC_ONLY=1` runs the first one alone,
  // which is useful when the database is not reachable.
  if (process.env.CONTRACT_STATIC_ONLY === '1') {
    console.log('\nStatic contract check passed (runtime half skipped).');
    return;
  }

  await runRuntimeIntegration();
  console.log('\nAll contract checks passed.');
}

main().catch((error) => {
  console.error('\nContract check failed:');
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
