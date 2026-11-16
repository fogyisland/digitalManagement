'use strict';

/**
 * The platform administrator command.
 *
 * A platform administrator is the account that belongs to no single tenant:
 * it may read across every tenant, and it may act in any one of them by
 * naming that tenant in the `X-Tenant` header. There is no API that hands
 * this role out — deliberately: a role that can read every tenant is a
 * security boundary, and an endpoint that grants it is a privilege
 * escalation. So the account is granted here, at the console, by whoever has
 * the database.
 *
 *   npm run superadmin -- --username root
 *   npm run superadmin -- --username root --password 'a-strong-password'
 *   npm run superadmin -- --username alice --promote
 *
 * Without `--password` a password is generated and printed once. The
 * generated one is not recoverable — only its hash is stored.
 *
 * `--promote` turns an existing tenant account into a platform
 * administrator: its role becomes `superadmin` and it moves to the wildcard
 * tenant, which is where the platform keeps the accounts that belong to no
 * tenant. Without the flag, an existing account is left alone.
 *
 * The script talks to the same MySQL server the application uses — the
 * `DB_*` values from `.env`, or the defaults in `src/server/config.js`.
 */

const path = require('path');
const crypto = require('crypto');

require('dotenv').config({ path: path.join(__dirname, '..', '..', '..', '.env') });

const bcrypt = require('bcryptjs');
const { nanoid } = require('nanoid');
const { getConfig } = require('../config');
const { connect } = require('../lib/db');
const { initSchema } = require('../lib/schema');
const { ALL_TENANTS, SUPERADMIN_ROLE } = require('../lib/tenant');

/** The shortest password the script accepts. */
const MIN_PASSWORD_LENGTH = 8;

/**
 * Parse `--key value` and `--flag` arguments.
 *
 * @param {string[]} argv
 * @returns {{values: Record<string, string>, flags: Set<string>}}
 */
function parseArgs(argv) {
  const values = {};
  const flags = new Set();
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const name = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      flags.add(name);
      continue;
    }
    values[name] = next;
    i += 1;
  }
  return { values, flags };
}

/**
 * A password nobody else knows.
 *
 * @returns {string}
 */
function generatePassword() {
  return crypto.randomBytes(12).toString('base64url');
}

/**
 * Run the command.
 *
 * @returns {Promise<void>}
 */
async function main() {
  const { values, flags } = parseArgs(process.argv.slice(2));
  const username = String(values.username || '').trim();
  const config = getConfig();

  if (!username) {
    console.error('[superadmin] a username is required: --username <name>');
    process.exitCode = 1;
    return;
  }

  const password = values.password || generatePassword();
  const generated = !values.password;
  if (String(password).length < MIN_PASSWORD_LENGTH) {
    console.error(
      `[superadmin] the password must be at least ${MIN_PASSWORD_LENGTH} characters`,
    );
    process.exitCode = 1;
    return;
  }

  console.log(`[superadmin] database: ${config.dbUser}@${config.dbHost}:${config.dbPort}/${config.dbName}`);

  const db = await connect(config);
  try {
    await initSchema(db);

    // The username is unique per tenant, not globally — the same name may
    // exist in two tenants. A promotion needs one row to act on, so more
    // than one match is refused rather than guessed at.
    const existing = await db
      .prepare(
        'SELECT id, tenant_id, role, is_active FROM users WHERE username = ? ORDER BY created_at ASC',
      )
      .all([username]);

    if (existing.length > 1) {
      console.error(
        `[superadmin] "${username}" exists in ${existing.length} tenants — ` +
          'promote it from the database, or use a name that is unique',
      );
      for (const row of existing) {
        console.error(`  - tenant ${row.tenant_id}, role ${row.role}`);
      }
      process.exitCode = 1;
      return;
    }

    const hash = bcrypt.hashSync(String(password), 10);

    if (existing.length === 1) {
      const row = existing[0];
      if (row.role === SUPERADMIN_ROLE && row.tenant_id === ALL_TENANTS) {
        await db
          .prepare('UPDATE users SET password_hash = ?, is_active = 1 WHERE id = ?')
          .run(hash, row.id);
        console.log(`[superadmin] "${username}" is already a platform administrator — password reset`);
      } else if (!flags.has('promote')) {
        console.error(
          `[superadmin] "${username}" already exists in the tenant "${row.tenant_id}" ` +
            `with the role "${row.role}". Add --promote to make it a platform administrator.`,
        );
        process.exitCode = 1;
        return;
      } else {
        await db
          .prepare(
            'UPDATE users SET password_hash = ?, role = ?, tenant_id = ?, is_active = 1 WHERE id = ?',
          )
          .run(hash, SUPERADMIN_ROLE, ALL_TENANTS, row.id);
        console.log(
          `[superadmin] "${username}" is now a platform administrator ` +
            `(moved from the tenant "${row.tenant_id}")`,
        );
      }
    } else {
      await db
        .prepare(
          'INSERT INTO users (id, tenant_id, username, email, display_name, password_hash, role) ' +
            'VALUES (?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          nanoid(),
          ALL_TENANTS,
          username,
          values.email || null,
          values['display-name'] || null,
          hash,
          SUPERADMIN_ROLE,
        );
      console.log(`[superadmin] "${username}" is now a platform administrator`);
    }

    if (generated) {
      console.log(`[superadmin] password: ${password}`);
      console.log('[superadmin] it is printed once and only its hash is stored — save it now');
    }
    console.log('[superadmin] sign in at /platform/login — the platform door');
  } finally {
    await db.pool.end();
  }
}

main().catch((error) => {
  console.error('[superadmin] failed:', error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
