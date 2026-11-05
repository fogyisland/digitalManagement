'use strict';

/**
 * First-boot seeding.
 *
 * A fresh installation needs a tenant to hang everything from, an
 * administrator to log in as, the starter categories and tags, and (unless
 * it is turned off) a handful of sample images so the library is not empty
 * on the first visit. API keys are not seeded: the only source of one is
 * `POST /api/v1/api-keys`, so nothing hands out a secret nobody asked for.
 *
 * Nothing here overwrites existing data. Every block checks its own table
 * first, so restarting the server never duplicates or resets anything.
 *
 * This module is split out of `schema.js` for size only: the DDL lives
 * there, the data lives here.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { nanoid } = require('nanoid');
const { getConfig } = require('../config');
const { DEFAULT_TENANT_ID } = require('./tenant-schema');

/**
 * Seed the minimum data a fresh installation needs to be usable.
 *
 * @param {object} db
 * @param {string} storageDir
 * @param {{skipSamples?: boolean, tenantId?: string}} [options]
 *   `skipSamples` leaves the sample images alone — the seed script generates
 *   them itself so it can wait for them instead of letting them finish in
 *   the background. `tenantId` names the tenant the seed data belongs to;
 *   it defaults to the tenant an upgraded installation lands in.
 * @returns {Promise<void>}
 */
async function seedDatabase(db, storageDir, options = {}) {
  const tenantId = options.tenantId || (await resolveSeedTenant(db));

  // The tenant must exist before any row is written, because every business
  // table's `tenant_id` points at it.
  const tenantCount = await db
    .prepare('SELECT COUNT(*) AS c FROM tenants WHERE id = ?')
    .get([tenantId]);
  if (tenantCount.c === 0) {
    await db
      .prepare('INSERT INTO tenants (id, name, slug, status) VALUES (?, ?, ?, ?)')
      .run([tenantId, '默认租户', tenantId, 'active']);
    console.log('[seed] default tenant created');
  }

  // Every block below is scoped to the tenant, and writes the tenant
  // explicitly. A row that relies on the column's `DEFAULT` would have its
  // owner decided by the DDL rather than by the seed.
  await seedAdmin(db, tenantId);
  await seedCatalogue(db, tenantId);

  const assetCount = await db
    .prepare('SELECT COUNT(*) AS c FROM assets WHERE tenant_id = ?')
    .get([tenantId]);
  if (assetCount.c === 0 && getConfig().seedSampleAssets && !options.skipSamples) {
    await seedSampleAssets(db, storageDir, tenantId).catch((error) => {
      console.warn('[seed] sample assets failed:', error.message);
    });
  }
}

/**
 * Which tenant the seed writes into when the caller did not name one.
 *
 * On an upgraded installation that is the migration's `default` tenant. On
 * one the setup wizard created, it is the tenant the operator named — the
 * boot must seed *that* tenant, not add a second one beside it.
 *
 * @param {object} db
 * @returns {Promise<string>}
 */
async function resolveSeedTenant(db) {
  const existing = await db
    .prepare('SELECT id FROM tenants ORDER BY created_at ASC LIMIT 1')
    .get();
  return existing ? existing.id : DEFAULT_TENANT_ID;
}

/**
 * Create the default administrator if the tenant has none.
 *
 * @param {object} db
 * @param {string} tenantId
 * @returns {Promise<void>}
 */
async function seedAdmin(db, tenantId) {
  const adminCount = await db
    .prepare('SELECT COUNT(*) AS c FROM users WHERE tenant_id = ?')
    .get([tenantId]);
  if (adminCount.c > 0) return;
  await db
    .prepare(
      'INSERT INTO users (id, tenant_id, username, email, password_hash, role) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .run([
      nanoid(),
      tenantId,
      'admin',
      'admin@dam.local',
      bcrypt.hashSync('Admin@123456', 10),
      'admin',
    ]);
  console.log('[seed] default admin: admin / Admin@123456');
}

/**
 * Create the starter categories and tags.
 *
 * Each table is counted and seeded on its own. One gate over the two of
 * them would make a failure in the category insert lock the tags out for
 * good: the categories would be there, so the gate would answer "done" on
 * every later boot. Each table's rows go in inside one transaction, so a
 * partial insert rolls back instead of leaving half a catalogue behind;
 * a table that already holds rows is still left alone, so a default the
 * operator deleted does not come back on the next boot.
 *
 * @param {object} db
 * @param {string} tenantId
 * @returns {Promise<void>}
 */
async function seedCatalogue(db, tenantId) {
  const categories = [
    { name: '产品图', slug: 'product' },
    { name: '营销素材', slug: 'marketing' },
    { name: 'AI 生成', slug: 'ai-generated' },
    { name: '视频', slug: 'video' },
  ];

  const categoryCount = await db
    .prepare('SELECT COUNT(*) AS c FROM categories WHERE tenant_id = ?')
    .get([tenantId]);
  if (categoryCount.c === 0) {
    await db.transaction(async (tx) => {
      for (const category of categories) {
        await tx
          .prepare('INSERT INTO categories (id, tenant_id, name, slug) VALUES (?, ?, ?, ?)')
          .run([nanoid(), tenantId, category.name, category.slug]);
      }
    });
    console.log('[seed] default categories created');
  }

  const tags = ['封面', '海报', '人物', '风景', '抽象', '品牌', 'SVG', '动效'];

  const tagCount = await db
    .prepare('SELECT COUNT(*) AS c FROM tags WHERE tenant_id = ?')
    .get([tenantId]);
  if (tagCount.c === 0) {
    await db.transaction(async (tx) => {
      for (const tag of tags) {
        await tx
          .prepare('INSERT INTO tags (id, tenant_id, name, slug) VALUES (?, ?, ?, ?)')
          .run([nanoid(), tenantId, tag, tag.toLowerCase()]);
      }
    });
    console.log('[seed] default tags created');
  }
}

/** The gradient cards a fresh installation gets. */
const SAMPLE_DEFS = [
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

/**
 * Draw one gradient card and write it out as a PNG.
 *
 * @param {{color1: string, color2: string, label: string}} def
 * @param {number} index
 * @returns {Promise<Buffer>}
 */
function renderSampleSvg(def, index) {
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
  return Buffer.from(svg);
}

/**
 * Create the sample images so a fresh install is not an empty library.
 *
 * @param {object} db
 * @param {string} storageDir
 * @param {string} [tenantId] the tenant the samples belong to
 * @returns {Promise<void>}
 */
async function seedSampleAssets(db, storageDir, tenantId = DEFAULT_TENANT_ID) {
  try {
    const sharp = require('sharp');
    const categories = await db
      .prepare('SELECT id, slug FROM categories WHERE tenant_id = ?')
      .all([tenantId]);
    const categoryBySlug = Object.fromEntries(categories.map((c) => [c.slug, c.id]));

    for (let index = 0; index < SAMPLE_DEFS.length; index += 1) {
      const def = SAMPLE_DEFS[index];
      const buffer = await sharp(renderSampleSvg(def, index)).png().toBuffer();
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
          `INSERT INTO assets (id, tenant_id, title, filename, original_name, mime_type, file_size, file_hash, asset_type,
             width, height, storage_path, thumbnail_path, status, source, category_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run([
          id,
          tenantId,
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
    console.log(`[seed] ${SAMPLE_DEFS.length} sample assets created`);
  } catch (error) {
    console.warn('[seed] sample assets failed:', error.message);
  }
}

module.exports = { seedDatabase, seedSampleAssets, SAMPLE_DEFS };
