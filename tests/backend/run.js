'use strict';

/**
 * Backend test runner.
 *
 * Every suite in this directory is a standalone script: it boots what it
 * needs, asserts on its own and exits non-zero when it fails. This runner
 * executes them in order and prints one summary, so a broken suite names
 * itself instead of disappearing behind the next one.
 *
 * The order is cheapest-first: the pure library checks run before the
 * suites that boot a server.
 */

const path = require('node:path');
const { spawn } = require('node:child_process');

/** The suites, in the order they run. */
const SUITES = [
  'env-file.test.js',
  'webhook.test.js',
  'manifest.test.js',
  'manifest-startup.test.js',
  'webhook.smoke.js',
  'init.test.js',
  'server.test.js',
  // The platform administrator's write path: a write has to name a concrete
  // tenant, and the `X-Tenant` header is not a way out of one.
  'superadmin.probe.js',
];

/**
 * Run one suite and resolve with its exit code.
 *
 * @param {string} file the file name inside `tests/`
 * @returns {Promise<number>} 0 when the suite passed
 */
function runSuite(file) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(__dirname, file)], {
      stdio: 'inherit',
      cwd: path.join(__dirname, '..', '..'),
    });
    child.on('error', (error) => {
      console.error(`[test] could not start ${file}: ${error.message}`);
      resolve(1);
    });
    child.on('exit', (code, signal) => {
      if (signal !== null) {
        console.error(`[test] ${file} was killed by ${signal}`);
        resolve(1);
        return;
      }
      resolve(code === null ? 1 : code);
    });
  });
}

/**
 * Run every suite and report.
 *
 * @returns {Promise<void>}
 */
async function main() {
  const failures = [];

  for (const suite of SUITES) {
    console.log(`\n[test] ==== ${suite} ====`);
    const code = await runSuite(suite);
    if (code !== 0) failures.push(suite);
  }

  console.log('\n[test] ==== summary ====');
  if (failures.length === 0) {
    console.log(`[test] all ${SUITES.length} suite(s) passed`);
    return;
  }
  for (const suite of failures) {
    console.error(`[test] FAILED: ${suite}`);
  }
  throw new Error(`${failures.length} of ${SUITES.length} suite(s) failed`);
}

main().catch((error) => {
  console.error('[test]', error && error.message ? error.message : error);
  process.exit(1);
});
