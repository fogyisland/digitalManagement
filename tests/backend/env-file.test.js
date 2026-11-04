'use strict';

/**
 * The environment file's write path.
 *
 * `writeEnvFile` is the only place the wizard replaces a working
 * configuration, and it sits between "the operator just typed the database
 * password" and "the instance can boot". Two properties have to hold when the
 * write is interrupted — a crash, a full disk, a template that cannot be
 * read:
 *
 *   1. the `.env` that was there is still there, byte for byte;
 *   2. no temporary file is left behind.
 *
 * The second one is not cosmetic. `ENV_FILE.tmp` sitting next to the real
 * file looks like a configuration somebody wrote, and an operator recovering
 * from a failed setup has no way to tell the two apart.
 *
 * This suite needs no database and no server: it drives the library function
 * directly against a throw-away directory under the OS temp dir, so the
 * developer's own `.env` is never in reach.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const { mergeEnv, readEnvFile, writeEnvFile } = require('../../src/server/lib/init');

const KNOWN_GOOD = [
  '# --- Database ---------------------------------------------------------------',
  'DB_HOST=127.0.0.1',
  'DB_PORT=3306',
  'DB_NAME=original_schema',
  'JWT_SECRET=original-secret',
  '',
].join('\n');

/**
 * A template shaped like `.env.example` — comments followed by the keys the
 * wizard fills in. The real one lives at the repository root; this copy keeps
 * the suite independent of it while still exercising the comment-preserving
 * path the wizard relies on.
 */
const TEMPLATE = [
  '# --- Database ---------------------------------------------------------------',
  '# The account the server connects with.',
  'DB_HOST=127.0.0.1',
  'DB_PORT=3306',
  'DB_NAME=digital_management',
  '',
].join('\n');

/** The temporary file `writeEnvFile` stages the new content in. */
function tempPathOf(envFile) {
  return `${envFile}.tmp`;
}

/**
 * A throw-away directory with a known-good `.env` already in it, plus the
 * template the wizard passes in.
 *
 * @returns {{dir: string, envFile: string, templateFile: string}}
 */
function makeSandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dam-env-write-'));
  const envFile = path.join(dir, '.env');
  const templateFile = path.join(dir, '.env.example');
  fs.writeFileSync(envFile, KNOWN_GOOD, 'utf8');
  fs.writeFileSync(templateFile, TEMPLATE, 'utf8');
  return { dir, envFile, templateFile };
}

/**
 * Assert the environment file still carries the content it started with.
 *
 * @param {string} envFile
 * @param {string} when a phrase naming the failure that just happened
 */
function assertUnchanged(envFile, when) {
  assert.strictEqual(
    fs.readFileSync(envFile, 'utf8'),
    KNOWN_GOOD,
    `${when}: the existing environment file must survive byte for byte`,
  );
  assert.ok(
    !fs.existsSync(tempPathOf(envFile)),
    `${when}: the temporary file must not be left behind`,
  );
}

/**
 * Case 1 — the ordinary write.
 *
 * The shape every caller uses: `mergeEnv` reads the current file and layers
 * the new values over it, so a key the caller does not pass keeps what the
 * file already said. `writeEnvFile` alone would fall back to the template's
 * default instead, which is why the merge is asserted here rather than
 * assumed.
 *
 * @param {string} envFile
 * @param {string} templateFile
 */
function checkSuccessfulWrite(envFile, templateFile) {
  writeEnvFile(
    envFile,
    mergeEnv(envFile, { DB_NAME: 'new_schema', JWT_SECRET: 'new-secret' }),
    templateFile,
  );
  const written = readEnvFile(envFile);
  assert.strictEqual(written.DB_NAME, 'new_schema', 'the new value must be written');
  assert.strictEqual(written.JWT_SECRET, 'new-secret', 'the secret must be written');
  assert.strictEqual(
    written.DB_HOST,
    '127.0.0.1',
    'a value the caller did not pass must keep its previous value',
  );
  assert.ok(
    !fs.existsSync(tempPathOf(envFile)),
    'a successful write must not leave the temporary file behind',
  );
  assert.ok(
    fs.readFileSync(envFile, 'utf8').includes('# --- Database'),
    'the template comments must survive the write',
  );
}

/**
 * Case 2 — the content cannot even be rendered.
 *
 * A template that is unreadable fails inside `renderEnv`, before anything
 * touches the disk. The existing file has to be untouched, which it is only
 * if the render happens before the write rather than inside its argument
 * list.
 *
 * @param {string} envFile
 */
function checkUnreadableTemplate(envFile) {
  const template = path.join(path.dirname(envFile), 'template-that-is-a-directory');
  fs.mkdirSync(template, { recursive: true });
  assert.throws(
    () => writeEnvFile(envFile, { JWT_SECRET: 'never-written' }, template),
    /EISDIR|EACCES|EPERM/,
    'an unreadable template must raise the filesystem error, not swallow it',
  );
  assertUnchanged(envFile, 'after an unreadable template');
}

/**
 * Case 3 — the write lands but the rename does not.
 *
 * This is the half-written-configuration case the atomic write exists for:
 * the new content is on disk under the temporary name and the swap fails. If
 * the temporary file is left behind, the next operator has two `.env`-shaped
 * files and no way to know which one the server reads.
 *
 * `fs.renameSync` is replaced for the duration of the call because there is
 * no portable filesystem condition that fails exactly this step — a
 * read-only target is an error on Windows and not on POSIX, and making the
 * target a directory would destroy the file whose survival is the point.
 *
 * @param {string} envFile
 */
function checkFailedRename(envFile) {
  const realRename = fs.renameSync;
  let failed = false;
  fs.renameSync = (from, to) => {
    failed = true;
    const error = new Error(`simulated rename failure: ${from} -> ${to}`);
    error.code = 'EACCES';
    throw error;
  };

  try {
    assert.throws(
      () => writeEnvFile(envFile, { JWT_SECRET: 'never-promoted' }),
      /simulated rename failure/,
      'a failed rename must reach the caller instead of being swallowed',
    );
  } finally {
    fs.renameSync = realRename;
  }

  assert.ok(failed, 'the scenario is only meaningful if the rename was attempted');
  assertUnchanged(envFile, 'after a failed rename');
}

/**
 * Case 4 — the file is not world-readable.
 *
 * The file holds the signing key and the database password. On Windows the
 * mode is not honoured, so the check is POSIX-only.
 *
 * @param {string} envFile
 * @param {string} templateFile
 */
function checkFileMode(envFile, templateFile) {
  writeEnvFile(envFile, { JWT_SECRET: 'mode-check' }, templateFile);
  if (process.platform === 'win32') return;
  const mode = fs.statSync(envFile).mode & 0o777;
  assert.strictEqual(
    mode,
    0o600,
    `the environment file must be owner-only, found mode 0${mode.toString(8)}`,
  );
}

function main() {
  const sandbox = makeSandbox();
  try {
    checkSuccessfulWrite(sandbox.envFile, sandbox.templateFile);

    // Restore the known-good content for the scenarios that assert on it.
    fs.writeFileSync(sandbox.envFile, KNOWN_GOOD, 'utf8');
    checkUnreadableTemplate(sandbox.envFile);

    fs.writeFileSync(sandbox.envFile, KNOWN_GOOD, 'utf8');
    checkFailedRename(sandbox.envFile);

    checkFileMode(sandbox.envFile, sandbox.templateFile);

    console.log('env file write OK');
  } finally {
    fs.rmSync(sandbox.dir, { recursive: true, force: true });
  }
}

main();
