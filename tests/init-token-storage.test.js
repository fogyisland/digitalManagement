/**
 * Init-token storage lint — runnable on its own.
 *
 * The gate is `npm run test:contract`, which runs the same rule over the
 * wizard's real directory. This suite exists so the rule can be exercised on
 * its own — `node tests/init-token-storage.test.js` — and it drives the
 * identical fixture list the gate uses, so the two can never disagree about
 * what the rule means.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  INIT_TOKEN_STORAGE_CASES,
  findInitTokenStorageFixtureProblems,
} from './lib/init-token-storage-fixtures.js';
import { findInitTokenStorageProblems } from './lib/init-token-storage.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');
const INIT_DIR = path.join(REPO_ROOT, 'src', 'client', 'pages', 'init');

const fixtureProblems = findInitTokenStorageFixtureProblems();
assert.deepEqual(
  fixtureProblems,
  [],
  `the init-token storage rule mis-read a fixture:\n` +
    fixtureProblems.map((line) => `  - ${line}`).join('\n'),
);

const real = findInitTokenStorageProblems({ initDir: INIT_DIR, repoRoot: REPO_ROOT });
assert.deepEqual(real, [], `the wizard must stay clean:\n${real.join('\n')}`);

console.log(
  `init-token storage: OK (${INIT_TOKEN_STORAGE_CASES.length} fixtures + the wizard)`,
);
