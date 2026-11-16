'use strict';

/**
 * The tenant command.
 *
 * A tenant is the boundary every row of the library belongs to. The setup
 * wizard creates the first one, and the seed creates the default one — but
 * an installation that hosts more than one tenant has no way to add another:
 * there is no API for it, deliberately, because creating a tenant is the
 * platform administrator's call and the platform administrator is granted at
 * the console.
 *
 *   npm run tenant:create -- --name "Acme Corp"
 *   npm run tenant:create -- --name "Acme Corp" --slug acme --id acme
 *
 * The id is what a request names in the `X-Tenant` header, so give it one
 * that reads well: `--id acme` makes `X-Tenant: acme` work, and so does the
 * slug or the name.
 */

const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '..', '..', '..', '.env') });

const { nanoid } = require('nanoid');
const { getConfig } = require('../config');
const { connect } = require('../lib/db');
const { initSchema } = require('../lib/schema');
const { slugify } = require('../lib/util');

/** The longest id and slug the `tenants` table accepts. */
const MAX_KEY_LENGTH = 64;

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
 * Run the command.
 *
 * @returns {Promise<void>}
 */
async function main() {
  const { values, flags } = parseArgs(process.argv.slice(2));
  const name = String(values.name || '').trim();
  const config = getConfig();

  if (!name) {
    console.error('[tenant] a name is required: --name "<name>"');
    process.exitCode = 1;
    return;
  }

  const slug = String(values.slug || slugify(name)).trim();
  const id = String(values.id || slug).trim();

  if (!slug || slug.length > MAX_KEY_LENGTH) {
    console.error(`[tenant] the slug must be between 1 and ${MAX_KEY_LENGTH} characters`);
    process.exitCode = 1;
    return;
  }
  if (!id || id.length > MAX_KEY_LENGTH) {
    console.error(`[tenant] the id must be between 1 and ${MAX_KEY_LENGTH} characters`);
    process.exitCode = 1;
    return;
  }

  console.log(`[tenant] database: ${config.dbUser}@${config.dbHost}:${config.dbPort}/${config.dbName}`);

  const db = await connect(config);
  try {
    await initSchema(db);

    const existing = await db
      .prepare('SELECT id, name, slug, status FROM tenants WHERE id = ? OR slug = ?')
      .all([id, slug]);

    if (existing.length > 0) {
      const row = existing[0];
      console.error(
        `[tenant] a tenant with the id "${row.id}" (slug "${row.slug}") already exists — ` +
          'nothing was changed',
      );
      process.exitCode = 1;
      return;
    }

    const status = flags.has('suspended') ? 'suspended' : 'active';
    await db
      .prepare('INSERT INTO tenants (id, name, slug, status) VALUES (?, ?, ?, ?)')
      .run([id, name, slug, status]);

    console.log(`[tenant] "${name}" created — id "${id}", slug "${slug}", status ${status}`);
    console.log('[tenant] a platform administrator may now act in it with:');
    console.log(`[tenant]   X-Tenant: ${id}`);
  } finally {
    await db.pool.end();
  }
}

main().catch((error) => {
  console.error('[tenant] failed:', error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
