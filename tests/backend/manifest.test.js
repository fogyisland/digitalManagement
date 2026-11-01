'use strict';

/**
 * Manifest library test.
 *
 * The manifest writer reads the asset table and mirrors it into
 * `storage/manifests/index.json`. The test gives it a throw-away MySQL
 * schema with one asset in it and checks the JSON that comes out.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');
const mysql = require('mysql2/promise');

const { createDb, createPool } = require('../../src/server/lib/db');
const { getConfig } = require('../../src/server/config');

const ASSETS_TABLE = `CREATE TABLE assets (
  id VARCHAR(64) NOT NULL PRIMARY KEY,
  title VARCHAR(191),
  asset_type VARCHAR(32),
  file_size BIGINT,
  original_name VARCHAR(255),
  mime_type VARCHAR(191),
  width INT,
  height INT,
  duration DOUBLE,
  source_tool VARCHAR(191),
  prompt TEXT,
  seed BIGINT,
  model_name VARCHAR(191),
  job_id VARCHAR(64),
  metadata_json TEXT,
  created_at DATETIME,
  updated_at DATETIME,
  status VARCHAR(32) NOT NULL DEFAULT 'ready',
  thumbnail_path VARCHAR(255)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`;

const MANIFEST_TABLE = `CREATE TABLE manifest_writes (
  id VARCHAR(64) NOT NULL PRIMARY KEY,
  asset_id VARCHAR(64),
  op VARCHAR(32),
  status VARCHAR(32),
  attempts INT DEFAULT 0,
  last_error TEXT,
  created_at DATETIME
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`;

/**
 * Drop the throw-away schema.
 *
 * @param {object} config
 * @param {string} dbName
 * @returns {Promise<void>}
 */
async function dropSchema(config, dbName) {
  const connection = await mysql.createConnection({
    host: config.dbHost,
    port: config.dbPort,
    user: config.dbUser,
    password: config.dbPassword,
    charset: 'utf8mb4_unicode_ci',
  });
  try {
    await connection.query(`DROP DATABASE IF EXISTS \`${dbName}\``);
  } finally {
    await connection.end();
  }
}

async function main() {
  const config = getConfig();
  const dbName = `dam_test_manifest_${process.pid}`;

  await dropSchema(config, dbName);
  const connection = await mysql.createConnection({
    host: config.dbHost,
    port: config.dbPort,
    user: config.dbUser,
    password: config.dbPassword,
    charset: 'utf8mb4_unicode_ci',
  });
  try {
    await connection.query(
      `CREATE DATABASE \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    );
  } finally {
    await connection.end();
  }

  const db = createDb(createPool({ ...config, dbName }));

  try {
    await db.exec(ASSETS_TABLE);
    await db.exec(MANIFEST_TABLE);

    const manifest = require('../../src/server/lib/manifest');
    assert.strictEqual(typeof manifest.writeManifestIndex, 'function');
    console.log('manifest lib OK');

    const now = new Date().toISOString();
    await db
      .prepare(
        `INSERT INTO assets (id, title, asset_type, file_size, original_name, mime_type,
           width, height, duration, source_tool, prompt, seed, model_name, job_id,
           metadata_json, created_at, updated_at, status, thumbnail_path)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run([
        'a1',
        'Test',
        'image',
        1024,
        'a1.png',
        'image/png',
        1024,
        1024,
        null,
        'comfyui',
        'a cat',
        42,
        'sdxl',
        'job-1',
        null,
        now,
        now,
        'ready',
        null,
      ]);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mf2-'));
    const result = await manifest.writeManifestIndex(db, dir);
    assert.strictEqual(result.count, 1);

    const out = JSON.parse(fs.readFileSync(path.join(dir, 'manifests', 'index.json'), 'utf8'));
    assert.strictEqual(out.assets[0].id, 'a1');
    assert.strictEqual(out.assets[0].source_tool, 'comfyui');
    assert.strictEqual(out.assets[0].seed, 42);
    console.log('manifest write OK');

    fs.rmSync(dir, { recursive: true, force: true });
  } finally {
    await db.pool.end();
    await dropSchema(config, dbName);
  }
}

main().catch((error) => {
  console.error('TEST FAILED:', error && error.stack ? error.stack : error);
  process.exit(1);
});
