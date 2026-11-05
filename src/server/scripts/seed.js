'use strict';

/**
 * Seed and repair script.
 *
 * The server seeds itself on boot, so this script is for the cases where
 * that is not enough:
 *
 *   npm run seed              — bring a fresh database up to date (idempotent)
 *   npm run seed:force        — wipe the sample assets and generate them again
 *
 * `--force` is destructive: it deletes every asset row and the files behind
 * it. It is only meant for a library whose files are already gone (a wiped
 * `storage/` directory) or for regenerating the demo library.
 *
 * The script talks to the same MySQL server the application uses — the
 * `DB_*` values from `.env`, or the defaults in `src/server/config.js`.
 */

const path = require('path');
const fs = require('fs');

require('dotenv').config({ path: path.join(__dirname, '..', '..', '..', '.env') });

const { getConfig } = require('../config');
const { connect } = require('../lib/db');
const { initSchema } = require('../lib/schema');
const { seedDatabase, seedSampleAssets } = require('../lib/seed');

/** The directories under the storage root that hold asset files. */
const STORAGE_SUBDIRS = ['originals', 'thumbnails', 'previews', 'placeholders', 'tmp'];

/**
 * Remove every asset, both the rows and the files behind them.
 *
 * A row whose file is already gone is not an error — that is exactly the
 * state this script exists to repair.
 *
 * @param {object} db
 * @param {string} storageDir
 * @returns {Promise<{rows: number, files: number}>} what was removed
 */
async function removeAllAssets(db, storageDir) {
  const rows = await db.prepare('SELECT id, storage_path, thumbnail_path FROM assets').all();
  let removedFiles = 0;

  for (const row of rows) {
    for (const relative of [row.storage_path, row.thumbnail_path]) {
      if (!relative) continue;
      const absolute = path.isAbsolute(relative) ? relative : path.join(storageDir, relative);
      try {
        if (fs.existsSync(absolute)) {
          fs.rmSync(absolute, { force: true });
          removedFiles += 1;
        }
      } catch (error) {
        console.warn(`[seed] could not remove ${absolute}: ${error.message}`);
      }
    }
  }

  await db.prepare('DELETE FROM assets').run();
  return { rows: rows.length, files: removedFiles };
}

/**
 * Empty the storage directories that hold generated files.
 *
 * @param {string} storageDir
 * @returns {number} how many files were removed
 */
function clearStorageDirs(storageDir) {
  let removed = 0;
  for (const subdir of STORAGE_SUBDIRS) {
    const target = path.join(storageDir, subdir);
    if (!fs.existsSync(target)) continue;
    for (const entry of fs.readdirSync(target)) {
      const absolute = path.join(target, entry);
      try {
        if (fs.statSync(absolute).isFile()) {
          fs.rmSync(absolute, { force: true });
          removed += 1;
        }
      } catch (error) {
        console.warn(`[seed] could not remove ${absolute}: ${error.message}`);
      }
    }
  }
  return removed;
}

/**
 * Run the seed.
 *
 * @returns {Promise<void>}
 */
async function main() {
  const isForce = process.argv.includes('--force');
  const config = getConfig();

  console.log(`[seed] database: ${config.dbUser}@${config.dbHost}:${config.dbPort}/${config.dbName}`);
  console.log(`[seed] storage:  ${config.storageDir}`);

  fs.mkdirSync(config.storageDir, { recursive: true });
  for (const subdir of STORAGE_SUBDIRS) {
    fs.mkdirSync(path.join(config.storageDir, subdir), { recursive: true });
  }

  const db = await connect(config);

  try {
    await initSchema(db);

    if (isForce) {
      const removed = await removeAllAssets(db, config.storageDir);
      const cleared = clearStorageDirs(config.storageDir);
      console.log(`[seed] removed ${removed.rows} asset row(s) and ${removed.files + cleared} file(s)`);
    }

    // The basic rows (admin, categories, tags) are inserted
    // only when their table is empty, so this never duplicates anything.
    await seedDatabase(db, config.storageDir, { skipSamples: true });

    const assetCount = await db.prepare('SELECT COUNT(*) AS c FROM assets').get();
    if (assetCount.c === 0) {
      if (config.seedSampleAssets) {
        await seedSampleAssets(db, config.storageDir);
        console.log('[seed] sample assets generated');
      } else {
        console.log('[seed] sample assets skipped (set SEED_SAMPLE_ASSETS=1 to generate them)');
      }
    } else {
      console.log(`[seed] library already holds ${assetCount.c} asset(s) — nothing to generate`);
    }

    const users = await db.prepare('SELECT COUNT(*) AS c FROM users').get();
    const apiKeys = await db.prepare('SELECT COUNT(*) AS c FROM api_keys').get();
    const assets = await db.prepare('SELECT COUNT(*) AS c FROM assets').get();
    console.log(`[seed] users: ${users.c}, api keys: ${apiKeys.c}, assets: ${assets.c}`);
    console.log('[seed] done');
  } finally {
    await db.pool.end();
  }
}

main().catch((error) => {
  console.error('[seed] failed:', error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
