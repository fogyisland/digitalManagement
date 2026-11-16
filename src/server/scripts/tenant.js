'use strict';

/**
 * The tenant command.
 *
 * A tenant is the boundary every row of the library belongs to. The setup
 * wizard creates the first one, and the seed creates the default one. The
 * platform administrator creates the rest — from the tenant management page,
 * or from this command when the instance is not reachable from a browser.
 *
 *   npm run tenant:create -- --name "Acme Corp"
 *   npm run tenant:create -- --name "Acme Corp" --slug acme --id acme
 *
 * The command and the API share one rule set (`lib/tenant-registry.js`), so a
 * tenant made here is exactly as valid as a tenant made in the interface.
 *
 * The id is what a request names in the `X-Tenant` header, so give it one
 * that reads well: `--id acme` makes `X-Tenant: acme` work, and so does the
 * slug or the name. When no id is given, it follows the slug — unless the
 * slug is not ASCII, which no header can carry, and then one is generated.
 */

const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '..', '..', '..', '.env') });

const { getConfig } = require('../config');
const { connect } = require('../lib/db');
const { initSchema } = require('../lib/schema');
const { createTenant } = require('../lib/tenant-registry');

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

  // The rules — what a slug may hold, when an id is generated, when a name is
  // too long — live in the registry, because the API enforces the same ones.
  const status = flags.has('suspended') ? 'suspended' : 'active';

  console.log(`[tenant] database: ${config.dbUser}@${config.dbHost}:${config.dbPort}/${config.dbName}`);

  const db = await connect(config);
  try {
    await initSchema(db);

    const created = await createTenant(db, {
      name,
      slug: values.slug,
      id: values.id,
      status,
    });

    console.log(
      `[tenant] "${created.name}" created — id "${created.id}", slug "${created.slug}", ` +
        `status ${created.status}`,
    );
    console.log('[tenant] a platform administrator may now act in it with:');
    console.log(`[tenant]   X-Tenant: ${created.id}`);
  } finally {
    await db.pool.end();
  }
}

main().catch((error) => {
  console.error('[tenant] failed:', error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
