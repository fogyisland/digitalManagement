/**
 * Tenant-scope lint — the composed-condition pass, runnable on its own.
 *
 * The gate is `npm run test:contract`, which runs the same rule over the real
 * server tree. This suite exists so the rule can be exercised on its own —
 * `node tests/tenant-lint.test.js` — and it drives the identical fixture list
 * the gate uses, so the two can never disagree about what the rule means.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  COMPOSED_CLAUSE_CASES,
  findComposedClauseProblems,
} from './lib/tenant-clause-fixtures.js';
import { findUnscopedQueries } from './lib/tenant-lint.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = path.join(__dirname, '..', 'src', 'server');

const fixtureProblems = findComposedClauseProblems();
assert.deepEqual(
  fixtureProblems,
  [],
  `the composed-condition rule mis-read a fixture:\n${fixtureProblems.map((l) => `  - ${l}`).join('\n')}`,
);

// The real tree is the case that matters: the two live builders — the asset
// filter in `lib/asset-query.js` and the inline one in `routes/users.js` — have
// to keep passing, and every marker-bearing file has to keep an auditable
// builder behind it.
const real = findUnscopedQueries({
  srcDir: SERVER_DIR,
  repoRoot: path.join(__dirname, '..'),
});
assert.deepEqual(real, [], `the server tree must stay clean:\n${real.join('\n')}`);

console.log(
  `tenant-scope lint: composed-condition pass OK ` +
    `(${COMPOSED_CLAUSE_CASES.length} fixtures + the server tree)`,
);
