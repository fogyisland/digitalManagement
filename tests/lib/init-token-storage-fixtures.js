/**
 * Fixtures for the init-token storage rule.
 *
 * The rule is only worth having if it bites on the shape it was written for
 * and stays quiet on the shapes it must not touch. The three cases below pin
 * exactly that, on a source shape indistinguishable from the wizard's real
 * one:
 *
 *   - `init-clean` keeps the token in a module variable — no violation;
 *   - `init-stored` remembers it in `localStorage` — one violation;
 *   - `init-comment-only` mentions `localStorage` in a comment, which is what
 *     `initApi.ts` does when it promises never to use it — no violation,
 *     because the scan reads the masked source.
 *
 * Without the third case a mask that stopped working would read as two passes
 * and nobody would notice.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { findInitTokenStorageProblems } from './init-token-storage.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = path.join(__dirname, '..', 'fixtures', 'init-token');

/**
 * One entry per fixture folder: how many violations it should raise and why.
 */
export const INIT_TOKEN_STORAGE_CASES = [
  {
    name: 'init-clean',
    expected: 0,
    why: 'the token lives in a module variable and never reaches browser storage',
  },
  {
    name: 'init-stored',
    expected: 2,
    why: 'the token is written to and read back from localStorage, which outlives the page',
  },
  {
    name: 'init-comment-only',
    expected: 0,
    why: 'localStorage appears only inside a comment, and the scan reads the masked source',
  },
];

/**
 * Run every fixture and describe the ones that did not behave as expected.
 *
 * @returns {string[]} one line per mismatch, empty when the rule holds
 */
export function findInitTokenStorageFixtureProblems() {
  const problems = [];
  const repoRoot = path.join(__dirname, '..');
  for (const testCase of INIT_TOKEN_STORAGE_CASES) {
    const dir = path.join(FIXTURE_ROOT, testCase.name);
    const found = findInitTokenStorageProblems({ initDir: dir, repoRoot: dir });
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
