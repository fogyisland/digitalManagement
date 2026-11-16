/**
 * Fixtures for the internal-link rule.
 *
 * The rule is only worth having if it bites on the shape it was written for
 * and stays quiet on the shapes it must not touch. The cases below pin exactly
 * that:
 *
 *   - `spa-page` names a page the router serves — no violation;
 *   - `dead-end` names nothing at all — one violation, which is the shape the
 *     settings page had with its "Swagger UI" link;
 *   - `mounted` names a path under a mounted router — no violation, because a
 *     mount claims everything below it;
 *   - `parameter` builds its target at runtime and lands on a parameterised
 *     page — no violation, because the comparison is between path *shapes*;
 *   - `static-file` names a real file — no violation;
 *   - `jsx-text` puts a `/*` in JSX text before the link — no violation, and
 *     the link has to be *found*: a scanner that mistakes the text for a
 *     comment swallows the rest of the file and reports nothing at all, which
 *     looks exactly like a file with no links in it.
 *
 * Without the quiet cases a rule that flagged every link would read as a pass
 * and nobody would notice.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { findDeadLinkProblems, parseInternalLinks } from './frontend-links.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = path.join(__dirname, '..', 'fixtures', 'frontend-links');

/**
 * One entry per fixture: what the rule should say about it, and why.
 */
export const FRONTEND_LINK_CASES = [
  {
    name: 'spa-page',
    expected: 0,
    expectedLinks: 1,
    why: 'the link names a page the router serves',
    spaRoutes: [{ path: '/library' }],
  },
  {
    name: 'dead-end',
    expected: 1,
    expectedLinks: 1,
    why: 'the link names nothing the instance serves',
    spaRoutes: [{ path: '/library' }],
  },
  {
    name: 'mounted',
    expected: 0,
    expectedLinks: 1,
    why: 'the server mounts /storage, which claims everything below it',
    spaRoutes: [{ path: '/library' }],
    mounts: [{ prefix: '/storage' }],
  },
  {
    name: 'parameter',
    expected: 0,
    expectedLinks: 1,
    why: 'the target is built at runtime and lands on a parameterised page',
    spaRoutes: [{ path: '/library/:id' }],
  },
  {
    name: 'static-file',
    expected: 0,
    expectedLinks: 1,
    why: 'the link names a real file under public/',
    spaRoutes: [{ path: '/library' }],
    staticRoots: [path.join(FIXTURE_ROOT, 'static-file', 'public')],
  },
  {
    name: 'jsx-text',
    expected: 0,
    expectedLinks: 1,
    why: 'the link sits behind JSX text holding a /*, which is not a comment',
    spaRoutes: [{ path: '/library' }],
  },
];

/**
 * Run every fixture and describe the ones that did not behave as expected.
 *
 * @returns {string[]} one line per mismatch, empty when the rule holds
 */
export function findFrontendLinkFixtureProblems() {
  const problems = [];
  for (const testCase of FRONTEND_LINK_CASES) {
    const caseDir = path.join(FIXTURE_ROOT, testCase.name);
    const { links } = parseInternalLinks({ srcDir: caseDir });

    // The link has to be *found*. A scan that comes up empty because it
    // stopped reading the file is not a file without links.
    if (links.length !== testCase.expectedLinks) {
      problems.push(
        `${testCase.name} — expected ${testCase.expectedLinks} link(s) to be found, ` +
          `got ${links.length}`,
      );
    }

    const found = findDeadLinkProblems({
      links,
      spaRoutes: testCase.spaRoutes ?? [],
      backendRoutes: testCase.backendRoutes ?? [],
      mounts: testCase.mounts ?? [],
      staticRoots: testCase.staticRoots ?? [],
    });
    if (found.length !== testCase.expected) {
      problems.push(
        `${testCase.name} — expected ${testCase.expected} violation(s) because ` +
          `${testCase.why}, got ${found.length}`,
      );
      for (const line of found) problems.push(`  ${testCase.name}: ${line}`);
    }
  }
  return problems;
}
