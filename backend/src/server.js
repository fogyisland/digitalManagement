/**
 * Digital Asset Management - Express server
 *
 * 单文件 MVP 版本，覆盖核心 API + 静态托管
 * - /api/v1/*  管理 API（JWT）
 * - /api/public/v1/*  投递 API（API Key）
 * - /storage/* 静态文件
 * - /* 前端构建产物（如果存在）
 */

'use strict';

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { nanoid } = require('nanoid');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const PORT = parseInt(process.env.PORT || '8000', 10);
const HOST = process.env.HOST || '0.0.0.0';
const JWT_SECRET = process.env.JWT_SECRET || 'dam-dev-secret-change-me-in-production';
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'dam.db');
const STORAGE_DIR = process.env.STORAGE_DIR || path.join(__dirname, '..', 'storage');
const ROOT_DIR = path.join(__dirname, '..', '..');

// --- Bootstrap ---
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
fs.mkdirSync(STORAGE_DIR, { recursive: true });
fs.mkdirSync(path.join(STORAGE_DIR, 'originals'), { recursive: true });
fs.mkdirSync(path.join(STORAGE_DIR, 'thumbnails'), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// --- Schema ---
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  email TEXT,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',
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

CREATE INDEX IF NOT EXISTS idx_assets_hash ON assets(file_hash);
CREATE INDEX IF NOT EXISTS idx_assets_type ON assets(asset_type);
CREATE INDEX IF NOT EXISTS idx_assets_created ON assets(created_at);

ALTER TABLE assets ADD COLUMN source_tool TEXT;
ALTER TABLE assets ADD COLUMN prompt TEXT;
ALTER TABLE assets ADD COLUMN seed INTEGER;
ALTER TABLE assets ADD COLUMN model_name TEXT;
ALTER TABLE assets ADD COLUMN job_id TEXT;
ALTER TABLE assets ADD COLUMN metadata_json TEXT;
CREATE INDEX IF NOT EXISTS idx_assets_job_id ON assets(job_id);
CREATE INDEX IF NOT EXISTS idx_assets_source_tool ON assets(source_tool);

CREATE TABLE IF NOT EXISTS webhook_endpoints (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  secret TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
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
`);

// --- Seed default admin + sample data ---
const adminCount = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
if (adminCount === 0) {
  const adminId = nanoid();
  db.prepare(
    'INSERT INTO users (id, username, email, password_hash, role) VALUES (?, ?, ?, ?, ?)'
  ).run(adminId, 'admin', 'admin@dam.local', bcrypt.hashSync('Admin@123456', 10), 'admin');
  console.log('[seed] default admin: admin / Admin@123456');
}

const apiKeyCount = db.prepare('SELECT COUNT(*) AS c FROM api_keys').get().c;
if (apiKeyCount === 0) {
  const rawKey = 'dam_' + crypto.randomBytes(24).toString('hex');
  const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');
  db.prepare(
    'INSERT INTO api_keys (id, name, key_prefix, key_hash, scopes) VALUES (?, ?, ?, ?, ?)'
  ).run(nanoid(), 'Demo Key', rawKey.slice(0, 12), keyHash, 'read,upload,delete');
  console.log('[seed] demo api key:', rawKey);
}

const categoryCount = db.prepare('SELECT COUNT(*) AS c FROM categories').get().c;
if (categoryCount === 0) {
  const cats = [
    { name: '产品图', slug: 'product' },
    { name: '营销素材', slug: 'marketing' },
    { name: 'AI 生成', slug: 'ai-generated' },
    { name: '视频', slug: 'video' },
  ];
  const insert = db.prepare('INSERT INTO categories (id, name, slug) VALUES (?, ?, ?)');
  cats.forEach((c) => insert.run(nanoid(), c.name, c.slug));

  const tags = ['封面', '海报', '人物', '风景', '抽象', '品牌', 'SVG', '动效'];
  const insertTag = db.prepare('INSERT INTO tags (id, name, slug) VALUES (?, ?, ?)');
  tags.forEach((t) => insertTag.run(nanoid(), t, t.toLowerCase()));
  console.log('[seed] default categories + tags created');
}

// Seed sample assets (so the UI is not empty on first run)
const assetCount = db.prepare('SELECT COUNT(*) AS c FROM assets').get().c;
if (assetCount === 0) {
  (async () => {
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
      const catBySlug = Object.fromEntries(categories.map((c) => [c.slug, c.id]));

      for (let i = 0; i < sampleDefs.length; i++) {
        const def = sampleDefs[i];
        // 1024x1024 gradient image with label
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
          <text x="512" y="620" text-anchor="middle" font-family="sans-serif" font-size="32" fill="rgba(255,255,255,0.7)">DAM Sample #${i + 1}</text>
        </svg>`;
        const buf = await sharp(Buffer.from(svg)).png().toBuffer();
        const id = nanoid();
        const ext = '.png';
        const storageName = `${id}${ext}`;
        const storagePath = `originals/${storageName}`;
        fs.writeFileSync(path.join(STORAGE_DIR, storagePath), buf);
        const thumbName = `${id}.webp`;
        const thumbPath = `thumbnails/${thumbName}`;
        await sharp(buf).resize(400, 400, { fit: 'cover' }).webp({ quality: 82 }).toFile(path.join(STORAGE_DIR, thumbPath));
        const hash = crypto.createHash('sha256').update(buf).digest('hex');
        const meta = await sharp(buf).metadata();

        const catId =
          catBySlug[i % 2 === 0 ? 'ai-generated' : 'marketing'] ||
          catBySlug['ai-generated'];

        db.prepare(
          `INSERT INTO assets (id, title, filename, original_name, mime_type, file_size, file_hash, asset_type,
             width, height, storage_path, thumbnail_path, status, source, category_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          id, def.title, storageName, `${def.label.toLowerCase()}.png`,
          'image/png', buf.length, hash, 'image',
          meta.width, meta.height, storagePath, thumbPath, 'ready', 'seed', catId
        );
      }
      console.log(`[seed] ${sampleDefs.length} sample assets created`);
    } catch (e) {
      console.warn('[seed] sample assets failed:', e.message);
    }
  })();
}

// --- App ---
const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

// Request log
app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

// --- Helpers ---
function slugify(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function generateApiKey() {
  const raw = 'dam_' + crypto.randomBytes(24).toString('hex');
  return { raw, hash: crypto.createHash('sha256').update(raw).digest('hex'), prefix: raw.slice(0, 12) };
}

function authRequired(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ detail: 'Missing token' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = db.prepare('SELECT id, username, role FROM users WHERE id = ?').get(payload.sub);
    if (!req.user) return res.status(401).json({ detail: 'User not found' });
    next();
  } catch (e) {
    return res.status(401).json({ detail: 'Invalid token' });
  }
}

function apiKeyRequired(requiredScope) {
  return (req, res, next) => {
    const provided = req.headers['x-api-key'] || req.query.api_key;
    if (!provided) return res.status(401).json({ detail: 'Missing API key' });
    const hash = crypto.createHash('sha256').update(provided).digest('hex');
    const key = db
      .prepare('SELECT * FROM api_keys WHERE key_hash = ? AND is_active = 1')
      .get(hash);
    if (!key) return res.status(401).json({ detail: 'Invalid API key' });
    if (key.expires_at && new Date(key.expires_at) < new Date()) {
      return res.status(401).json({ detail: 'API key expired' });
    }
    const scopes = (key.scopes || '').split(',').map((s) => s.trim());
    if (requiredScope && !scopes.includes(requiredScope) && !scopes.includes('*')) {
      return res.status(403).json({ detail: `Missing scope: ${requiredScope}` });
    }
    db.prepare("UPDATE api_keys SET last_used_at = datetime('now') WHERE id = ?").run(key.id);
    req.apiKey = key;
    next();
  };
}

// --- Health ---
app.get('/api/health', (_req, res) => res.json({ status: 'ok', service: 'dam' }));
app.get('/api/health/ready', (_req, res) => res.json({ status: 'ready', db: 'ok' }));

// --- Auth ---
app.post('/api/v1/auth/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ detail: 'username/password required' });
  const user = db.prepare('SELECT * FROM users WHERE username = ? AND is_active = 1').get(username);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ detail: 'Invalid credentials' });
  }
  const token = jwt.sign({ sub: user.id, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
  res.json({
    access_token: token,
    token_type: 'bearer',
    user: { id: user.id, username: user.username, email: user.email, role: user.role },
  });
});

app.get('/api/v1/auth/me', authRequired, (req, res) => res.json(req.user));

// --- Categories ---
app.get('/api/v1/categories', (_req, res) => res.json(db.prepare('SELECT * FROM categories ORDER BY sort_order, name').all()));

app.post('/api/v1/categories', authRequired, (req, res) => {
  const { name, parent_id, description: desc, sort_order } = req.body || {};
  if (!name) return res.status(400).json({ detail: 'name required' });
  const id = nanoid();
  try {
    db.prepare(
      'INSERT INTO categories (id, name, slug, parent_id, description, sort_order) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(id, name, slugify(name), parent_id || null, desc || null, sort_order || 0);
    res.status(201).json(db.prepare('SELECT * FROM categories WHERE id = ?').get(id));
  } catch (e) {
    res.status(400).json({ detail: e.message });
  }
});

app.put('/api/v1/categories/:id', authRequired, (req, res) => {
  const cat = db.prepare('SELECT * FROM categories WHERE id = ?').get(req.params.id);
  if (!cat) return res.status(404).json({ detail: 'Not found' });
  const { name, parent_id, description: desc, sort_order } = req.body || {};
  db.prepare(
    'UPDATE categories SET name = COALESCE(?, name), parent_id = ?, description = ?, sort_order = COALESCE(?, sort_order) WHERE id = ?'
  ).run(name || null, parent_id !== undefined ? parent_id : cat.parent_id, desc !== undefined ? desc : cat.description, sort_order, req.params.id);
  res.json(db.prepare('SELECT * FROM categories WHERE id = ?').get(req.params.id));
});

app.delete('/api/v1/categories/:id', authRequired, (req, res) => {
  db.prepare('DELETE FROM categories WHERE id = ?').run(req.params.id);
  res.status(204).end();
});

// --- Tags ---
app.get('/api/v1/tags', (_req, res) => res.json(db.prepare('SELECT * FROM tags ORDER BY usage_count DESC, name').all()));

app.post('/api/v1/tags', authRequired, (req, res) => {
  const { name, color } = req.body || {};
  if (!name) return res.status(400).json({ detail: 'name required' });
  const id = nanoid();
  try {
    db.prepare('INSERT INTO tags (id, name, slug, color) VALUES (?, ?, ?, ?)').run(id, name, slugify(name), color || null);
    res.status(201).json(db.prepare('SELECT * FROM tags WHERE id = ?').get(id));
  } catch (e) {
    res.status(400).json({ detail: e.message });
  }
});

// --- Assets ---
const MAX_FILE_SIZE = (parseInt(process.env.UPLOAD_MAX_FILE_SIZE_MB || '2048', 10)) * 1024 * 1024;
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE },
});

function uploadErrorHandler(err, _req, res, next) {
  if (err && err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ code: 'FILE_TOO_LARGE', message: `File exceeds ${MAX_FILE_SIZE} bytes`, request_id: nanoid() });
  }
  next(err);
}

function detectAssetType(mime) {
  if (!mime) return 'other';
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  return 'other';
}

function safeParse(s) {
  try { return JSON.parse(s); } catch { return null; }
}

async function processUpload(file, ownerId, source, extra = {}) {
  const hash = crypto.createHash('sha256').update(file.buffer).digest('hex');
  const existing = db.prepare('SELECT id FROM assets WHERE file_hash = ?').get(hash);
  if (existing) {
    return { duplicate: true, asset: db.prepare('SELECT * FROM assets WHERE id = ?').get(existing.id) };
  }
  const id = nanoid();
  const ext = path.extname(file.originalname) || '';
  const storageName = `${id}${ext}`;
  const storagePath = path.join('originals', storageName);
  fs.writeFileSync(path.join(STORAGE_DIR, storagePath), file.buffer);

  let width, height, duration, thumbnailPath = null;
  try {
    const sharp = require('sharp');
    if (file.mimetype.startsWith('image/')) {
      const meta = await sharp(file.buffer).metadata();
      width = meta.width;
      height = meta.height;
      const thumbName = `${id}.webp`;
      thumbnailPath = path.join('thumbnails', thumbName);
      await sharp(file.buffer)
        .resize(400, 400, { fit: 'cover' })
        .webp({ quality: 80 })
        .toFile(path.join(STORAGE_DIR, thumbnailPath));
    } else if (file.mimetype.startsWith('video/')) {
      // duration left 0; thumbnail extraction requires ffmpeg (optional)
      thumbnailPath = null;
    }
  } catch (e) {
    console.warn('[thumb] failed (non-fatal):', e.message);
  }

  const assetType = detectAssetType(file.mimetype);
  const { source_tool = null, prompt = null, seed = null, model_name = null, job_id = null, metadata = null } = extra;
  const metadataJson = metadata !== null && metadata !== undefined ? JSON.stringify(metadata) : null;

  db.prepare(
    `INSERT INTO assets (id, title, filename, original_name, mime_type, file_size, file_hash, asset_type,
       width, height, duration, storage_path, thumbnail_path, uploaded_by, source, status,
       source_tool, prompt, seed, model_name, job_id, metadata_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    file.originalname,
    storageName,
    file.originalname,
    file.mimetype,
    file.size,
    hash,
    assetType,
    width || null,
    height || null,
    duration || null,
    storagePath,
    thumbnailPath,
    ownerId || null,
    source || 'admin',
    'ready',
    source_tool,
    prompt,
    Number.isFinite(seed) ? seed : null,
    model_name,
    job_id,
    metadataJson
  );

  // Mark manifest write and trigger async regeneration (non-blocking)
  try {
    require('./lib/manifest').markAssetForManifestWrite(db, id, 'create');
    setImmediate(() => {
      require('./lib/manifest').writeManifestIndex(db, STORAGE_DIR).catch((e) => {
        console.warn('[manifest] write failed', e.message);
      });
    });
  } catch (e) {
    console.warn('[manifest] mark failed', e.message);
  }

  return { duplicate: false, asset: db.prepare('SELECT * FROM assets WHERE id = ?').get(id) };
}

app.get('/api/v1/assets', (req, res) => {
  const { q, asset_type, category_id, page = 1, page_size = 20 } = req.query;
  const where = [];
  const params = [];
  if (q) {
    where.push('(title LIKE ? OR description LIKE ? OR original_name LIKE ?)');
    const like = `%${q}%`;
    params.push(like, like, like);
  }
  if (asset_type) {
    where.push('asset_type = ?');
    params.push(asset_type);
  }
  if (category_id) {
    where.push('category_id = ?');
    params.push(category_id);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = db.prepare(`SELECT COUNT(*) AS c FROM assets ${whereSql}`).get(...params).c;
  const offset = (parseInt(page) - 1) * parseInt(page_size);
  const items = db
    .prepare(`SELECT * FROM assets ${whereSql} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
    .all(...params, parseInt(page_size), offset);
  res.json({ items, total, page: parseInt(page), page_size: parseInt(page_size) });
});

app.get('/api/v1/assets/:id', (req, res) => {
  const asset = db.prepare('SELECT * FROM assets WHERE id = ?').get(req.params.id);
  if (!asset) return res.status(404).json({ detail: 'Not found' });
  res.json(asset);
});

app.post('/api/v1/assets/upload', authRequired, upload.array('files', 20), async (req, res) => {
  if (!req.files || !req.files.length) return res.status(400).json({ detail: 'No files' });
  const extra = {
    source_tool: req.body.source_tool || null,
    prompt: req.body.prompt || null,
    seed: req.body.seed ? parseInt(req.body.seed, 10) : null,
    model_name: req.body.model_name || null,
    job_id: req.body.job_id || null,
    metadata: req.body.metadata ? safeParse(req.body.metadata) : null,
  };
  const results = [];
  for (const file of req.files) {
    const r = await processUpload(file, req.user.id, 'admin', extra);
    results.push(r.asset);
  }
  res.status(201).json({ items: results, count: results.length });
});

app.put('/api/v1/assets/:id', authRequired, (req, res) => {
  const asset = db.prepare('SELECT * FROM assets WHERE id = ?').get(req.params.id);
  if (!asset) return res.status(404).json({ detail: 'Not found' });
  const { title, description, category_id } = req.body || {};
  db.prepare(
    `UPDATE assets SET title = COALESCE(?, title), description = ?, category_id = ?, updated_at = datetime('now') WHERE id = ?`
  ).run(title || null, description !== undefined ? description : asset.description, category_id !== undefined ? category_id : asset.category_id, req.params.id);
  res.json(db.prepare('SELECT * FROM assets WHERE id = ?').get(req.params.id));
});

app.delete('/api/v1/assets/:id', authRequired, (req, res) => {
  const asset = db.prepare('SELECT * FROM assets WHERE id = ?').get(req.params.id);
  if (!asset) return res.status(404).json({ detail: 'Not found' });
  try {
    fs.unlinkSync(path.join(STORAGE_DIR, asset.storage_path));
    if (asset.thumbnail_path) fs.unlinkSync(path.join(STORAGE_DIR, asset.thumbnail_path));
  } catch (e) {
    console.warn('[delete] file removal failed:', e.message);
  }
  db.prepare('DELETE FROM assets WHERE id = ?').run(req.params.id);
  res.status(204).end();
});

// --- API Keys ---
app.get('/api/v1/api-keys', authRequired, (_req, res) => {
  const items = db
    .prepare("SELECT id, name, key_prefix, scopes, is_active, last_used_at, expires_at, created_at FROM api_keys ORDER BY created_at DESC")
    .all();
  res.json(
    items.map((k) => ({
      ...k,
      key_masked: `${k.key_prefix}************************`,
      is_active: !!k.is_active,
    }))
  );
});

app.post('/api/v1/api-keys', authRequired, (req, res) => {
  const { name, scopes, expires_at } = req.body || {};
  if (!name) return res.status(400).json({ detail: 'name required' });
  const { raw, hash, prefix } = generateApiKey();
  const id = nanoid();
  db.prepare(
    'INSERT INTO api_keys (id, name, key_prefix, key_hash, scopes, expires_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(id, name, prefix, hash, scopes || 'read,upload', expires_at || null);
  // raw key returned only once
  res.status(201).json({
    id,
    name,
    key: raw,
    key_prefix: prefix,
    scopes: scopes || 'read,upload',
    expires_at,
    warning: 'Save this key now. It will not be shown again.',
  });
});

app.delete('/api/v1/api-keys/:id', authRequired, (req, res) => {
  db.prepare('UPDATE api_keys SET is_active = 0 WHERE id = ?').run(req.params.id);
  res.status(204).end();
});

// --- Stats ---
app.get('/api/v1/stats', authRequired, (_req, res) => {
  const total = db.prepare('SELECT COUNT(*) AS c FROM assets').get().c;
  const images = db.prepare("SELECT COUNT(*) AS c FROM assets WHERE asset_type = 'image'").get().c;
  const videos = db.prepare("SELECT COUNT(*) AS c FROM assets WHERE asset_type = 'video'").get().c;
  const totalSize = db.prepare('SELECT COALESCE(SUM(file_size), 0) AS s FROM assets').get().s;
  const recent = db
    .prepare("SELECT id, title, asset_type, file_size, created_at FROM assets ORDER BY created_at DESC LIMIT 10")
    .all();
  res.json({ total, images, videos, total_size: totalSize, recent });
});

// --- Public delivery API ---
app.get('/api/public/v1/delivery/assets', apiKeyRequired('read'), (req, res) => {
  const { q, asset_type, page = 1, page_size = 20 } = req.query;
  const where = [];
  const params = [];
  if (q) {
    where.push('(title LIKE ? OR description LIKE ?)');
    const like = `%${q}%`;
    params.push(like, like);
  }
  if (asset_type) {
    where.push('asset_type = ?');
    params.push(asset_type);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = db.prepare(`SELECT COUNT(*) AS c FROM assets ${whereSql}`).get(...params).c;
  const offset = (parseInt(page) - 1) * parseInt(page_size);
  const items = db
    .prepare(`SELECT * FROM assets ${whereSql} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
    .all(...params, parseInt(page_size), offset);
  res.json({ items, total, page: parseInt(page), page_size: parseInt(page_size) });
});

app.post('/api/public/v1/delivery/upload', apiKeyRequired('upload'), upload.array('files', 20), async (req, res) => {
  if (!req.files || !req.files.length) return res.status(400).json({ detail: 'No files' });
  const extra = {
    source_tool: req.body.source_tool || null,
    prompt: req.body.prompt || null,
    seed: req.body.seed ? parseInt(req.body.seed, 10) : null,
    model_name: req.body.model_name || null,
    job_id: req.body.job_id || null,
    metadata: req.body.metadata ? safeParse(req.body.metadata) : null,
  };
  const results = [];
  for (const file of req.files) {
    const r = await processUpload(file, null, 'public', extra);
    results.push(r.asset);
  }
  res.status(201).json({ items: results, count: results.length });
});

// --- 404 for unknown API ---
app.use('/api', (_req, res) => res.status(404).json({ detail: 'Not found' }));

// --- Static: storage ---
app.use('/storage', express.static(STORAGE_DIR, { maxAge: '7d', fallthrough: true }));

// --- Static: frontend build (if exists) ---
const FRONTEND_DIST = path.join(ROOT_DIR, 'frontend', 'dist');
if (fs.existsSync(FRONTEND_DIST)) {
  app.use(express.static(FRONTEND_DIST, { maxAge: '1h' }));
  app.get(/^(?!\/api|\/storage).*/, (_req, res) => {
    res.sendFile(path.join(FRONTEND_DIST, 'index.html'));
  });
  console.log('[static] serving frontend from', FRONTEND_DIST);
} else {
  // Demo page (no-build UI) — talks to live backend
  const DEMO_HTML = path.join(ROOT_DIR, 'frontend', 'demo.html');
  if (fs.existsSync(DEMO_HTML)) {
    app.get('/', (_req, res) => res.sendFile(DEMO_HTML));
    app.get(/^(?!\/api|\/storage).*/, (_req, res) => res.sendFile(DEMO_HTML));
    console.log('[static] serving demo UI from', DEMO_HTML);
  } else {
    app.get('/', (_req, res) => {
      res.send(`<html><body style="font-family:sans-serif;padding:40px">
        <h1>DAM backend is running</h1>
        <p>Frontend build not found at <code>${FRONTEND_DIST}</code>.</p>
      </body></html>`);
    });
  }
}

// --- Error handler ---
app.use(uploadErrorHandler);
app.use((err, _req, res, _next) => {
  console.error('[error]', err);
  res.status(err.status || 500).json({ detail: err.message || 'Internal error' });
});

// --- Startup: replay pending manifest writes + ensure index.json exists ---
const {
  replayPendingManifestWrites,
  writeManifestIndex,
} = require('./lib/manifest');
fs.mkdirSync(path.join(STORAGE_DIR, 'manifests'), { recursive: true });
replayPendingManifestWrites(db, STORAGE_DIR).catch((e) => {
  console.warn('[manifest] replay failed', e.message);
});
writeManifestIndex(db, STORAGE_DIR).catch((e) => {
  console.warn('[manifest] initial write failed', e.message);
});

// --- Start ---
if (require.main === module) {
  app.listen(PORT, HOST, () => {
    console.log(`\nDAM backend listening on http://localhost:${PORT}`);
    console.log(`  API:    /api/v1/* (admin JWT)`);
    console.log(`  Public: /api/public/v1/* (API Key)`);
    console.log(`  Static: /storage/*  (uploaded files)`);
    console.log(`  Admin:  admin / Admin@123456\n`);
  });
}

module.exports = app;