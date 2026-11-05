'use strict';

/**
 * Configuration reload.
 *
 * The init wizard writes .env and then rebinds the running application to
 * the database the operator just configured. The order matters: the seed
 * runs before the JWT secret is written, so a failure here leaves the
 * instance uninitialized and the wizard open.
 */

const { getConfig } = require('../config');
const { createPool, ensureDatabase } = require('./db');
const { initSchema } = require('./schema');
const { seedDatabase } = require('./seed');
const { applyEnvToProcess } = require('./init');
const { replayPendingManifestWrites, writeManifestIndex } = require('./manifest');

/**
 * Point the running application at the configuration in `envFile`.
 *
 * The steps follow the spec (§4.4):
 *
 *   1. remember the pool in use, so it can be drained last
 *   2. copy the wizard-owned keys of the file into the process
 *   3. read the configuration again — it reads the process environment
 *   4. make sure the database exists
 *   5. open a new pool
 *   6. rebind the handle to it
 *   7. bring the schema up to date
 *   8. seed what a fresh installation needs
 *   9. replay the manifest writes the previous instance left pending
 *  10. drain the previous pool
 *
 * Steps 7 and 8 run on the new pool (`db.rebind` already moved the
 * handle). The JWT secret is not written here: the wizard writes it after
 * the seed succeeds, so an instance that fails halfway stays uninitialized.
 *
 * @param {{db: object, envFile: string}} options
 * @returns {Promise<{ok: true}>}
 */
async function reloadConfiguration({ db, envFile }) {
  const previousPool = db.pool;

  applyEnvToProcess(envFile);

  const config = getConfig();

  await ensureDatabase(config);
  const nextPool = createPool(config);

  db.rebind(nextPool);

  await initSchema(db);
  await seedDatabase(db, config.storageDir);

  try {
    await replayPendingManifestWrites(db, config.storageDir);
    await writeManifestIndex(db, config.storageDir);
  } catch (error) {
    // The boot treats a failed manifest replay the same way: the library
    // is usable without it, and the next successful write repairs it.
    console.warn('[reload] manifest replay failed:', error.message);
  }

  if (previousPool && previousPool !== nextPool) {
    try {
      await previousPool.end();
    } catch (error) {
      // The new pool already answers every statement; a pool that refuses
      // to close must not fail the wizard step.
      console.warn('[reload] closing the previous pool failed:', error.message);
    }
  }

  return { ok: true };
}

module.exports = { reloadConfiguration };
