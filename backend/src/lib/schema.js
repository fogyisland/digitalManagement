'use strict';

/**
 * Database schema, idempotent migrations and first-boot seeding.
 *
 * This module owns every SQL statement the server runs against a fresh or an
 * existing database. `server.js` only wires it into the app lifecycle.
 *
 * Migrations are written as "add the column if it is missing" rather than
 * "ALTER unconditionally": better-sqlite3 has no `ADD COLUMN IF NOT EXISTS`,
 * and running a plain ALTER on every boot crashes the second boot with
 * `SqliteError: duplicate column name`. We deliberately do NOT wrap these in
 * try/catch — that would silently swallow real errors such as disk-full or
 * permission-denied.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { nanoid } = require('nanoid');
const { getConfig } = require('../config');

/** Columns added to `assets` after the initial release. */
const ASSETS_COLUMN_DEFS = [
  'source_tool TEXT',
  'prompt TEXT',
  'seed INTEGER',
  'model_name TEXT',
  'job_id TEXT',
  'metadata_json TEXT',
  'deleted_at TEXT',
];

/** Columns added to `users` after the initial release. */
const USERS_COLUMN_DEFS = ['display_name TEXT', 'last_login_at TEXT'];

/** Columns added to `webhook_endpoints` after the initial release. */
const WEBHOOK_ENDPOINTS_COLUMN_DEFS = ['events TEXT'];

const INDEX_SQL = [
  'CREATE INDEX IF NOT EXISTS idx_assets_hash ON assets(file_hash)',
  'CREATE INDEX IF NOT EXISTS idx_assets_type ON assets(asset_type)',
  'CREATE INDEX IF NOT EXISTS idx_assets_created ON assets(created_at)',
  'CREATE INDEX IF NOT EXISTS idx_assets_job_id ON assets(job_id)',
  'CREATE INDEX IF NOT EXISTS idx_assets_source_tool ON assets(source_tool)',
  'CREATE INDEX IF NOT EXISTS idx_assets_status ON assets(status)',
  'CREATE INDEX IF NOT EXISTS idx_asset_tags_tag ON asset_tags(tag_id)',
];

const BASE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  email TEXT,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'viewer',
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS categories (
  id TEXT PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  parent_id TEXT,
  description TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tags (
  id TEXT PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  color TEXT,
  usage_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS assets (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  filename TEXT NOT NULL,
  original_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  file_size INTEGER NOT NULL,
  file_hash TEXT NOT NULL,
  asset_type TEXT NOT NULL,
  category_id TEXT,
  width INTEGER,
  height INTEGER,
  duration REAL,
  storage_path TEXT NOT NULL,
  thumbnail_path TEXT,
  status TEXT NOT NULL DEFAULT 'ready',
  uploaded_by TEXT,
  source TEXT NOT NULL DEFAULT 'admin',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS asset_tags (
  asset_id TEXT NOT NULL,
  tag_id TEXT NOT NULL,
  PRIMARY KEY (asset_id, tag_id)
);

CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  key_prefix TEXT NOT NULL,
  key_hash TEXT NOT NULL,
  scopes TEXT NOT NULL DEFAULT 'read,upload',
  is_active INTEGER NOT NULL DEFAULT 1,
  last_used_at TEXT,
  expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  action TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT,
  details TEXT,
  ip_address TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS webhook_endpoints (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  secret TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  events TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS webhook_logs (
  id TEXT PRIMARY KEY,
  endpoint_id TEXT NOT NULL,
  event TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS manifest_writes (
  id TEXT PRIMARY KEY,
  asset_id TEXT,
  op TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS revoked_tokens (
  jti TEXT PRIMARY KEY,
  expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS token_registry (
  jti TEXT PRIMARY KEY,
  user_id TEXT,
  kind TEXT,
  expires_at TEXT
);

CREATE TABLE IF NOT EXISTS upload_sessions (
  id TEXT PRIMARY KEY,
  owner_id TEXT,
  filename TEXT NOT NULL,
  file_size INTEGER NOT NULL,
  mime_type TEXT,
  file_hash TEXT,
  chunk_size INTEGER NOT NULL,
  total_chunks INTEGER NOT NULL,
  received_chunks TEXT NOT NULL DEFAULT '[]',
  title TEXT,
  description TEXT,
  category_id TEXT,
  tag_names TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

/**
 * Add the missing columns of a table.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} table one of the hard-coded table names above
 * @param {string[]} columnDefs e.g. ["source_tool TEXT"]
 */
function ensureColumns(db, table, columnDefs) {
  const existing = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
  for (const def of columnDefs) {
    const columnName = def.split(/\s+/)[0];
    if (existing.has(columnName)) continue;
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${def}`);
    existing.add(columnName);
  }
}

/**
 * Create the schema and bring an existing database up to date.
 *
 * @param {import('better-sqlite3').Database} db
 */
function initSchema(db) {
  db.exec(BASE_SCHEMA_SQL);
  ensureColumns(db, 'assets', ASSETS_COLUMN_DEFS);
  ensureColumns(db, 'users', USERS_COLUMN_DEFS);
  ensureColumns(db, 'webhook_endpoints', WEBHOOK_ENDPOINTS_COLUMN_DEFS);
  for (const sql of INDEX_SQL) {
    db.exec(sql);
  }
}

/**
 * Seed the minimum data a fresh installation needs to be usable.
 *
 * Nothing here overwrites existing data — every block checks its own table
 * first, so restarting the server never duplicates or resets anything.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} storageDir
 */
function seedDatabase(db, storageDir) {
  const adminCount = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  if (adminCount === 0) {
    const adminId = nanoid();
    db.prepare(
      'INSERT INTO users (id, username, email, password_hash, role) VALUES (?, ?, ?, ?, ?)',
    ).run(adminId, 'admin', 'admin@dam.local', bcrypt.hashSync('Admin@123456', 10), 'admin');
    console.log('[seed] default admin: admin / Admin@123456');
  }

  const apiKeyCount = db.prepare('SELECT COUNT(*) AS c FROM api_keys').get().c;
  if (apiKeyCount === 0) {
    const rawKey = `dam_${crypto.randomBytes(24).toString('hex')}`;
    const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');
    db.prepare(
      'INSERT INTO api_keys (id, name, key_prefix, key_hash, scopes) VALUES (?, ?, ?, ?, ?)',
    ).run(nanoid(), 'Demo Key', rawKey.slice(0, 12), keyHash, 'read,upload,delete');
    console.log('[seed] demo api key:', rawKey);
  }

  const categoryCount = db.prepare('SELECT COUNT(*) AS c FROM categories').get().c;
  if (categoryCount === 0) {
    const categories = [
      { name: '产品图', slug: 'product' },
      { name: '营销素材', slug: 'marketing' },
      { name: 'AI 生成', slug: 'ai-generated' },
      { name: '视频', slug: 'video' },
    ];
    const insertCategory = db.prepare('INSERT INTO categories (id, name, slug) VALUES (?, ?, ?)');
    for (const category of categories) {
      insertCategory.run(nanoid(), category.name, category.slug);
    }

    const tags = ['封面', '海报', '人物', '风景', '抽象', '品牌', 'SVG', '动效'];
    const insertTag = db.prepare('INSERT INTO tags (id, name, slug) VALUES (?, ?, ?)');
    for (const tag of tags) {
      insertTag.run(nanoid(), tag, tag.toLowerCase());
    }
    console.log('[seed] default categories + tags created');
  }

  const assetCount = db.prepare('SELECT COUNT(*) AS c FROM assets').get().c;
  if (assetCount === 0 && getConfig().seedSampleAssets) {
    seedSampleAssets(db, storageDir).catch((e) => {
      console.warn('[seed] sample assets failed:', e.message);
    });
  }
}

/**
 * Create a handful of generated sample images so a fresh install is not an
 * empty library.
 *
 * @param {import('better-sqlite3').Database} db
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
    const categories = db.prepare('SELECT id, slug FROM categories').all();
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

      db.prepare(
        `INSERT INTO assets (id, title, filename, original_name, mime_type, file_size, file_hash, asset_type,
           width, height, storage_path, thumbnail_path, status, source, category_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
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
      );
    }
    console.log(`[seed] ${sampleDefs.length} sample assets created`);
  } catch (e) {
    console.warn('[seed] sample assets failed:', e.message);
  }
}

module.exports = { initSchema, seedDatabase, ASSETS_COLUMN_DEFS, USERS_COLUMN_DEFS };
