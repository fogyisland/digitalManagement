/**
 * Fixtures for the tenant lint's composed-condition pass.
 *
 * The text check accepts a statement carrying the `-- tenant` marker, which
 * promises "a builder emits the tenant condition". These fixtures pin what
 * that promise has to mean. Each one is a tiny `routes/` file shaped like the
 * real server source, so the rule is exercised against a known-bad builder
 * without weakening the real tree.
 *
 * The cases are data, not a script: `findComposedClauseProblems()` is the
 * single implementation, called both by the contract gate (`npm run
 * test:contract`) and by the standalone suite (`node
 * tests/tenant-lint.test.js`).
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { findUnscopedQueries } from './tenant-lint.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = path.join(__dirname, '..', 'fixtures', 'tenant-lint');

/**
 * One entry per fixture folder: how many violations it should raise and why.
 */
export const COMPOSED_CLAUSE_CASES = [
  {
    name: 'composed-good',
    expected: 0,
    why: 'the tenant fragment is pushed first and every OR fragment is parenthesised',
  },
  {
    name: 'composed-unverified',
    expected: 1,
    why: 'the tenant fragment is pushed after another condition',
  },
  {
    name: 'composed-unparenthesised',
    expected: 1,
    why: 'a later fragment carries a top-level OR that escapes the tenant slice',
  },
  {
    name: 'composed-marker-only',
    expected: 1,
    why: 'the marker promises a builder, but the file has none',
  },
  {
    name: 'composed-dynamic',
    expected: 1,
    why: 'one fragment is a variable, so its content is unaudited',
  },
];

/**
 * Run every fixture and describe the ones that did not behave as expected.
 *
 * @returns {string[]} one line per mismatch, empty when the rule holds
 */
export function findComposedClauseProblems() {
  const problems = [];
  for (const testCase of COMPOSED_CLAUSE_CASES) {
    const dir = path.join(FIXTURE_ROOT, testCase.name);
    const found = findUnscopedQueries({ srcDir: dir, repoRoot: dir });
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
