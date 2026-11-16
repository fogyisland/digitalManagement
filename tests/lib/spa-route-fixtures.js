/**
 * Fixtures for the SPA-route / mounted-path rule.
 *
 * The rule is only worth having if it bites on the shape it was written for
 * and stays quiet on the shapes it must not touch. The cases below pin exactly
 * that:
 *
 *   - `collides` puts a page on the mounted path — one violation;
 *   - `nested` puts a page *under* the mounted path — one violation, because a
 *     mount claims everything below it;
 *   - `sibling` puts a page next to the mounted path — no violation, because
 *     Express matches a mount on a path segment boundary.
 *
 * Without the last case a rule that flagged every path sharing a prefix would
 * read as two passes and nobody would notice.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { findSpaRouteCollisions, parseSpaRoutes } from './spa-routes.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = path.join(__dirname, '..', 'fixtures', 'spa-routes');

/**
 * One entry per fixture: how many collisions it should raise and why.
 */
export const SPA_ROUTE_CASES = [
  {
    name: 'collides',
    mounts: ['/mcp'],
    expected: 1,
    why: 'the page sits exactly on the path the server mounts a router on',
  },
  {
    name: 'nested',
    mounts: ['/mcp'],
    expected: 1,
    why: 'a mount claims everything below it, so the page under it is swallowed too',
  },
  {
    name: 'sibling',
    mounts: ['/mcp'],
    expected: 0,
    why: 'the page is a sibling of the mount, and Express matches on a segment boundary',
  },
];

/**
 * Run every fixture and describe the ones that did not behave as expected.
 *
 * @returns {string[]} one line per mismatch, empty when the rule holds
 */
export function findSpaRouteFixtureProblems() {
  const problems = [];
  for (const testCase of SPA_ROUTE_CASES) {
    const routerFile = path.join(FIXTURE_ROOT, testCase.name, 'router.ts');
    const spaRoutes = parseSpaRoutes({ routerFile });
    const found = findSpaRouteCollisions({
      spaRoutes,
      mounts: testCase.mounts.map((prefix) => ({ prefix })),
      routerLabel: testCase.name,
    });
    if (found.length !== testCase.expected) {
      problems.push(
        `${testCase.name} — expected ${testCase.expected} collision(s) because ` +
          `${testCase.why}, got ${found.length}`,
      );
      for (const line of found) problems.push(`  ${testCase.name}: ${line}`);
    }
  }
  return problems;
}
