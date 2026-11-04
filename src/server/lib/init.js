'use strict';

/**
 * Initialisation state and the `.env` file.
 *
 * A fresh installation has no configuration yet, so the wizard is what turns
 * one into a working instance: it tests the database, creates the
 * administrator and the first tenant, then writes the secrets. Everything
 * that touches the environment file lives here — the routes only decide
 * *when* to call it.
 *
 * The environment file path is configurable (`ENV_FILE`) so the test suite
 * can exercise the wizard without ever writing the developer's real `.env`.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/**
 * Read a `.env` file into an object.
 *
 * Only `KEY=value` lines are read; comments and blank lines are skipped, and
 * a `#` inside a value is kept because only a *leading* `#` starts a comment.
 * A missing file is an empty configuration, not an error — that is exactly
 * the state a fresh installation is in.
 *
 * @param {string} file
 * @returns {Record<string, string>}
 */
function readEnvFile(file) {
  if (!fs.existsSync(file)) return {};
  const text = fs.readFileSync(file, 'utf8');
  const values = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = line.slice(eq + 1).trim();
    // A quoted value is taken literally; an unquoted one ends at an
    // unescaped `#` (an inline comment).
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.lastIndexOf(quote) > 0) {
      value = value.slice(1, value.lastIndexOf(quote));
    } else {
      const hash = value.indexOf(' #');
      if (hash !== -1) value = value.slice(0, hash).trim();
    }
    values[key] = value;
  }
  return values;
}

/**
 * The template the wizard fills in.
 *
 * `.env.example` is the skeleton: its key order and its comments are kept so
 * the file the wizard writes explains itself. A key that is in the template
 * keeps its comment; a key that is not is appended in a small trailing block.
 *
 * @param {Record<string, string>} values
 * @param {string} [templateFile]
 * @returns {string}
 */
function renderEnv(values, templateFile) {
  const template = templateFile && fs.existsSync(templateFile)
    ? fs.readFileSync(templateFile, 'utf8')
    : '';
  const written = new Set();
  const lines = template.split(/\r?\n/).map((line) => {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!match) return line;
    const key = match[1];
    written.add(key);
    const value = Object.prototype.hasOwnProperty.call(values, key)
      ? values[key]
      : match[2];
    return `${key}=${value}`;
  });

  const extra = Object.keys(values).filter((key) => !written.has(key));
  if (extra.length > 0) {
    lines.push('', '# --- Added by the setup wizard ----------------------------------------------');
    for (const key of extra) lines.push(`${key}=${values[key]}`);
  }
  return `${lines.join('\n').replace(/\n+$/, '')}\n`;
}

/**
 * Write the environment file atomically.
 *
 * A half-written `.env` would leave the next boot with a broken
 * configuration, so the content goes to a temporary file first and is then
 * renamed over the original — a rename is atomic on every platform this
 * project runs on.
 *
 * @param {string} file
 * @param {Record<string, string>} values
 * @param {string} [templateFile]
 * @returns {void}
 */
function writeEnvFile(file, values, templateFile) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  // `mode: 0o600` — the file holds the signing key and the database
  // password, so it must not be group- or world-readable.
  fs.writeFileSync(tmp, renderEnv(values, templateFile), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, file);
}

/**
 * The values the wizard writes, with the current file as the base.
 *
 * @param {string} file
 * @param {Record<string, string>} patch
 * @returns {Record<string, string>}
 */
function mergeEnv(file, patch) {
  return { ...readEnvFile(file), ...patch };
}

/**
 * Is this installation set up?
 *
 * The spec's two conditions, both required: the environment file carries a
 * non-empty `JWT_SECRET`, **and** the database already has a tenant. Either
 * one alone is a half-finished wizard, and the wizard has to be resumable
 * from that state.
 *
 * The database is allowed to be unreachable here: an installation whose
 * database is not set up yet is by definition not initialized, and this is
 * called on the wizard's first page.
 *
 * @param {{envFile: string, db?: object}} input
 * @returns {Promise<boolean>}
 */
async function isInitialized({ envFile, db }) {
  const env = readEnvFile(envFile);
  if (!env.JWT_SECRET || env.JWT_SECRET.trim().length === 0) return false;
  if (!db) return false;
  try {
    const row = await db.prepare('SELECT COUNT(*) AS c FROM tenants').get();
    return Number(row.c) > 0;
  } catch (error) {
    // No `tenants` table yet — the schema has not been created. That is a
    // "no", not a failure of the check.
    return false;
  }
}

/**
 * Has this installation been configured at all?
 *
 * The one marker the boot can read before the database is reachable: an
 * environment file that carries a signing key. A fresh checkout has none, so
 * it boots into the wizard instead of seeding a library nobody asked for.
 *
 * @param {string} envFile
 * @returns {boolean}
 */
function hasConfiguration(envFile) {
  const env = readEnvFile(envFile);
  return typeof env.JWT_SECRET === 'string' && env.JWT_SECRET.trim().length > 0;
}

/**
 * Which wizard steps are already done.
 *
 * `initialized` is the spec's combined condition; the steps let the wizard
 * resume in the middle without asking the operator to redo a step.
 *
 * @param {{envFile: string, db?: object}} input
 * @returns {Promise<{initialized: boolean, steps: {database: boolean, admin: boolean, seed: boolean}}>}
 */
async function initStatus({ envFile, db }) {
  const env = readEnvFile(envFile);
  const hasDatabase = Boolean(env.DB_NAME && env.DB_NAME.trim());
  const hasSecret = Boolean(env.JWT_SECRET && env.JWT_SECRET.trim());

  let hasTenant = false;
  let hasAdmin = false;
  if (db) {
    try {
      const tenants = await db.prepare('SELECT COUNT(*) AS c FROM tenants').get();
      hasTenant = Number(tenants.c) > 0;
      // The wizard predates any credential: it counts across every tenant
      // on purpose, because it is the step that creates the first one.
      // tenant-lint: allow the wizard runs before any credential exists
      const admins = await db
        .prepare("SELECT COUNT(*) AS c FROM users WHERE role = 'admin'")
        .get();
      hasAdmin = Number(admins.c) > 0;
    } catch (error) {
      // The schema does not exist yet.
      hasTenant = false;
      hasAdmin = false;
    }
  }

  return {
    initialized: hasSecret && hasTenant,
    steps: {
      database: hasDatabase && hasTenant,
      admin: hasTenant && hasAdmin,
      seed: hasSecret,
    },
  };
}

/**
 * The token a wizard request has to present.
 *
 * A wizard that answers to any caller is a way to take over an instance
 * before its owner reaches it, so the token comes from `INIT_TOKEN` or is
 * generated once per boot and printed to the console.
 *
 * @returns {{token: string, source: 'environment'|'generated'}}
 */
function resolveInitToken() {
  const fromEnv = String(process.env.INIT_TOKEN || '').trim();
  if (fromEnv) return { token: fromEnv, source: 'environment' };
  return { token: crypto.randomBytes(24).toString('hex'), source: 'generated' };
}

/**
 * A strong-enough administrator password: at least ten characters, with at
 * least one letter and one digit.
 *
 * @param {unknown} password
 * @returns {boolean}
 */
function isStrongPassword(password) {
  const value = String(password || '');
  return value.length >= 10 && /[A-Za-z]/.test(value) && /\d/.test(value);
}

module.exports = {
  readEnvFile,
  renderEnv,
  hasConfiguration,
  writeEnvFile,
  mergeEnv,
  isInitialized,
  initStatus,
  resolveInitToken,
  isStrongPassword,
};
