'use strict';

/**
 * Database schema, idempotent migrations and first-boot seeding.
 *
 * This module owns every SQL statement the server runs against a fresh or an
 * existing database. `server.js` only wires it into the app lifecycle.
 *
 * Migrations are written as "add the column if it is missing" rather than
 * "ALTER unconditionally": MySQL 5.7 has no `ADD COLUMN IF NOT EXISTS`, and
 * running a plain ALTER on every boot crashes the second boot with
 * `ER_DUP_FIELDNAME`. We deliberately do NOT wrap these in try/catch — that
 * would silently swallow real errors such as a permissions problem.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { nanoid } = require('nanoid');
const { getConfig } = require('../config');
const { ensureColumns, existingIndexes } = require('./db');
const {
  DEFAULT_TENANT_ID,
  TENANT_ID_COLUMN,
  TENANT_SCOPED_TABLES,
  TENANT_UNIQUE_KEYS,
  tenantUniqueKeyName,
  migrateToMultiTenant,
} = require('./tenant-schema');

/**
 * The character set and collation every table uses.
 *
 * `DEFAULT CHARSET=` is the table-option form MySQL expects; a bare
 * `utf8mb4` there is a parse error.
 */
const CHARSET = 'DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci';

/**
 * The primary key type.
 *
 * The ids are nanoid strings, so a fixed-width `VARCHAR` is both smaller
 * than `TEXT` and indexable — MySQL cannot index a `TEXT` column without a
 * prefix length.
 */
const ID = 'VARCHAR(64)';

/** A timestamp column. `DATETIME` with a `CURRENT_TIMESTAMP` default. */
const TIMESTAMP = 'DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP';

/** Columns added to `assets` after the initial release. */
const ASSETS_COLUMN_DEFS = [
  'source_tool TEXT',
  'prompt TEXT',
  'seed BIGINT',
  'model_name VARCHAR(191)',
  'job_id VARCHAR(64)',
  'metadata_json TEXT',
  'deleted_at DATETIME',
];

/** Columns added to `users` after the initial release. */
const USERS_COLUMN_DEFS = ['display_name VARCHAR(191)', 'last_login_at DATETIME'];

/** Columns added to `webhook_endpoints` after the initial release. */
const WEBHOOK_ENDPOINTS_COLUMN_DEFS = ['events TEXT'];

/**
 * The `tenants` table — the first table, because every other table's rows
 * point at one of its rows.
 */
const TENANTS_TABLE_SQL = `CREATE TABLE IF NOT EXISTS tenants (
  id ${ID} NOT NULL PRIMARY KEY,
  name VARCHAR(191) NOT NULL,
  slug VARCHAR(191) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'active',
  settings_json TEXT,
  created_at ${TIMESTAMP},
  UNIQUE KEY uq_tenants_slug (slug)
) ENGINE=InnoDB ${CHARSET}`;

/**
 * The statements that create the schema, in dependency order.
 *
 * A fresh database is created *already tenant-scoped*: every business table
 * carries `tenant_id` and every unique key is composite over
 * `(tenant_id, …)`. The ALTER-based migration in `tenant-schema.js` is only
 * needed for a database that was created before the multi-tenant release —
 * building the tables twice would cost a table rebuild per table on every
 * fresh install.
 */
const BASE_SCHEMA_SQL = [
  TENANTS_TABLE_SQL,

  `CREATE TABLE IF NOT EXISTS users (
  id ${ID} NOT NULL PRIMARY KEY,
  ${TENANT_ID_COLUMN},
  username VARCHAR(191) NOT NULL,
  email VARCHAR(191),
  password_hash VARCHAR(191) NOT NULL,
  role VARCHAR(32) NOT NULL DEFAULT 'viewer',
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at ${TIMESTAMP},
  UNIQUE KEY ${tenantUniqueKeyName('users', 'username')} (tenant_id, username)
) ENGINE=InnoDB ${CHARSET}`,

  `CREATE TABLE IF NOT EXISTS categories (
  id ${ID} NOT NULL PRIMARY KEY,
  ${TENANT_ID_COLUMN},
  name VARCHAR(191) NOT NULL,
  slug VARCHAR(191) NOT NULL,
  parent_id ${ID},
  description TEXT,
  sort_order INT NOT NULL DEFAULT 0,
  created_at ${TIMESTAMP},
  UNIQUE KEY ${tenantUniqueKeyName('categories', 'name')} (tenant_id, name),
  UNIQUE KEY ${tenantUniqueKeyName('categories', 'slug')} (tenant_id, slug)
) ENGINE=InnoDB ${CHARSET}`,

  `CREATE TABLE IF NOT EXISTS tags (
  id ${ID} NOT NULL PRIMARY KEY,
  ${TENANT_ID_COLUMN},
  name VARCHAR(191) NOT NULL,
  slug VARCHAR(191) NOT NULL,
  color VARCHAR(32),
  usage_count INT NOT NULL DEFAULT 0,
  created_at ${TIMESTAMP},
  UNIQUE KEY ${tenantUniqueKeyName('tags', 'name')} (tenant_id, name),
  UNIQUE KEY ${tenantUniqueKeyName('tags', 'slug')} (tenant_id, slug)
) ENGINE=InnoDB ${CHARSET}`,

  `CREATE TABLE IF NOT EXISTS assets (
  id ${ID} NOT NULL PRIMARY KEY,
  ${TENANT_ID_COLUMN},
  title VARCHAR(191) NOT NULL,
  description TEXT,
  filename VARCHAR(255) NOT NULL,
  original_name VARCHAR(255) NOT NULL,
  mime_type VARCHAR(191) NOT NULL,
  file_size BIGINT NOT NULL,
  file_hash VARCHAR(191) NOT NULL,
  asset_type VARCHAR(32) NOT NULL,
  category_id ${ID},
  width INT,
  height INT,
  duration DOUBLE,
  storage_path VARCHAR(255) NOT NULL,
  thumbnail_path VARCHAR(255),
  status VARCHAR(32) NOT NULL DEFAULT 'ready',
  uploaded_by ${ID},
  source VARCHAR(32) NOT NULL DEFAULT 'admin',
  created_at ${TIMESTAMP},
  updated_at ${TIMESTAMP} ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB ${CHARSET}`,

  `CREATE TABLE IF NOT EXISTS asset_tags (
  ${TENANT_ID_COLUMN},
  asset_id ${ID} NOT NULL,
  tag_id ${ID} NOT NULL,
  PRIMARY KEY (tenant_id, asset_id, tag_id),
  KEY idx_asset_tags_tag (tag_id)
) ENGINE=InnoDB ${CHARSET}`,

  `CREATE TABLE IF NOT EXISTS api_keys (
  id ${ID} NOT NULL PRIMARY KEY,
  ${TENANT_ID_COLUMN},
  name VARCHAR(191) NOT NULL,
  key_prefix VARCHAR(32) NOT NULL,
  key_hash VARCHAR(191) NOT NULL,
  scopes VARCHAR(255) NOT NULL DEFAULT 'read,upload',
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  last_used_at DATETIME,
  expires_at DATETIME,
  created_at ${TIMESTAMP},
  UNIQUE KEY ${tenantUniqueKeyName('api_keys', 'key_hash')} (tenant_id, key_hash)
) ENGINE=InnoDB ${CHARSET}`,

  `CREATE TABLE IF NOT EXISTS audit_logs (
  id ${ID} NOT NULL PRIMARY KEY,
  ${TENANT_ID_COLUMN},
  user_id ${ID},
  action VARCHAR(191) NOT NULL,
  resource_type VARCHAR(191) NOT NULL,
  resource_id VARCHAR(191),
  details TEXT,
  ip_address VARCHAR(64),
  created_at ${TIMESTAMP}
) ENGINE=InnoDB ${CHARSET}`,

  `CREATE TABLE IF NOT EXISTS webhook_endpoints (
  id ${ID} NOT NULL PRIMARY KEY,
  ${TENANT_ID_COLUMN},
  name VARCHAR(191) NOT NULL,
  url VARCHAR(1024) NOT NULL,
  secret VARCHAR(191) NOT NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  events TEXT,
  created_at ${TIMESTAMP}
) ENGINE=InnoDB ${CHARSET}`,

  `CREATE TABLE IF NOT EXISTS webhook_logs (
  id ${ID} NOT NULL PRIMARY KEY,
  ${TENANT_ID_COLUMN},
  endpoint_id ${ID} NOT NULL,
  event VARCHAR(191) NOT NULL,
  payload TEXT NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'pending',
  attempts INT NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at ${TIMESTAMP}
) ENGINE=InnoDB ${CHARSET}`,

  `CREATE TABLE IF NOT EXISTS manifest_writes (
  id ${ID} NOT NULL PRIMARY KEY,
  ${TENANT_ID_COLUMN},
  asset_id ${ID},
  op VARCHAR(32) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'pending',
  attempts INT NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at ${TIMESTAMP}
) ENGINE=InnoDB ${CHARSET}`,

  `CREATE TABLE IF NOT EXISTS revoked_tokens (
  jti ${ID} NOT NULL PRIMARY KEY,
  ${TENANT_ID_COLUMN},
  expires_at DATETIME,
  created_at ${TIMESTAMP}
) ENGINE=InnoDB ${CHARSET}`,

  `CREATE TABLE IF NOT EXISTS token_registry (
  jti ${ID} NOT NULL PRIMARY KEY,
  ${TENANT_ID_COLUMN},
  user_id ${ID},
  kind VARCHAR(32),
  expires_at DATETIME
) ENGINE=InnoDB ${CHARSET}`,

  `CREATE TABLE IF NOT EXISTS upload_sessions (
  id ${ID} NOT NULL PRIMARY KEY,
  ${TENANT_ID_COLUMN},
  owner_id ${ID},
  filename VARCHAR(255) NOT NULL,
  file_size BIGINT NOT NULL,
  mime_type VARCHAR(191),
  file_hash VARCHAR(191),
  chunk_size BIGINT NOT NULL,
  total_chunks INT NOT NULL,
  received_chunks TEXT NOT NULL,
  title VARCHAR(191),
  description TEXT,
  category_id ${ID},
  tag_names TEXT,
  status VARCHAR(32) NOT NULL DEFAULT 'pending',
  expires_at DATETIME,
  created_at ${TIMESTAMP},
  updated_at ${TIMESTAMP} ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB ${CHARSET}`,
];

/**
 * The indexes, created only when they are missing.
 *
 * `source_tool` is a TEXT column, and MySQL cannot index a TEXT column
 * without a prefix length — hence the `(191)`.
 */
const INDEX_DEFS = [
  ['idx_assets_hash', 'assets (file_hash)'],
  ['idx_assets_type', 'assets (asset_type)'],
  ['idx_assets_created', 'assets (created_at)'],
  ['idx_assets_job_id', 'assets (job_id)'],
  ['idx_assets_source_tool', 'assets (source_tool(191))'],
  ['idx_assets_status', 'assets (status)'],
  ['idx_asset_tags_tag', 'asset_tags (tag_id)'],
];

/**
 * Create the indexes that are missing.
 *
 * @param {object} db
 * @returns {Promise<void>}
 */
async function ensureIndexes(db) {
  for (const [name, target] of INDEX_DEFS) {
    const table = target.split(' ')[0];
    const existing = await existingIndexes(db, table);
    if (existing.has(name)) continue;
    await db.exec(`CREATE INDEX ${name} ON ${target}`);
  }
}

/**
 * Create the schema and bring an existing database up to date.
 *
 * @param {object} db
 * @returns {Promise<void>}
 */
async function initSchema(db) {
  for (const sql of BASE_SCHEMA_SQL) {
    await db.exec(sql);
  }
  await ensureColumns(db, 'assets', ASSETS_COLUMN_DEFS);
  await ensureColumns(db, 'users', USERS_COLUMN_DEFS);
  await ensureColumns(db, 'webhook_endpoints', WEBHOOK_ENDPOINTS_COLUMN_DEFS);
  await ensureIndexes(db);
  // The tenant layer comes last: the columns have to exist before the
  // composite unique keys and the composite primary key can reference them.
  await migrateToMultiTenant(db);
}

/**
 * Seed the minimum data a fresh installation needs to be usable.
 *
 * Nothing here overwrites existing data — every block checks its own table
 * first, so restarting the server never duplicates or resets anything.
 *
 * @param {object} db
 * @param {string} storageDir
 * @param {{skipSamples?: boolean}} [options] `skipSamples` leaves the sample
 *   images alone — the seed script generates them itself so it can wait for
 *   them instead of letting them finish in the background.
 * @returns {Promise<void>}
 */
async function seedDatabase(db, storageDir, options = {}) {
  // The default tenant is the one an existing single-tenant installation
  // belongs to. It must exist before any row is written, because every
  // business table's `tenant_id` points at it.
  const tenantCount = await db
    .prepare('SELECT COUNT(*) AS c FROM tenants WHERE id = ?')
    .get([DEFAULT_TENANT_ID]);
  if (tenantCount.c === 0) {
    await db
      .prepare('INSERT INTO tenants (id, name, slug) VALUES (?, ?, ?)')
      .run([DEFAULT_TENANT_ID, '默认租户', DEFAULT_TENANT_ID]);
    console.log('[seed] default tenant created');
  }

  const adminCount = await db.prepare('SELECT COUNT(*) AS c FROM users').get();
  if (adminCount.c === 0) {
    const adminId = nanoid();
    await db
      .prepare(
        'INSERT INTO users (id, username, email, password_hash, role) VALUES (?, ?, ?, ?, ?)',
      )
      .run([adminId, 'admin', 'admin@dam.local', bcrypt.hashSync('Admin@123456', 10), 'admin']);
    console.log('[seed] default admin: admin / Admin@123456');
  }

  const apiKeyCount = await db.prepare('SELECT COUNT(*) AS c FROM api_keys').get();
  if (apiKeyCount.c === 0) {
    const rawKey = `dam_${crypto.randomBytes(24).toString('hex')}`;
    const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');
    await db
      .prepare(
        'INSERT INTO api_keys (id, name, key_prefix, key_hash, scopes) VALUES (?, ?, ?, ?, ?)',
      )
      .run([nanoid(), 'Demo Key', rawKey.slice(0, 12), keyHash, 'read,upload,delete']);
    console.log('[seed] demo api key:', rawKey);
  }

  const categoryCount = await db.prepare('SELECT COUNT(*) AS c FROM categories').get();
  if (categoryCount.c === 0) {
    const categories = [
      { name: '产品图', slug: 'product' },
      { name: '营销素材', slug: 'marketing' },
      { name: 'AI 生成', slug: 'ai-generated' },
      { name: '视频', slug: 'video' },
    ];
    for (const category of categories) {
      await db
        .prepare('INSERT INTO categories (id, name, slug) VALUES (?, ?, ?)')
        .run([nanoid(), category.name, category.slug]);
    }

    const tags = ['封面', '海报', '人物', '风景', '抽象', '品牌', 'SVG', '动效'];
    for (const tag of tags) {
      await db.prepare('INSERT INTO tags (id, name, slug) VALUES (?, ?, ?)').run([
        nanoid(),
        tag,
        tag.toLowerCase(),
      ]);
    }
    console.log('[seed] default categories + tags created');
  }

  const assetCount = await db.prepare('SELECT COUNT(*) AS c FROM assets').get();
  if (assetCount.c === 0 && getConfig().seedSampleAssets && !options.skipSamples) {
    await seedSampleAssets(db, storageDir).catch((e) => {
      console.warn('[seed] sample assets failed:', e.message);
    });
  }
}

/**
 * Create a handful of generated sample images so a fresh install is not an
 * empty library.
 *
 * @param {object} db
 * @param {string} storageDir
 * @returns {Promise<void>}
 */
async function seedSampleAssets(db, storageDir) {
  try {
    const sharp = require('sharp');
    const sampleDefs = [
      { title: '梦幻渐变封面', color1: '#5b8cff', color2: '#a78bfa', label: 'Cover' },
      { title: '日出海报', color1: '#fbbf24', color2: '#f87171', label: 'Sunrise' },
      { title: '森林绿', color1: '#34d399', color2: '#0d9488', label: 'Forest' },
      { title: '深海蓝', color1: '#0ea5e9', color2: '#1e3a8a', label: 'Ocean' },
      { title: '极光紫', color1: '#c084fc', color2: '#7c3aed', label: 'Aurora' },
      { title: '黄昏橙', color1: '#fb923c', color2: '#dc2626', label: 'Dusk' },
      { title: '静谧灰', color1: '#64748b', color2: '#1e293b', label: 'Slate' },
      { title: '樱花粉', color1: '#fda4af', color2: '#f43f5e', label: 'Sakura' },
      { title: '薄荷绿', color1: '#6ee7b7', color2: '#10b981', label: 'Mint' },
      { title: '银河黑', color1: '#475569', color2: '#020617', label: 'Galaxy' },
      { title: '霓虹青', color1: '#22d3ee', color2: '#0891b2', label: 'Neon' },
      { title: '焦糖棕', color1: '#d97706', color2: '#78350f', label: 'Caramel' },
    ];
    const categories = await db.prepare('SELECT id, slug FROM categories').all();
    const categoryBySlug = Object.fromEntries(categories.map((c) => [c.slug, c.id]));

    for (let index = 0; index < sampleDefs.length; index += 1) {
      const def = sampleDefs[index];
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024">
          <defs>
            <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0" stop-color="${def.color1}"/>
              <stop offset="1" stop-color="${def.color2}"/>
            </linearGradient>
          </defs>
          <rect width="1024" height="1024" fill="url(#g)"/>
          <circle cx="512" cy="380" r="160" fill="rgba(255,255,255,0.18)"/>
          <circle cx="700" cy="600" r="100" fill="rgba(255,255,255,0.12)"/>
          <text x="512" y="540" text-anchor="middle" font-family="sans-serif" font-size="80" font-weight="700" fill="rgba(255,255,255,0.95)">${def.label}</text>
          <text x="512" y="620" text-anchor="middle" font-family="sans-serif" font-size="32" fill="rgba(255,255,255,0.7)">DAM Sample #${index + 1}</text>
        </svg>`;
      const buffer = await sharp(Buffer.from(svg)).png().toBuffer();
      const id = nanoid();
      const storageName = `${id}.png`;
      const storagePath = path.join('originals', storageName);
      fs.mkdirSync(path.join(storageDir, 'originals'), { recursive: true });
      fs.mkdirSync(path.join(storageDir, 'thumbnails'), { recursive: true });
      fs.writeFileSync(path.join(storageDir, storagePath), buffer);
      const thumbnailPath = path.join('thumbnails', `${id}.webp`);
      await sharp(buffer)
        .resize(400, 400, { fit: 'cover' })
        .webp({ quality: 82 })
        .toFile(path.join(storageDir, thumbnailPath));
      const hash = crypto.createHash('sha256').update(buffer).digest('hex');
      const meta = await sharp(buffer).metadata();
      const categoryId =
        categoryBySlug[index % 2 === 0 ? 'ai-generated' : 'marketing'] ||
        categoryBySlug['ai-generated'];

      await db
        .prepare(
          `INSERT INTO assets (id, title, filename, original_name, mime_type, file_size, file_hash, asset_type,
             width, height, storage_path, thumbnail_path, status, source, category_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run([
          id,
          def.title,
          storageName,
          `${def.label.toLowerCase()}.png`,
          'image/png',
          buffer.length,
          hash,
          'image',
          meta.width,
          meta.height,
          storagePath,
          thumbnailPath,
          'ready',
          'seed',
          categoryId,
        ]);
    }
    console.log(`[seed] ${sampleDefs.length} sample assets created`);
  } catch (e) {
    console.warn('[seed] sample assets failed:', e.message);
  }
}

module.exports = {
  initSchema,
  seedDatabase,
  seedSampleAssets,
  ASSETS_COLUMN_DEFS,
  USERS_COLUMN_DEFS,
  TENANTS_TABLE_SQL,
  TENANT_SCOPED_TABLES,
  TENANT_UNIQUE_KEYS,
  tenantUniqueKeyName,
  DEFAULT_TENANT_ID,
};
