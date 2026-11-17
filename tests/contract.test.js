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
 * The instance serves the pages from the same port, so the way it delivers
 * the front end is part of the contract too: the shell must not be cached
 * (it names the hashed chunks), the chunks must be, and a chunk that is gone
 * must answer 404 rather than a page of HTML. Those checks need the built
 * front end and step aside — loudly — on a tree that has never been built.
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
import { runStaticHostingChecks } from './lib/runtime-checks-static.js';
import { loadInitSteps } from './lib/runtime-checks-init.js';
import { describeExemptions, findUnscopedQueries } from './lib/tenant-lint.js';
import { findComposedClauseProblems } from './lib/tenant-clause-fixtures.js';
import { findEventVocabularyDrift } from './lib/event-parity.js';
import { MAX_SOURCE_LINES, findOversizedFiles } from './lib/file-size.js';
import { findInitTokenStorageProblems } from './lib/init-token-storage.js';
import {
  INIT_TOKEN_STORAGE_CASES,
  findInitTokenStorageFixtureProblems,
} from './lib/init-token-storage-fixtures.js';
import { findSpaRouteCollisions, parseSpaRoutes } from './lib/spa-routes.js';
import { SPA_ROUTE_CASES, findSpaRouteFixtureProblems } from './lib/spa-route-fixtures.js';
import { findHintTriggerProblems } from './lib/hint-trigger.js';
import { HINT_TRIGGER_CASES, findHintTriggerFixtureProblems } from './lib/hint-trigger-fixtures.js';
import { findErrorSurfaceProblems } from './lib/error-surface.js';
import { ERROR_SURFACE_CASES, findErrorSurfaceFixtureProblems } from './lib/error-surface-fixtures.js';
import {
  MINIMUM_LINKS,
  findDeadLinkProblems,
  parseInternalLinks,
} from './lib/frontend-links.js';
import {
  FRONTEND_LINK_CASES,
  findFrontendLinkFixtureProblems,
} from './lib/frontend-link-fixtures.js';
import { findSpecProblems, readSpec, specOperations } from './lib/openapi-contract.js';
import {
  SOURCE_SCAN_CASES,
  findSourceScanFixtureProblems,
} from './lib/source-scan-fixtures.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const BACKEND_SRC = path.join(REPO_ROOT, 'src', 'server', 'server.js');
const BACKEND_ROUTES = path.join(REPO_ROOT, 'src', 'server', 'routes');
const SERVER_DIR = path.join(REPO_ROOT, 'src', 'server');
const SPEC_FILE = path.join(SERVER_DIR, 'openapi.yaml');
const SRC_DIR = path.join(REPO_ROOT, 'src', 'client');
const INIT_DIR = path.join(SRC_DIR, 'pages', 'init');

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
  // Every scanner in this guard reads the masked copy of the source. A mask
  // that stops too early does not report a problem — it reports *less*, and
  // a check that looks at half a file looks exactly like a file with nothing
  // in it. The fixtures pin the mask's behaviour in both directions.
  const scanFixtureProblems = findSourceScanFixtureProblems();
  assert.deepEqual(
    scanFixtureProblems,
    [],
    `the source scanner mis-read a fixture:\n` +
      scanFixtureProblems.map((v) => `  - ${v}`).join('\n'),
  );
  console.log(
    `source masking OK — comments, strings and regular expressions are blanked ` +
      `out correctly (${SOURCE_SCAN_CASES.length} fixtures)`,
  );

  const { routes, problems, mounts, uiRoutes } = parseBackendRoutes({
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

  // The init token is the credential that creates the platform administrator.
  // It is minted per boot and handed over once, on the console — so it must
  // not be parked anywhere a later script or a later tab can read it. The
  // fixtures pin the rule in both directions: a storage write is a violation,
  // a comment that merely names `localStorage` is not.
  const fixtureDrift = findInitTokenStorageFixtureProblems();
  assert.deepEqual(
    fixtureDrift,
    [],
    `the init-token storage rule mis-read a fixture:\n` +
      fixtureDrift.map((v) => `  - ${v}`).join('\n'),
  );
  const storedTokens = findInitTokenStorageProblems({
    initDir: INIT_DIR,
    repoRoot: REPO_ROOT,
  });
  assert.deepEqual(
    storedTokens,
    [],
    `init-token storage lint failed:\n${storedTokens.map((v) => `  - ${v}`).join('\n')}`,
  );
  console.log(
    `init-token storage OK — the wizard keeps X-Init-Token in memory ` +
      `(${INIT_TOKEN_STORAGE_CASES.length} fixtures)`,
  );

  // A page and a mounted router cannot share a path. The server answers the
  // path it owns first, so the page works on the click and 404s (or 405s, or
  // answers JSON) on the reload — a page nobody can bookmark or share.
  const spaFixtureProblems = findSpaRouteFixtureProblems();
  assert.deepEqual(
    spaFixtureProblems,
    [],
    `the SPA route rule mis-read a fixture:\n` +
      spaFixtureProblems.map((v) => `  - ${v}`).join('\n'),
  );
  const routerFile = path.join(SRC_DIR, 'router.tsx');
  const spaRoutes = parseSpaRoutes({ routerFile });
  const collisions = findSpaRouteCollisions({
    spaRoutes,
    mounts,
    routerLabel: 'src/client/router.tsx',
  });
  assert.deepEqual(
    collisions,
    [],
    `SPA route lint failed (a page may not live on a path the server mounts):\n` +
      collisions.map((v) => `  - ${v}`).join('\n'),
  );
  console.log(
    `SPA route lint OK — ${spaRoutes.length} page paths, none on a mounted path ` +
      `(${SPA_ROUTE_CASES.length} fixtures)`,
  );

  // A link in the interface is a promise. The SPA answers every unknown path
  // with its own "not found" page, so a link to somewhere that does not
  // exist comes back as HTTP 200 and a dead end. The settings page used to
  // advertise `/docs` as "Swagger UI" for an address nothing ever served.
  const linkFixtureProblems = findFrontendLinkFixtureProblems();
  assert.deepEqual(
    linkFixtureProblems,
    [],
    `the internal-link rule mis-read a fixture:\n` +
      linkFixtureProblems.map((v) => `  - ${v}`).join('\n'),
  );
  const { links, skipped: skippedLinks } = parseInternalLinks({ srcDir: SRC_DIR });
  assert.ok(
    links.length >= MINIMUM_LINKS,
    `the internal-link lint found ${links.length} link(s) — a scan that finds ` +
      `almost nothing is not a scan, it is a rule that stopped working`,
  );
  const deadLinks = findDeadLinkProblems({
    links,
    spaRoutes,
    backendRoutes: routes,
    mounts,
    uiRoutes,
    staticRoots: [path.join(REPO_ROOT, 'public'), path.join(REPO_ROOT, 'dist')],
  });
  assert.deepEqual(
    deadLinks,
    [],
    `internal-link lint failed (a link may not point at a place that does not exist):\n` +
      deadLinks.map((v) => `  - ${v}`).join('\n'),
  );
  console.log(
    `internal-link lint OK — ${links.length} link(s), all of them lead somewhere ` +
      `(${FRONTEND_LINK_CASES.length} fixtures)`,
  );

  // A button that is greyed out and cannot say why is a dead end: the reader
  // sees a disabled control and no reason. The browser gives a disabled form
  // control no mouse events, so a tooltip attached to the control itself
  // disappears exactly when it is needed. The rule renders the shared
  // primitive and looks at where antd actually attaches the tooltip — the
  // fixtures pin it in both directions.
  const hintFixtureProblems = findHintTriggerFixtureProblems();
  assert.deepEqual(
    hintFixtureProblems,
    [],
    `the hint-trigger rule mis-read a fixture:\n` +
      hintFixtureProblems.map((v) => `  - ${v}`).join('\n'),
  );
  const hintProblems = findHintTriggerProblems({
    repoRoot: REPO_ROOT,
    hintFile: path.join(SRC_DIR, 'components', 'ui', 'Hint.tsx'),
  });
  assert.deepEqual(
    hintProblems,
    [],
    `hint-trigger lint failed:\n${hintProblems.map((v) => `  - ${v}`).join('\n')}`,
  );
  console.log(
    'hint trigger OK — a disabled button still has something that can explain it ' +
      `(${HINT_TRIGGER_CASES.length} fixtures)`,
  );

  // The backend speaks English; the front end speaks Chinese — and the
  // translation happens in exactly one place, `describeError`. A page that
  // shows the error without going through it puts the raw sentence back in
  // front of the reader. The rule reads the syntax tree and checks that the
  // caught error only ever reaches the reader through a translator; the
  // fixtures pin it in both directions.
  const errorSurfaceFixtureProblems = findErrorSurfaceFixtureProblems();
  assert.deepEqual(
    errorSurfaceFixtureProblems,
    [],
    `the error-surface rule mis-read a fixture:\n` +
      errorSurfaceFixtureProblems.map((v) => `  - ${v}`).join('\n'),
  );
  const errorSurfaceProblems = findErrorSurfaceProblems({ srcDir: SRC_DIR, repoRoot: REPO_ROOT });
  assert.deepEqual(
    errorSurfaceProblems,
    [],
    `error-surface lint failed (an error may only reach the reader through ` +
      `describeError()):\n${errorSurfaceProblems.map((v) => `  - ${v}`).join('\n')}`,
  );
  console.log(
    'error surface OK — every backend error reaches the reader in Chinese ' +
      `(${ERROR_SURFACE_CASES.length} fixtures)`,
  );

  if (skippedLinks.length > 0) {
    console.log(
      `${skippedLinks.length} link(s) are not internal literals and are NOT statically checked:`,
    );
    for (const entry of skippedLinks) {
      console.log(`  - ${entry.file} — ${entry.reason}`);
    }
  }

  // The specification the instance serves has to describe the API the instance
  // really serves — in both directions. A specification that drifts from the
  // code is worse than none: it lies with the authority of a machine-readable
  // document, and the reader who trusts it finds out at runtime.
  const spec = readSpec(SPEC_FILE);
  const specProblems = findSpecProblems({ spec, backendRoutes: routes });
  assert.deepEqual(
    specProblems,
    [],
    `the OpenAPI specification does not match the backend:\n` +
      specProblems.map((v) => `  - ${v}`).join('\n'),
  );
  console.log(
    `OpenAPI specification OK — ${specOperations(spec).length} operation(s) describe ` +
      'the backend exactly, none missing and none invented',
  );

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
  installTypeScriptResolver(SRC_DIR);

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

    const context = {
      origin: server.origin,
      srcDir: SRC_DIR,
      dbName: server.dbName,
      ...apis,
      initSteps,
      state: {},
    };
    const passed = await runRuntimeChecks(context);
    console.log(`runtime integration OK — ${passed.length} checks passed`);

    // The instance also serves the pages, from the very same port. Those
    // checks need the built front end, so they step aside on a tree that has
    // never been built — and they say so rather than passing quietly.
    const hosting = await runStaticHostingChecks({
      origin: server.origin,
      distDir: path.join(REPO_ROOT, 'dist'),
    });
    if (hosting.skipped) {
      console.log(`static hosting SKIPPED — ${hosting.reason}`);
    } else {
      console.log(`static hosting OK — ${hosting.passed.length} checks passed`);
    }

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
