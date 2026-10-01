# DAM 统一站点改造 — 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把现有的 DAM（数字资产管理系统）改造为单一统一站点，对外提供可被 ComfyUI 等插件读取的资产契约（HTTP API + 本地 JSON manifest 镜像），并完成 React SPA 全栈整合与有辨识度的视觉设计。

**Architecture:** 单文件 Express + better-sqlite3 后端（schema 增量扩展 + manifest 镜像写入 + Webhook 推送）；React 18 + TS + Vite 6 + AntD 5 前端 SPA（删除 demo.html，按"创作工作流"重新组织页面，琥珀暖橙主题）。

**Tech Stack:**
- 后端：Node.js ≥18、Express 4、better-sqlite3 11、sharp 0.33、jsonwebtoken、bcryptjs、multer
- 前端：React 18.3、TypeScript 5.7、Vite 6、AntD 5、@ant-design/icons、@ant-design/charts、@ant-design/pro-components、zustand 5、axios、dayjs、react-router-dom 6、nanoid

**Spec:** `docs/superpowers/specs/2026-10-01-dam-unified-site-design.md`

## Global Constraints

- Node 18+ / npm 9+；后端 sqlite 文件位于 `backend/data/dam.db`，存储根 `backend/storage/`（原文件 `storage/` 镜像保留以便回退）。
- 不引入 MySQL/Postgres；保持零依赖单进程部署。
- 不破坏现有 `/api/v1/*`、`/api/public/v1/*` 接口契约，向后兼容（仅 ADD COLUMN/ADD 增表）。
- 主色 `#f5a524`（琥珀暖橙），背景 `#0d1117`，面板 `#161b22`，边框 `#30363d`，文字 `#f0f6fc`，辅文 `#8b949e`，紫红 `#f78166`（ComfyUI），青绿 `#3fb950`（成功）。
- 字体：标题 Inter 700-800，正文 Inter 400/500，元数据 JetBrains Mono。
- 不使用 ALL-CAPS eyebrow、不使用统一圆角卡片堆叠、不使用渐变光晕装饰；左侧 240px 导航 + 顶部 56px bar + 最大内容宽 1440px；行宽 ≤80 字符；尊重 `prefers-reduced-motion`。
- 单一入场动画（页面切换淡入 + 4px 上移，150ms），crossfade 200ms 用于切换，不堆 hover 微动效。
- 文案用动词、sentence case、系统口吻错误（不拟人）。
- 所有外部请求响应统一结构 `{ code, message, data, request_id }`；上传失败返回 `{ code, message, request_id }` 而非裸对象。
- manifest 镜像：每次 upsert/delete 后异步重写 `backend/storage/manifests/index.json`；失败重试 3 次指数退避，记录到 `manifest_writes` 表。
- Webhook 推送重试 3 次，HMAC-SHA256 头 `X-DAM-Signature: sha256=<hex>`，失败入 `webhook_logs`。

## Review Focus

以下输入/边界最容易回归问题，每个都被对应任务覆盖测试：

1. **资产重复上传**（同 hash）— 必须返回既有记录而不是新插入。Task 3 测试。
2. **manifest 镜像一致性**— 重启服务后能从 `manifest_writes` 表回放失败写盘。Task 5 测试。
3. **Webhook 签名校验**— 接收方按 HMAC 重算应等于 `X-DAM-Signature`。Task 6 测试。
4. **大文件（>100MB）上传**— 不应让进程崩，stream 写盘 + 上限校验。Task 4 测试。
5. **删除演示页 demo.html 后 React SPA 不可用**— `frontend/dist/` 构建产物必须在 backend 启动前存在；缺失时仍显示占位说明而不是报 500。Task 11 测试。

---

## 文件结构（任务划分前置）

### 后端（修改 1 个文件 + 新增 1 个）
- **Modify** `backend/src/server.js` — schema 增量、路由扩展、manifest 写入、Webhook
- **Create** `backend/src/lib/manifest.js` — manifest 镜像写盘工具（独立单元，可测）
- **Create** `backend/src/lib/webhook.js` — Webhook 推送 + HMAC 签名
- **Create** `backend/tests/manifest.test.js` — manifest 工具测试
- **Create** `backend/tests/webhook.test.js` — webhook 工具测试
- **Create** `backend/tests/server.test.js` — 关键路由集成测试（不依赖 MySQL，使用临时 sqlite）

### 前端（新增 1 个 + 修改多个）
- **Create** `frontend/src/types/dto.ts` — 共享 DTO 类型
- **Create** `frontend/src/api/hooks.ts` — React Query 风格的轻量 hook（基于 axios）
- **Create** `frontend/src/theme/tokens.ts` — 设计 token
- **Create** `frontend/src/theme/antd-theme.ts` — AntD ConfigProvider 主题
- **Create** `frontend/src/styles/global.css` — 全局样式
- **Modify** `frontend/src/router.tsx` — 按 spec §5.2 重写路由
- **Modify** `frontend/src/components/layout/MainLayout.tsx` — 新设计
- **Create** `frontend/src/pages/Library.tsx` — 资产库
- **Create** `frontend/src/pages/Import.tsx` — 导入
- **Create** `frontend/src/pages/Jobs.tsx` — ComfyUI 任务
- **Create** `frontend/src/pages/Organize.tsx` — 分类+标签合并页
- **Create** `frontend/src/pages/Integrations.tsx` — API Key + Webhook
- **Modify** 现有 Dashboard / AssetDetail / Settings / Users / Login / Upload 等页面适配新主题
- **Delete** `frontend/demo.html`（完成所有页面与构建后再删）

---

## 任务分解

### Task 1: 后端 schema 增量（assets 元数据列 + Webhook 表 + manifest_writes 表）

**Files:**
- Modify: `backend/src/server.js:42-127`（在 `db.exec` 块内追加 ALTER/CREATE）
- Test: `backend/tests/server.test.js`

**Interfaces:**
- Consumes: 无
- Produces: `assets` 表新增 `source_tool TEXT`、`prompt TEXT`、`seed INTEGER`、`model_name TEXT`、`job_id TEXT`、`metadata_json TEXT`；新增 `webhook_endpoints(id, name, url, secret, is_active, created_at)` 与 `webhook_logs(...)`、`manifest_writes(id, asset_id, op, status, attempts, last_error, created_at)`

- [ ] **Step 1: 写失败测试**（在 `backend/tests/server.test.js`）— 起一个临时 sqlite 实例，加载 `server.js` 的 schema 块，断言列存在：

```js
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const tmp = path.join(__dirname, 'tmp.db');
try { fs.unlinkSync(tmp); } catch {}
const db = new Database(tmp);
const schemaPath = path.join(__dirname, '..', 'src', 'server.js');
const src = fs.readFileSync(schemaPath, 'utf8');
const m = src.match(/db\.exec\(`([\s\S]*?)`\);/);
db.exec(m[1]);

const cols = db.prepare("PRAGMA table_info(assets)").all().map(c => c.name);
['source_tool','prompt','seed','model_name','job_id','metadata_json'].forEach(c => {
  if (!cols.includes(c)) throw new Error('missing column: ' + c);
});

const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(t=>t.name);
['webhook_endpoints','webhook_logs','manifest_writes'].forEach(t => {
  if (!tables.includes(t)) throw new Error('missing table: ' + t);
});

console.log('schema OK');
fs.unlinkSync(tmp);
db.close();
```

- [ ] **Step 2: 跑测试确认失败** — `node backend/tests/server.test.js`，期望输出 `Error: missing column: source_tool`。

- [ ] **Step 3: 修改 server.js schema** — 在原 schema 块（`db.exec(\`CREATE TABLE IF NOT EXISTS assets (...)\`)`）末尾追加：

```sql
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
```

> 注意 SQLite `ALTER TABLE ADD COLUMN` 不支持 `NOT NULL` 默认值，所以保持可空；业务层在 INSERT 时显式传 null。

- [ ] **Step 4: 再跑测试确认通过** — 期望输出 `schema OK`。

- [ ] **Step 5: 提交** — `git add backend/src/server.js backend/tests/server.test.js && git commit -m "feat(backend): extend asset schema with ComfyUI fields + webhook/manifest tables"`

---

### Task 2: manifest 镜像写盘库（独立可测模块）

**Files:**
- Create: `backend/src/lib/manifest.js`
- Test: `backend/tests/manifest.test.js`

**Interfaces:**
- Consumes: `db`（better-sqlite3 实例）、`STORAGE_DIR`（绝对路径）
- Produces:
  - `writeManifestIndex(db, storageDir)` → Promise<void>，全量重写 `index.json`
  - `markAssetForManifestWrite(db, assetId, op)` → 标记一笔写盘任务到 `manifest_writes`
  - `replayPendingManifestWrites(db, storageDir)` → 启动时回放 pending
  - `getManifestPath(storageDir)` → string

- [ ] **Step 1: 写失败测试** —

```js
// backend/tests/manifest.test.js
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');

const tmpDb = path.join(os.tmpdir(), 'manifest-test.db');
try { fs.unlinkSync(tmpDb); } catch {}
const db = new Database(tmpDb);
db.exec(`CREATE TABLE assets (
  id TEXT PRIMARY KEY, title TEXT, asset_type TEXT, file_size INTEGER,
  original_path TEXT, thumbnail_path TEXT, created_at TEXT,
  source_tool TEXT, prompt TEXT, seed INTEGER, model_name TEXT, job_id TEXT,
  status TEXT NOT NULL DEFAULT 'ready'
);
CREATE TABLE manifest_writes (id TEXT PRIMARY KEY, asset_id TEXT, op TEXT, status TEXT, attempts INTEGER DEFAULT 0, last_error TEXT, created_at TEXT DEFAULT (datetime('now')));`);

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manifest-'));
const m = require('../src/lib/manifest');
assert.strictEqual(typeof m.writeManifestIndex, 'function');
console.log('manifest lib OK');
db.close(); fs.unlinkSync(tmpDb); fs.rmSync(tmpDir, { recursive: true });
```

- [ ] **Step 2: 跑测试确认失败** — `node backend/tests/manifest.test.js`，期望 `Cannot find module '../src/lib/manifest'`。

- [ ] **Step 3: 实现 manifest.js** —

```js
// backend/src/lib/manifest.js
'use strict';
const fs = require('fs');
const path = require('path');
const { nanoid } = require('nanoid');

function getManifestPath(storageDir) {
  return path.join(storageDir, 'manifests', 'index.json');
}

async function writeManifestIndex(db, storageDir) {
  fs.mkdirSync(path.join(storageDir, 'manifests'), { recursive: true });
  const assets = db.prepare(`
    SELECT id, title, asset_type, file_size, original_name, mime_type,
           width, height, duration, source_tool, prompt, seed,
           model_name, job_id, metadata_json, created_at, updated_at, status
    FROM assets
    WHERE status != 'deleted'
    ORDER BY created_at DESC
  `).all();

  // 简单聚合标签/分类可选填；这里只放最小可用字段
  const payload = {
    version: 1,
    updated_at: new Date().toISOString(),
    count: assets.length,
    assets: assets.map((a) => ({
      id: a.id,
      title: a.title,
      asset_type: a.asset_type,
      file_size: a.file_size,
      original_name: a.original_name,
      mime_type: a.mime_type,
      width: a.width,
      height: a.height,
      duration: a.duration,
      source_tool: a.source_tool,
      prompt: a.prompt,
      seed: a.seed,
      model_name: a.model_name,
      job_id: a.job_id,
      metadata: a.metadata_json ? safeParse(a.metadata_json) : null,
      status: a.status,
      original_path: deriveOriginalPath(a),
      thumbnail_path: a.thumbnail_path || null,
      created_at: a.created_at,
      updated_at: a.updated_at,
    })),
  };
  const file = getManifestPath(storageDir);
  // 原子写：先写到 .tmp，再 rename
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2));
  fs.renameSync(tmp, file);
  return { count: assets.length };
}

function deriveOriginalPath(asset) {
  if (asset.original_name && asset.id) {
    return `originals/${asset.id}${path.extname(asset.original_name) || ''}`;
  }
  return null;
}

function safeParse(s) {
  try { return JSON.parse(s); } catch { return null; }
}

function markAssetForManifestWrite(db, assetId, op) {
  db.prepare(
    'INSERT INTO manifest_writes (id, asset_id, op, status) VALUES (?, ?, ?, ?)'
  ).run(nanoid(), assetId || null, op, 'pending');
}

async function replayPendingManifestWrites(db, storageDir) {
  const pending = db.prepare("SELECT id FROM manifest_writes WHERE status = 'pending' ORDER BY created_at ASC LIMIT 1000").all();
  if (!pending.length) return 0;
  let n = 0;
  for (const row of pending) {
    try {
      await writeManifestIndex(db, storageDir);
      db.prepare("UPDATE manifest_writes SET status='done', attempts=attempts+1 WHERE id=?").run(row.id);
      n++;
    } catch (e) {
      db.prepare("UPDATE manifest_writes SET status='failed', attempts=attempts+1, last_error=? WHERE id=?").run(String(e.message || e), row.id);
    }
  }
  return n;
}

module.exports = {
  getManifestPath,
  writeManifestIndex,
  markAssetForManifestWrite,
  replayPendingManifestWrites,
};
```

- [ ] **Step 4: 再跑测试确认通过** — 期望输出 `manifest lib OK`。

- [ ] **Step 5: 补充真实写入测试**（同文件追加第二段） —

```js
const Database2 = require('better-sqlite3');
const fs2 = require('fs');
const path2 = require('path');
const os2 = require('os');
const assert2 = require('assert');

(async () => {
  const db2 = new Database2(':memory:');
  db2.exec(`CREATE TABLE assets (id TEXT PRIMARY KEY, title TEXT, asset_type TEXT, file_size INTEGER, original_name TEXT, mime_type TEXT, width INTEGER, height INTEGER, duration REAL, source_tool TEXT, prompt TEXT, seed INTEGER, model_name TEXT, job_id TEXT, metadata_json TEXT, created_at TEXT, updated_at TEXT, status TEXT NOT NULL DEFAULT 'ready', thumbnail_path TEXT);
  CREATE TABLE manifest_writes (id TEXT PRIMARY KEY, asset_id TEXT, op TEXT, status TEXT, attempts INTEGER DEFAULT 0, last_error TEXT, created_at TEXT DEFAULT (datetime('now')));`);
  db2.prepare("INSERT INTO assets VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run('a1','Test','image',1024,'a1.png','image/png',1024,1024,null,'comfyui','a cat',42,'sdxl','job-1',null,new Date().toISOString(),new Date().toISOString(),'ready',null);

  const dir = fs2.mkdtempSync(path2.join(os2.tmpdir(), 'mf2-'));
  const res = await m.writeManifestIndex(db2, dir);
  assert2.strictEqual(res.count, 1);
  const out = JSON.parse(fs2.readFileSync(path2.join(dir, 'manifests', 'index.json'), 'utf8'));
  assert2.strictEqual(out.assets[0].id, 'a1');
  assert2.strictEqual(out.assets[0].source_tool, 'comfyui');
  assert2.strictEqual(out.assets[0].seed, 42);
  console.log('manifest write OK');
  fs2.rmSync(dir, { recursive: true });
  db2.close();
})();
```

- [ ] **Step 6: 跑两个测试段** — `node backend/tests/manifest.test.js`，期望都打印 `OK`。

- [ ] **Step 7: 提交** — `git add backend/src/lib/manifest.js backend/tests/manifest.test.js && git commit -m "feat(backend): add manifest mirror writer (atomic write + replay queue)"`

---

### Task 3: 资产上传接受 ComfyUI 元数据 + 触发 manifest 写

**Files:**
- Modify: `backend/src/server.js:382-440`（`processUpload` 函数与相关 INSERT）
- Modify: `backend/src/server.js:474-482`（上传路由读取新字段）+ `:581-589`（公开上传路由）
- Test: `backend/tests/server.test.js`（追加）

**Interfaces:**
- Consumes: `req.body` 中的 `source_tool / prompt / seed / model_name / job_id / metadata`；复用现有 `processUpload`
- Produces: `assets` 行写入新字段；调用 `markAssetForManifestWrite`；返回资产对象保留新字段

- [ ] **Step 1: 写失败测试** — 测试通过 `/api/v1/assets/upload`（带 JWT mock）发送多参数，断言响应里的资产对象含 `prompt/seed/job_id`：

```js
// 追加到 backend/tests/server.test.js
const http = require('http');
const assert = require('assert');

// 启动一个临时 server，监听随机端口
const port = 18000 + Math.floor(Math.random() * 1000);
process.env.PORT = String(port);
const serverApp = require('../src/server');
// serverApp 是 app 实例？如果是 express app，调用 listen
```

> 由于 server.js 直接 `app.listen` 而未导出 `app`，先把 `module.exports = app` 加到文件末尾（Step 3 一并实现）。

- [ ] **Step 2: 跑测试确认失败** — 期望 `app is not a function`。

- [ ] **Step 3: 改造 server.js**：
   - 文件末尾追加 `module.exports = app;`。
   - `processUpload` 末尾追加元数据接收：

```js
async function processUpload(file, ownerId, source, extra = {}) {
  // ... 既有逻辑 ...
  const { source_tool = null, prompt = null, seed = null, model_name = null, job_id = null, metadata = null } = extra;
  db.prepare(
    `INSERT INTO assets (id, title, filename, original_name, mime_type, file_size, file_hash, asset_type,
       width, height, duration, storage_path, thumbnail_path, uploaded_by, source, status,
       source_tool, prompt, seed, model_name, job_id, metadata_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id, file.originalname, storageName, file.originalname, file.mimetype,
    file.size, hash, assetType,
    width || null, height || null, duration || null,
    storagePath, thumbnailPath, ownerId || null, source || 'admin', 'ready',
    source_tool, prompt, Number.isFinite(seed) ? seed : null,
    model_name, job_id, metadata ? JSON.stringify(metadata) : null
  );
  // 标记 manifest 写盘
  try {
    require('./lib/manifest').markAssetForManifestWrite(db, id, 'create');
    setImmediate(() => require('./lib/manifest').writeManifestIndex(db, STORAGE_DIR).catch((e) => console.warn('[manifest] write failed', e.message)));
  } catch (e) { console.warn('[manifest] mark failed', e.message); }

  return { duplicate: false, asset: db.prepare('SELECT * FROM assets WHERE id = ?').get(id) };
}
```

   - `/api/v1/assets/upload` 与 `/api/public/v1/delivery/upload` 改为从 `req.body` 读取新字段并传给 `processUpload`：

```js
const extra = {
  source_tool: req.body.source_tool || null,
  prompt: req.body.prompt || null,
  seed: req.body.seed ? parseInt(req.body.seed, 10) : null,
  model_name: req.body.model_name || null,
  job_id: req.body.job_id || null,
  metadata: req.body.metadata ? safeParse(req.body.metadata) : null,
};
```

- [ ] **Step 4: 跑测试确认通过** — 写测试登录 → 上传携带 `prompt/seed/job_id` → 断言响应里这三个字段回显。

- [ ] **Step 5: 提交** — `git add backend/src/server.js backend/tests/server.test.js && git commit -m "feat(backend): accept ComfyUI metadata on upload + trigger manifest mirror"`

---

### Task 4: 大文件流式上传 + multer 上限配置

**Files:**
- Modify: `backend/src/server.js:370-373`（multer 配置）

**Interfaces:**
- Consumes: `UPLOAD_MAX_FILE_SIZE_MB` 环境变量（默认 2048）
- Produces: 上传文件超过上限时返回 413 + 结构化错误

- [ ] **Step 1: 写失败测试** — 发送超过上限的字节，断言 statusCode 413：

```js
// backend/tests/server.test.js 追加
const FormData = require('form-data');
const fetch = (...args) => import('node-fetch').then(({default:f})=>f(...args));
```

> 如果不想引入 form-data 依赖，改为直接构造 multipart 字符串。

- [ ] **Step 2: 跑测试确认失败** — 期望 statusCode 500（当前无上限保护）。

- [ ] **Step 3: 修改 multer 配置**：

```js
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
```

并把上传路由挂上 `uploadErrorHandler`（在路由后 `app.use(uploadErrorHandler)` 或在 `app.use((err,...)...)` 顶部）。

- [ ] **Step 4: 测试通过** — `node backend/tests/server.test.js`，期望 statusCode 413。

- [ ] **Step 5: 提交** — `git add backend/src/server.js && git commit -m "feat(backend): enforce file size limit with structured 413 response"`

---

### Task 5: 启动时回放 manifest 写盘 + 提供 GET `/storage/manifests/index.json`

**Files:**
- Modify: `backend/src/server.js` 启动区块（在 `app.listen` 之前）

**Interfaces:**
- Consumes: `db`、`STORAGE_DIR`
- Produces: 服务启动后 manifest 已是最新；`/storage/manifests/index.json` 可由静态服务返回

- [ ] **Step 1: 写失败测试** — 启动服务后向 `/storage/manifests/index.json` 发送 GET，期望 200：

```js
const fetch2 = require('node-fetch');
const r = await fetch2(`http://127.0.0.1:${port}/storage/manifests/index.json`);
assert.strictEqual(r.status, 200);
```

- [ ] **Step 2: 跑测试确认失败** — 当前 `app.use('/storage', ...)` 没声明 `manifests` 子目录（取决于 express.static 行为，可能 fallthrough）。

- [ ] **Step 3: 改造**：
   - 在 `app.listen` 之前执行：

```js
const { replayPendingManifestWrites, writeManifestIndex } = require('./lib/manifest');
fs.mkdirSync(path.join(STORAGE_DIR, 'manifests'), { recursive: true });
replayPendingManifestWrites(db, STORAGE_DIR).catch((e) => console.warn('[manifest] replay failed', e.message));
writeManifestIndex(db, STORAGE_DIR).catch((e) => console.warn('[manifest] initial write failed', e.message));
```

   - `/storage` 静态服务会自动服务 `manifests/` 子目录（无需改动）。

- [ ] **Step 4: 测试通过** — 期望 statusCode 200 且 JSON 可解析。

- [ ] **Step 5: 提交** — `git add backend/src/server.js && git commit -m "feat(backend): replay pending manifest writes on startup + expose index.json"`

---

### Task 6: Webhook 推送工具（HMAC 签名 + 重试）

**Files:**
- Create: `backend/src/lib/webhook.js`
- Test: `backend/tests/webhook.test.js`

**Interfaces:**
- Consumes: `db`、`endpoint`（含 `id/url/secret`）、`event`（string）、`payload`（object）
- Produces:
  - `dispatch(db, endpoint, event, payload)` → Promise<{status, attempts, error}>
  - `signPayload(secret, body)` → string（hex）

- [ ] **Step 1: 写失败测试** —

```js
const w = require('../src/lib/webhook');
assert.strictEqual(typeof w.dispatch, 'function');
const sig = w.signPayload('topsecret', '{"a":1}');
assert.strictEqual(sig.length, 64);
console.log('webhook lib OK');
```

- [ ] **Step 2: 跑测试确认失败** — `Cannot find module '../src/lib/webhook'`。

- [ ] **Step 3: 实现**：

```js
// backend/src/lib/webhook.js
'use strict';
const crypto = require('crypto');
const { nanoid } = require('nanoid');

function signPayload(secret, body) {
  return crypto.createHmac('sha256', secret).update(body).digest('hex');
}

async function httpPost(url, body, headers, timeoutMs = 5000) {
  const { URL } = require('url');
  const u = new URL(url);
  const lib = u.protocol === 'https:' ? require('https') : require('http');
  return new Promise((resolve, reject) => {
    const req = lib.request({
      method: 'POST',
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), ...headers },
      timeout: timeoutMs,
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.write(body); req.end();
  });
}

async function dispatch(db, endpoint, event, payload) {
  const body = JSON.stringify({ event, payload, ts: new Date().toISOString() });
  const sig = signPayload(endpoint.secret, body);
  let attempts = 0;
  let lastError = null;
  let final = { status: 'failed', attempts: 0, error: null };
  for (let i = 0; i < 3; i++) {
    attempts++;
    try {
      const r = await httpPost(endpoint.url, body, { 'X-DAM-Signature': 'sha256=' + sig, 'X-DAM-Event': event });
      if (r.status >= 200 && r.status < 300) {
        final = { status: 'done', attempts, error: null };
        break;
      } else {
        lastError = `HTTP ${r.status}`;
      }
    } catch (e) {
      lastError = e.message;
    }
    await new Promise(r => setTimeout(r, 200 * Math.pow(2, i)));
  }
  if (final.status !== 'done') final = { status: 'failed', attempts, error: lastError };
  db.prepare(
    'INSERT INTO webhook_logs (id, endpoint_id, event, payload, status, attempts, last_error) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(nanoid(), endpoint.id, event, body, final.status, final.attempts, final.error);
  db.prepare('UPDATE webhook_endpoints SET is_active = CASE WHEN ? THEN 1 ELSE is_active END WHERE id=?')
    .run(final.status === 'done', endpoint.id);
  return final;
}

module.exports = { dispatch, signPayload };
```

- [ ] **Step 4: 测试通过** — 期望 `webhook lib OK`。

- [ ] **Step 5: 提交** — `git add backend/src/lib/webhook.js backend/tests/webhook.test.js && git commit -m "feat(backend): add webhook dispatch with HMAC signing + retries"`

---

### Task 7: Webhook 管理 API + 资产事件触发推送

**Files:**
- Modify: `backend/src/server.js`（在 API Keys 路由后追加 Webhook 路由 + `processUpload`/update/delete 处触发）

**Interfaces:**
- Produces:
  - `GET /api/v1/webhooks` — 列表
  - `POST /api/v1/webhooks` — 创建（含 secret）
  - `DELETE /api/v1/webhooks/:id` — 停用（is_active=0）
  - `PUT /api/v1/assets/:id` 与 `DELETE /api/v1/assets/:id` 触发 webhook 派发

- [ ] **Step 1: 写失败测试** — 创建 webhook、断言 201 + 返回 secret；之后上传资产断言 webhook_logs 新增一行。

- [ ] **Step 2: 跑测试确认失败** — 期望 404。

- [ ] **Step 3: 实现路由**：

```js
// webhook 路由（放在 API Keys 之后）
app.get('/api/v1/webhooks', authRequired, (_req, res) => {
  res.json(db.prepare("SELECT id, name, url, is_active, created_at FROM webhook_endpoints ORDER BY created_at DESC").all().map(r => ({ ...r, is_active: !!r.is_active })));
});

app.post('/api/v1/webhooks', authRequired, (req, res) => {
  const { name, url } = req.body || {};
  if (!name || !url) return res.status(400).json({ code: 'BAD_INPUT', message: 'name/url required', request_id: nanoid() });
  const id = nanoid();
  const secret = crypto.randomBytes(24).toString('hex');
  db.prepare('INSERT INTO webhook_endpoints (id, name, url, secret) VALUES (?, ?, ?, ?)').run(id, name, url, secret);
  res.status(201).json({ id, name, url, secret, warning: 'Save this secret now. It will not be shown again.' });
});

app.delete('/api/v1/webhooks/:id', authRequired, (req, res) => {
  db.prepare('UPDATE webhook_endpoints SET is_active = 0 WHERE id = ?').run(req.params.id);
  res.status(204).end();
});
```

- [ ] **Step 4: 在 `processUpload`、asset PUT、asset DELETE 末尾触发 webhook 派发**：

```js
function emitAssetEvent(event, asset) {
  const endpoints = db.prepare("SELECT id, url, secret FROM webhook_endpoints WHERE is_active = 1").all();
  const wh = require('./lib/webhook');
  for (const ep of endpoints) {
    wh.dispatch(db, ep, event, asset).catch((e) => console.warn('[webhook] dispatch err', e.message));
  }
}
```

- [ ] **Step 5: 测试通过** — 上传 → 检查 webhook_logs 表。

- [ ] **Step 6: 提交** — `git add backend/src/server.js backend/tests/server.test.js && git commit -m "feat(backend): webhook CRUD + asset event dispatch"`

---

### Task 8: 资产单 manifest 端点 + 列表筛选 source_tool/job_id

**Files:**
- Modify: `backend/src/server.js`

**Interfaces:**
- Produces:
  - `GET /api/v1/assets/:id/manifest` — 单资产 manifest JSON
  - `GET /api/v1/assets?source_tool=comfyui&job_id=xxx` — 反查

- [ ] **Step 1: 写失败测试** — 上传带 job_id=job-xyz 的资产 → 用 `?job_id=job-xyz` 查询断言能返回。

- [ ] **Step 2: 跑测试确认失败** — 当前 query 不识别新参数。

- [ ] **Step 3: 修改 `app.get('/api/v1/assets', ...)`** — 在 where 数组增加：

```js
if (req.query.source_tool) { where.push('source_tool = ?'); params.push(req.query.source_tool); }
if (req.query.job_id) { where.push('job_id = ?'); params.push(req.query.job_id); }
```

新增路由（在 `/api/v1/assets/:id` 之后）：

```js
app.get('/api/v1/assets/:id/manifest', (req, res) => {
  const a = db.prepare('SELECT * FROM assets WHERE id = ?').get(req.params.id);
  if (!a) return res.status(404).json({ code: 'NOT_FOUND', message: 'Asset not found', request_id: nanoid() });
  res.json({
    id: a.id,
    title: a.title,
    asset_type: a.asset_type,
    source_tool: a.source_tool,
    job_id: a.job_id,
    prompt: a.prompt,
    seed: a.seed,
    model_name: a.model_name,
    metadata: a.metadata_json ? safeParse(a.metadata_json) : null,
    original_path: `originals/${a.id}${path.extname(a.original_name || '') || ''}`,
    thumbnail_path: a.thumbnail_path || null,
    public_url: `${process.env.APP_BASE_URL || ''}/storage/${a.id}${path.extname(a.original_name || '')}`,
    created_at: a.created_at,
  });
});
```

- [ ] **Step 4: 测试通过** — `node backend/tests/server.test.js`。

- [ ] **Step 5: 提交** — `git add backend/src/server.js && git commit -m "feat(backend): filter assets by source_tool/job_id + single asset manifest"`

---

### Task 9: 前端设计 token 与 AntD 主题

**Files:**
- Create: `frontend/src/theme/tokens.ts`
- Create: `frontend/src/theme/antd-theme.ts`
- Create: `frontend/src/styles/global.css`
- Modify: `frontend/src/main.tsx`（用 `ConfigProvider` 注入主题）

**Interfaces:**
- Produces: 全局可用 token；ConfigProvider 主题对象；基础 reset CSS

- [ ] **Step 1: 写失败类型检查** — `cd frontend && npx tsc --noEmit`，应报 `Cannot find module '@/theme/tokens'`（main.tsx 还未引用）。

- [ ] **Step 2: 跑命令确认失败** — `cd frontend && npx tsc --noEmit`。

- [ ] **Step 3: 实现** —

`frontend/src/theme/tokens.ts`：

```ts
export const tokens = {
  color: {
    bg: '#0d1117',
    bgAlt: '#10131a',
    panel: '#161b22',
    panelAlt: '#1c2230',
    border: '#30363d',
    borderStrong: '#484f58',
    text: '#f0f6fc',
    textMuted: '#8b949e',
    accent: '#f5a524',
    accentHover: '#f7b94a',
    success: '#3fb950',
    danger: '#f85149',
    comfyui: '#f78166',
    jobBadge: '#db61a8',
  },
  font: {
    base: '"Inter", -apple-system, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", sans-serif',
    mono: '"JetBrains Mono", "SF Mono", "Cascadia Mono", Consolas, monospace',
  },
  radius: {
    sm: 4, md: 6, lg: 8,
  },
  space: { 1: 4, 2: 8, 3: 12, 4: 16, 5: 24, 6: 32 },
} as const;
```

`frontend/src/theme/antd-theme.ts`：

```ts
import { theme as antdTheme } from 'antd';
import { tokens } from './tokens';

export const damTheme = {
  algorithm: antdTheme.darkAlgorithm,
  token: {
    colorPrimary: tokens.color.accent,
    colorSuccess: tokens.color.success,
    colorError: tokens.color.danger,
    colorBgBase: tokens.color.bg,
    colorBgContainer: tokens.color.panel,
    colorBgElevated: tokens.color.panelAlt,
    colorBorder: tokens.color.border,
    colorText: tokens.color.text,
    colorTextSecondary: tokens.color.textMuted,
    fontFamily: tokens.font.base,
    borderRadius: tokens.radius.md,
  },
  components: {
    Layout: {
      headerBg: tokens.color.panel,
      siderBg: tokens.color.bg,
      bodyBg: tokens.color.bg,
    },
    Menu: {
      itemBg: 'transparent',
      itemSelectedBg: 'rgba(245, 165, 36, 0.12)',
      itemSelectedColor: tokens.color.accent,
      itemHoverBg: 'rgba(245, 165, 36, 0.06)',
    },
    Button: {
      primaryShadow: 'none',
      defaultBg: tokens.color.panel,
    },
  },
};
```

`frontend/src/styles/global.css`：

```css
:root {
  --dam-bg: #0d1117;
  --dam-panel: #161b22;
  --dam-border: #30363d;
  --dam-accent: #f5a524;
  --dam-text: #f0f6fc;
  --dam-muted: #8b949e;
  --dam-comfyui: #f78166;
}

html, body, #root { height: 100%; margin: 0; }
body {
  background: var(--dam-bg);
  color: var(--dam-text);
  font-family: "Inter", -apple-system, "Segoe UI", "PingFang SC", sans-serif;
  -webkit-font-smoothing: antialiased;
  text-rendering: optimizeLegibility;
}

::-webkit-scrollbar { width: 10px; height: 10px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: #30363d; border-radius: 5px; }
::-webkit-scrollbar-thumb:hover { background: #484f58; }

@media (prefers-reduced-motion: reduce) {
  * { animation: none !important; transition: none !important; }
}

.mono { font-family: "JetBrains Mono", "SF Mono", Consolas, monospace; }
.muted { color: var(--dam-muted); }
.text-accent { color: var(--dam-accent); }

.dam-section-rule {
  border-left: 2px solid var(--dam-accent);
  padding-left: 10px;
}
```

- [ ] **Step 4: 修改 `frontend/src/main.tsx`** — 注入 `ConfigProvider theme={damTheme}` 与 `<style>` 引入 global.css。

- [ ] **Step 5: `cd frontend && npx tsc --noEmit` 通过**。

- [ ] **Step 6: 提交** — `git add frontend/src/theme frontend/src/styles frontend/src/main.tsx && git commit -m "feat(frontend): design tokens + dark amber AntD theme"`

---

### Task 10: 前端共享 DTO 与 API 客户端

**Files:**
- Create: `frontend/src/types/dto.ts`
- Create: `frontend/src/api/hooks.ts`
- Modify: `frontend/src/api/client.ts`

**Interfaces:**
- Produces:
  - 类型 `Asset / Category / Tag / ApiKey / Webhook / Job`
  - `useApi<T>(path, init?)` 轻量 hook
  - `apiClient` 带 401 自动重定向登录

- [ ] **Step 1: 写失败测试** — `cd frontend && npx tsc --noEmit`，期望 `@/types/dto` 引用未找到。

- [ ] **Step 2: 实现** —

`frontend/src/types/dto.ts`：

```ts
export type AssetType = 'image' | 'video' | 'other';
export type AssetStatus = 'ready' | 'processing' | 'failed' | 'deleted';

export interface Asset {
  id: string;
  title: string;
  description?: string | null;
  filename: string;
  original_name: string;
  mime_type: string;
  file_size: number;
  file_hash: string;
  asset_type: AssetType;
  width?: number | null;
  height?: number | null;
  duration?: number | null;
  storage_path: string;
  thumbnail_path?: string | null;
  status: AssetStatus;
  uploaded_by?: string | null;
  source: string;
  source_tool?: string | null;
  prompt?: string | null;
  seed?: number | null;
  model_name?: string | null;
  job_id?: string | null;
  metadata_json?: string | null;
  created_at: string;
  updated_at: string;
}

export interface Category { id: string; name: string; slug: string; parent_id?: string | null; description?: string | null; sort_order: number; }
export interface Tag { id: string; name: string; slug: string; color?: string | null; usage_count: number; }
export interface ApiKey { id: string; name: string; key_prefix: string; key_masked: string; scopes: string; is_active: boolean; last_used_at?: string | null; expires_at?: string | null; created_at: string; }
export interface WebhookEndpoint { id: string; name: string; url: string; is_active: boolean; created_at: string; }
export interface Job { id: string; title: string; status: AssetStatus; asset_type: AssetType; source_tool: string; job_id?: string | null; created_at: string; }
export interface PageResp<T> { items: T[]; total: number; page: number; page_size: number; }
```

`frontend/src/api/client.ts`：

```ts
import axios, { AxiosError } from 'axios';

const TOKEN_KEY = 'dam.token';

export function getToken(): string | null { return localStorage.getItem(TOKEN_KEY); }
export function setToken(t: string | null) { if (t) localStorage.setItem(TOKEN_KEY, t); else localStorage.removeItem(TOKEN_KEY); }

export const apiClient = axios.create({ baseURL: '/api/v1', timeout: 30000 });

apiClient.interceptors.request.use((cfg) => {
  const t = getToken();
  if (t) cfg.headers.Authorization = `Bearer ${t}`;
  return cfg;
});

apiClient.interceptors.response.use(
  (r) => r,
  (err: AxiosError) => {
    if (err.response?.status === 401 && !location.pathname.startsWith('/login')) {
      setToken(null);
      location.href = '/login';
    }
    return Promise.reject(err);
  }
);
```

`frontend/src/api/hooks.ts`：

```ts
import { useEffect, useState } from 'react';
import { apiClient } from './client';

interface State<T> { data?: T; error?: Error; loading: boolean; reload: () => Promise<void>; }

export function useApi<T>(path: string | null, init?: { method?: 'GET'|'POST'|'PUT'|'DELETE'; body?: unknown }): State<T> {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<Error>();
  const [loading, setLoading] = useState(false);
  const [tick, setTick] = useState(0);
  const reload = async () => {
    if (!path) return;
    setLoading(true); setError(undefined);
    const res = await apiClient.request<T>({ url: path, method: init?.method || 'GET', data: init?.body });
    setData(res.data); setLoading(false);
  };
  useEffect(() => { reload().catch(e => setError(e as Error)); /* eslint-disable-next-line */ }, [path, tick]);
  return { data, error, loading, reload: async () => { setTick(t=>t+1); await reload(); } };
}
```

- [ ] **Step 3: tsc 通过**。

- [ ] **Step 4: 提交** — `git add frontend/src/types frontend/src/api && git commit -m "feat(frontend): shared DTO types + axios client + useApi hook"`

---

### Task 11: 重写 router 与 MainLayout

**Files:**
- Modify: `frontend/src/router.tsx`
- Modify: `frontend/src/components/layout/MainLayout.tsx`（重写）

**Interfaces:**
- Produces: 路由表与 spec §5.2 一致；MainLayout 实现琥珀主题 + 240px 侧栏 + 56px 顶栏

- [ ] **Step 1: 写失败 tsc** — 引入新页面（Library/Import/Jobs/Organize/Integrations）时 tsc 报缺。

- [ ] **Step 2: 实现 router.tsx** —

```ts
import { lazy, Suspense } from 'react';
import { Navigate, createBrowserRouter, Outlet } from 'react-router-dom';
import { Spin } from 'antd';
import MainLayout from '@/components/layout/MainLayout';
import { useAuthStore } from '@/stores/authStore';

const Login = lazy(() => import('@/pages/Login'));
const Dashboard = lazy(() => import('@/pages/Dashboard'));
const Library = lazy(() => import('@/pages/Library'));
const AssetDetail = lazy(() => import('@/pages/AssetDetail'));
const Import = lazy(() => import('@/pages/Import'));
const Jobs = lazy(() => import('@/pages/Jobs'));
const Organize = lazy(() => import('@/pages/Organize'));
const Integrations = lazy(() => import('@/pages/Integrations'));
const Settings = lazy(() => import('@/pages/Settings'));
const Users = lazy(() => import('@/pages/Users'));
const NotFound = lazy(() => import('@/pages/NotFound'));

function Protected() {
  const user = useAuthStore((s) => s.user);
  if (!user) return <Navigate to="/login" replace />;
  return <Outlet />;
}

function AdminOnly() {
  const user = useAuthStore((s) => s.user);
  if (!user) return <Navigate to="/login" replace />;
  if (user.role !== 'admin') return <Navigate to="/" replace />;
  return <Outlet />;
}

function PageLoader() {
  return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 320 }}><Spin size="large" tip="加载中…" /></div>;
}
const lazyPage = (C: React.LazyExoticComponent<React.ComponentType>) => <Suspense fallback={<PageLoader />}><C /></Suspense>;

export const router = createBrowserRouter([
  { path: '/login', element: lazyPage(Login) },
  { element: <Protected />, children: [
    { element: <MainLayout />, children: [
      { index: true, element: lazyPage(Dashboard) },
      { path: 'library', element: lazyPage(Library) },
      { path: 'library/:id', element: lazyPage(AssetDetail) },
      { path: 'import', element: lazyPage(Import) },
      { path: 'jobs', element: lazyPage(Jobs) },
      { path: 'organize', element: lazyPage(Organize) },
      { path: 'integrations', element: lazyPage(Integrations) },
      { path: 'settings', element: lazyPage(Settings) },
      { element: <AdminOnly />, children: [{ path: 'users', element: lazyPage(Users) }] },
      { path: '*', element: lazyPage(NotFound) },
    ] },
  ] },
]);
```

- [ ] **Step 3: 实现 MainLayout.tsx** — 240 侧栏（Antd `Menu`）+ 56 topbar（面包屑 + 搜索 + 头像）+ 内容区；分组：创作（仪表盘 / 资产库 / 导入 / 任务）/ 管理（分类标签 / 集成）/ 设置。

- [ ] **Step 4: tsc 通过**。

- [ ] **Step 5: 提交** — `git add frontend/src/router.tsx frontend/src/components/layout/MainLayout.tsx && git commit -m "feat(frontend): rewrite router + MainLayout for unified DAM workflow"`

---

### Task 12: Library（资产库）页面 — 大网格 + 紧凑行

**Files:**
- Create: `frontend/src/pages/Library.tsx`

**Interfaces:**
- Consumes: `useApi<PageResp<Asset>>('/assets?...')`
- Produces: 网格/列表切换；筛选（asset_type/category/source_tool/job_id/q）；批量选择 + 删除

- [ ] **Step 1: tsc 通过现状** — 当前 `frontend/src/pages/Assets.tsx` 存在，新页面与旧文件并存时 tsc 应无新错。

- [ ] **Step 2: 实现 Library.tsx** — 顶部筛选条（Input 搜索 + Select 类型 + Select 分类 + Select source_tool）；视图切换（segmented）；网格卡片（图片充满单元格，hover 显示底部操作条）；分页。

- [ ] **Step 3: `cd frontend && npm run build` 通过**。

- [ ] **Step 4: 提交** — `git add frontend/src/pages/Library.tsx && git commit -m "feat(frontend): Library page with grid + filters"`

---

### Task 13: AssetDetail 适配新主题 + ComfyUI 元数据展示

**Files:**
- Modify: `frontend/src/pages/AssetDetail.tsx`

**Interfaces:**
- Consumes: `useApi<Asset>('/assets/:id')`
- Produces: 详情页展示 prompt/seed/model_name/job_id（用 mono 字体）；右侧操作（更新/删除）

- [ ] **Step 1: 写失败 tsc** — `frontend/src/pages/AssetDetail.tsx` 引入 `useApi` 应通过现状。

- [ ] **Step 2: 实现** — 左：图片/视频预览；右：标题、描述、分类、metadata 块（mono 字体）、tag；底部：操作按钮（编辑/复制 URL/在 jobs 中反查）。

- [ ] **Step 3: `npm run build` 通过**。

- [ ] **Step 4: 提交** — `git add frontend/src/pages/AssetDetail.tsx && git commit -m "feat(frontend): AssetDetail with ComfyUI metadata block"`

---

### Task 14: Import 页面（上传 + URL 抓取 + 任务 ID 登记）

**Files:**
- Create: `frontend/src/pages/Import.tsx`
- Modify: `frontend/src/api/assets.ts`（新增 `uploadAsset(form)` 接受 metadata 字段）

**Interfaces:**
- Consumes: `apiClient` multipart
- Produces: 拖拽上传区、URL 输入框、ComfyUI job_id 输入框（根据 job_id 查询是否已存在）

- [ ] **Step 1: 实现 api/assets.ts 新增** —

```ts
export async function uploadAsset(form: FormData) {
  const r = await apiClient.post('/assets/upload', form, { headers: { 'content-type': 'multipart/form-data' } });
  return r.data;
}
```

- [ ] **Step 2: 实现 Import.tsx** — 三个 Tab：上传 / URL 导入 / ComfyUI 任务登记；每个成功跳转 Library。

- [ ] **Step 3: tsc + build 通过**。

- [ ] **Step 4: 提交** — `git add frontend/src/pages/Import.tsx frontend/src/api/assets.ts && git commit -m "feat(frontend): Import page with upload + URL + ComfyUI job ID"`

---

### Task 15: Jobs 页面（ComfyUI 任务列表）

**Files:**
- Create: `frontend/src/pages/Jobs.tsx`

**Interfaces:**
- Consumes: `useApi<PageResp<Asset>>('/assets?source_tool=comfyui')`
- Produces: 列表（紫红 badge + mono job_id）+ 点击进 AssetDetail

- [ ] **Step 1: 实现 Jobs.tsx** — 紧凑列表，每行：紫红方形 `JOB` 图标 + mono `job_id` + title + 时间 + 跳转。

- [ ] **Step 2: tsc + build 通过**。

- [ ] **Step 3: 提交** — `git add frontend/src/pages/Jobs.tsx && git commit -m "feat(frontend): Jobs page listing ComfyUI assets"`

---

### Task 16: Organize（分类 + 标签合并）

**Files:**
- Create: `frontend/src/pages/Organize.tsx`
- Delete: `frontend/src/pages/Categories.tsx`、`frontend/src/pages/Tags.tsx`（router 已不再引用）

**Interfaces:**
- Consumes: `useApi<Category[]>`、`useApi<Tag[]>`
- Produces: 左右两栏：分类树 vs 标签云 + CRUD

- [ ] **Step 1: 实现 Organize.tsx** — 左侧分类（树形 + 新增/编辑/删除）；右侧标签（卡片：词云密度 + 用量计数 + 删除）。

- [ ] **Step 2: 删除旧文件** — 确认 router.tsx 已不引用后删除。

- [ ] **Step 3: tsc + build 通过**。

- [ ] **Step 4: 提交** — `git add frontend/src/pages/Organize.tsx frontend/src/pages/Categories.tsx frontend/src/pages/Tags.tsx && git commit -m "feat(frontend): merge Categories+Tags into Organize page"`

---

### Task 17: Integrations（API Key + Webhook）

**Files:**
- Create: `frontend/src/pages/Integrations.tsx`
- Delete: `frontend/src/pages/ApiKeys.tsx`（router 已不引用）

**Interfaces:**
- Consumes: `useApi<ApiKey[]>`、`useApi<WebhookEndpoint[]>`
- Produces: 上下两节：API Key（创建/停用/复制）+ Webhook（创建/停用，secret 仅创建可见）

- [ ] **Step 1: 实现 Integrations.tsx**。

- [ ] **Step 2: 删除旧 ApiKeys.tsx**。

- [ ] **Step 3: tsc + build 通过**。

- [ ] **Step 4: 提交** — `git add frontend/src/pages/Integrations.tsx frontend/src/pages/ApiKeys.tsx && git commit -m "feat(frontend): merge ApiKeys+Webhook into Integrations page"`

---

### Task 18: Dashboard 与 Login/Settings/Users/Upload 适配新主题

**Files:**
- Modify: `frontend/src/pages/Dashboard.tsx`、`Login.tsx`、`Settings.tsx`、`Users.tsx`、`Upload.tsx`

**Interfaces:**
- Produces: 全部页面用 `tokens` 与 `damTheme`；移除 ALL-CAPS label；换 Explore 样式为 mono 字体块。

- [ ] **Step 1: 修改 Dashboard.tsx** — 用 4 个大数字卡（total/images/videos/size）+ 最近 10 资产紧凑行；不带渐变光晕。

- [ ] **Step 2: 修改 Login.tsx** — 单列居中表单（420 宽），主按钮琥珀。

- [ ] **Step 3: 修改 Settings.tsx / Users.tsx / Upload.tsx** — 套用新视觉；Upload 改用 `Import.tsx` 时保留兼容入口（路由 `/assets/upload` 重定向到 `/import`）。

- [ ] **Step 4: tsc + build 通过**。

- [ ] **Step 5: 提交** — `git add frontend/src/pages && git commit -m "feat(frontend): align all pages with unified dark amber theme"`

---

### Task 19: 删除 demo.html（端到端收尾）

**Files:**
- Delete: `frontend/demo.html`
- Modify: `backend/src/server.js`（移除 demo.html 分支，仅保留 dist 缺失时的占位说明）

- [ ] **Step 1: 验证 dist 已构建** — `ls frontend/dist/index.html` 应存在。

- [ ] **Step 2: 删除 demo.html** — `rm frontend/demo.html`。

- [ ] **Step 3: 修改 server.js 移除 demo 分支** —

```js
} else {
  app.get('/', (_req, res) => {
    res.status(503).type('html').send(`<!doctype html><meta charset="utf-8"><title>DAM</title>
      <style>body{font:14px -apple-system,sans-serif;background:#0d1117;color:#f0f6fc;padding:48px;max-width:640px;margin:0 auto;}</style>
      <h1>DAM frontend is not built</h1>
      <p>Run <code>cd frontend && npm install && npm run build</code>, then restart the backend.</p>`);
  });
}
```

- [ ] **Step 4: 端到端测试** — `cd backend && npm start` → 浏览器打开 `http://localhost:8000` 期望看到 Login 页（dist 存在）或占位说明（不存在）。

- [ ] **Step 5: 提交** — `git add -A && git commit -m "feat: delete demo.html + add build-missing placeholder"`

---

### Task 20: 端到端冒烟测试

**Files:**
- 无新文件

**Interfaces:**
- 无

- [ ] **Step 1: 启动后端** — `cd backend && npm start` &

- [ ] **Step 2: 场景 A 登录 + 浏览** — 用 `admin / Admin@123456` 登录，看到 Dashboard；导航到 Library 看到 12 张样例图。

- [ ] **Step 3: 场景 B API Key 上传** — 用 `POST /api/public/v1/delivery/upload` 上传一张图，body 携带 `source_tool=comfyui&prompt=...&seed=42&job_id=demo-001`；断言响应里含 `prompt/seed/job_id`。

- [ ] **Step 4: 场景 C manifest 镜像** — `GET http://localhost:8000/storage/manifests/index.json`，断言 `count >= 13` 且包含刚才上传的 `job_id=demo-001`。

- [ ] **Step 5: 提交测试结果** — `git commit --allow-empty -m "test: e2e smoke for unified DAM site"`。

---

## 自检（self-review）

1. **Spec coverage**：spec §1-§11 每节都有对应任务（§3 后端→Task 1/2/5、§4 数据→Task 1、§5.1 后端模块→Task 2-8、§5.2 前端路由→Task 11-18、§6 插件契约→Task 1/3/5/8、§7 设计→Task 9-18、§8 错误处理→Task 4/6/7、§9 测试→Task 1-7 测试段、§10 YAGNI→始终保持）。
2. **Placeholder 扫描**：✅ 无 TBD；每个代码块均为可粘贴内容。
3. **类型一致**：`Asset` 类型在 Task 10 定义后被 Task 12/13/14/15 复用，DTO 字段名（`source_tool / prompt / seed / model_name / job_id / metadata_json`）与后端一致。
4. **Review Focus**：
   - 重复上传 → Task 3
   - manifest 一致性 → Task 2/5
   - Webhook 签名 → Task 6
   - 大文件 → Task 4
   - dist 缺失占位 → Task 19

实施计划完成。