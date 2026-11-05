# DAM 初始化路径（部署向导 · 热加载） —— 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `/init` 变成一条可直接部署的路径：三页填完（数据库 → 管理员 → 种子），当前进程**热加载**即成为可用实例，不需要重启、不产生示例资产、不凭空签发 API Key。

**Architecture:** 后端三处补强 —— `lib/db.js` 的 handle 支持换池（`rebind` + `get pool()`）、`lib/init.js` 新增 `applyEnvToProcess`（只应用向导拥有的六个键）、新增 `lib/reload.js` 的 `reloadConfiguration` 按十步顺序完成「建池 → 换池 → 补表 → 补种子 → 收尾 → 关旧池」。`routes/init.js` 的 `/seed` 改成「种子 → 热加载 → 最后写 `JWT_SECRET`」的顺序，写密钥是唯一的锁门动作，因此失败可重试；`/restart` 与 `onRestart` 删除。前端第三页 `InitReview` 改名 `InitSeed`，去掉 `api_key` 展示与重启按钮。判定规则（`hasConfiguration` / `isInitialized` / `initStatus`）一个字不改 —— 改的只是 `.env.example` 模板不再带占位密钥。

**Tech Stack:** Node.js 25 · Express 4 · mysql2 3 · React 18 · TypeScript 5 · Vite 6 · Ant Design 5 · MySQL 5.7

**Spec:** `docs/superpowers/specs/2026-11-05-dam-init-path-design.md`

## Global Constraints

- **规格是唯一权威** —— 本计划是它的论证；两者冲突时以规格为准，冲突要记进 ledger 的 `Ruling:` 行。
- **不新增第三方依赖。**
- **模块系统**：后端 CommonJS（`require`），前端 ESM（`import`），`tests/` ESM，`tests/backend/` CommonJS。不要改。
- **单文件 300–500 行以内，单函数 ≤ 50 行。** `lib/init.js` 与 `lib/db.js` 已接近上限 —— 热加载逻辑放独立模块 `lib/reload.js`，`init.js` 删掉 `/restart` 与 Setup Key 后净减少。
- **文件必须以 `0x0a` 结尾。**
- **不留 stub / TODO / 省略号。**
- **布尔值以 `is` / `has` / `can` 开头；前端不用 `any`。**
- **每完成一个任务都要提交**，提交信息末尾带 `Co-Authored-By: Claude Code <noreply@anthropic.com>`。
- **提交前必须跑**：`npm run test:backend` 与 `npm run test:contract`。
- **测试跑在 3307 的一次性实例上**（`DB_PORT=3307 DB_USER=dam DB_PASSWORD=`）。**绝不让任何测试指向 3306。** `tests/backend/init.test.js` 的 `adminConnection()` / `querySchema()` 在 `DB_*` 未设时默认连 `127.0.0.1:3306` + `root` —— 每次跑之前必须导出那三个变量。
- **绝不打印 `.env` 的 `DB_PASSWORD`；绝不把口令写在命令行上。**
- **不手工改用户的 `.env`** —— 本轮只改 `.env.example` 模板。
- **所有面向用户的文案用中文。**
- **判定规则不改**：`hasConfiguration()` / `isInitialized()` / `initStatus()` 的逻辑，以及 `config.js:95` 的开发占位兜底，**一个字都不动**（规格 §6 明确要求）。

## Review Focus

以下五类输入/状况最容易咬人，每个都要有对应的测试，落在拥有该代码的任务里：

1. **并发双击「完成」** —— 运维手快，页面连发两个 `POST /api/init/seed`。两次必须**共享同一个结果**（都返回成功），且只换一次池、只关一次旧池。规格 §3.3 的模块级单飞。→ 落在 Task 5。
2. **热加载中途失败** —— 新库连不上、`initSchema` 抛错。此时 `JWT_SECRET` **不能**已写入，实例必须仍显示"未初始化"，向导仍打开，`/seed` 可以原样重试。规格 §4.6 的失败语义表。→ 落在 Task 5。
3. **向导写出的 `.env` 把注入的 `STORAGE_DIR` 覆盖成 `./storage`** —— `renderEnv()` 以 `.env.example` 为骨架，未提供的键保留模板值。若热加载"应用文件里的一切"，`getConfig().storageDir` 会跳到仓库根下，`writeManifestIndex` 写进开发者的真实 storage 目录。→ 落在 Task 2。
4. **旧池正在被借走时换池** —— `rebind` 之后仍有 in-flight 语句跑在旧池上。旧池 `end()` 必须等它排空，失败只 warn，不能让整个 `/seed` 失败。规格 §4.2/§4.6。→ 落在 Task 1（`rebind` 语义）与 Task 3（关旧池）。
5. **`.env` 里已有一个非空 `JWT_SECRET`** —— 部署者在第一页之前就手填过密钥。第三页必须**复用**它，绝不轮换（轮换会让已签发的令牌全部失效）。→ 落在 Task 5。

## 前置条件

运行时测试需要一个 MySQL 8 实例。用仓库自带的一次性实例：

```bash
export DB_PORT=3307 DB_USER=dam DB_PASSWORD=
```

未启动时从 `E:\mysql\bin\` 用 datadir `.mysql-dev/data` 起一个。**不要用 3306**（那是用户自己的实例，上面还有别的项目的库）。

---

## 文件结构

| 文件 | 责任 | 动作 |
|---|---|---|
| `src/server/lib/db.js` | 连接池与 handle；换池能力 | Modify：`rebind` / `get pool()` |
| `src/server/lib/init.js` | `.env` 读写、初始化判定 | Modify：新增 `applyEnvToProcess` |
| `src/server/lib/reload.js` | 热加载的十步编排 | Create |
| `src/server/routes/init.js` | 向导端点 | Modify：`/seed` 重写、删 `/restart`、收 `reload` 依赖 |
| `src/server/server.js` | 启动装配 | Modify：传 `reload`、热加载后翻 `app.locals` |
| `src/server/lib/seed.js` | 默认数据 | Modify：删 `seedApiKey`、分类标签按表事务 |
| `src/server/config.js` | 配置读取 | Modify：`SEED_SAMPLE_ASSETS` 默认关 |
| `src/server/scripts/seed.js` | `npm run seed` 入口 | Modify：文案 |
| `.env.example` | 模板 | Modify：`JWT_SECRET=` 空、`SEED_SAMPLE_ASSETS=0` |
| `docker-compose.yml` | 容器默认 | Modify：`SEED_SAMPLE_ASSETS: "0"` |
| `src/client/pages/init/initApi.ts` | 前端 API 封装 | Modify：删 `restart`、去掉 `api_key` |
| `src/client/pages/init/initSteps.ts` | 步骤常量 | Modify：`STEP_REVIEW` → `STEP_SEED` |
| `src/client/pages/init/InitSeed.tsx` | 第三页 | Create（由 `InitReview.tsx` 改名重写） |
| `src/client/pages/init/InitReview.tsx` | — | Delete |
| `src/client/pages/init/InitWizard.tsx` | 向导壳 | Modify：import、Steps 标题 |
| `src/client/main.tsx` | 未初始化时跳 `/init` | **不动** —— 规格 §5.4 明确"不变" |
| `tests/backend/init.test.js` | 向导后端测试 | Modify：断言换代 |
| `tests/backend/acceptance.probe.js` | 手工验收脚本 | Modify：改用 `POST /api/v1/api-keys` |
| `README.md` | 文档 | Modify：向导一节、配置表、安全条目 |

---

# 阶段 A · 热加载的地基

### Task 1: `createDb` 支持换池

**Files:**
- Modify: `src/server/lib/db.js:115-279`（`createDb` 整体）
- Test: `tests/backend/init.test.js`

**Interfaces:**
- Consumes: 现有 `createPool(config)`、`normalizeParams(params)`
- Produces:
  - `createDb(pool)` 返回的 handle 上新增 `rebind(nextPool): void`
  - handle 的 `pool` 属性从只读字段改为 getter（`get pool()`，返回当前活动池）

- [ ] **Step 1: 写失败的测试**

在 `tests/backend/init.test.js` 里加一个 phase：造一个 handle（用 `createDb(createPool(config))`），记录 `handle.pool`，调用 `handle.rebind(otherPool)`，断言 `handle.pool === otherPool`；再用 `await handle.prepare('SELECT 1 AS n').get()` 断言查询仍然可用（走新池）；断言 `otherPool !== originalPool`。

再加一条：换池后 in-flight 语句不受影响 —— 拿到 `handle.pool` 的引用后再 `rebind`，旧池对象本身仍然 `end()` 得掉（不是被 handle 吞掉）。

- [ ] **Step 2: 跑测试确认失败**

```bash
export DB_PORT=3307 DB_USER=dam DB_PASSWORD=
node tests/backend/init.test.js
```

预期：`handle.rebind is not a function`。

- [ ] **Step 3: 实现**

把 `createDb(pool)` 改成用 `activePool` 闭包变量承接，所有语句在**调用时**读 `activePool`：

```js
function createDb(pool) {
  let activePool = pool;

  const handle = {
    prepare(sql) {
      return {
        run: (params = []) => activePool.execute(sql, normalizeParams(params)),
        get: (params = []) => activePool.execute(sql, normalizeParams(params)).then(([rows]) => rows[0]),
        all: (params = []) => activePool.execute(sql, normalizeParams(params)).then(([rows]) => rows),
      };
    },
    async query(sql, params = []) { ... },
    async exec(sql) { ... },
    async transaction(fn) { const connection = await activePool.getConnection(); ... },

    /**
     * Point every later statement at a different pool.
     * In-flight statements keep the pool they started on; the caller owns
     * closing the old one.
     */
    rebind(nextPool) { activePool = nextPool; },

    /** The pool in use right now. */
    get pool() { return activePool; },
  };

  return handle;
}
```

要点：`prepare()` 返回的对象在**调用时**读 `activePool`，不是创建时 —— 这样换池之后同一个 handle 上的后续语句走新池。`pool` 从只读属性改成 getter，`tests/backend/*.js` 里 `app.locals.db.pool.end()` 的写法继续有效。`rebind` **不关旧池** —— 关池是调用方的责任。

`connect(config)`（`db.js:272-275`）与 `createPool` 不改。

- [ ] **Step 4: 跑测试确认通过**

```bash
export DB_PORT=3307 DB_USER=dam DB_PASSWORD=
node tests/backend/init.test.js
```

- [ ] **Step 5: 提交**

```bash
git add src/server/lib/db.js tests/backend/init.test.js
git commit -m "feat(db): the handle can be pointed at another pool

The init wizard has to rebind the running application to the database
the operator just typed in. The old pool is not closed here: the
caller closes it, after it knows the new one works."
```

---

### Task 2: `applyEnvToProcess` —— 只应用向导拥有的六个键

**Files:**
- Modify: `src/server/lib/init.js`（新增导出函数）
- Test: `tests/backend/init.test.js`

**Interfaces:**
- Consumes: 现有 `readEnvFile(envFile)`（返回键值对象）
- Produces: `applyEnvToProcess(envFile): void` —— 把 `DB_HOST` / `DB_PORT` / `DB_USER` / `DB_PASSWORD` / `DB_NAME` / `JWT_SECRET` 六个键从文件写进 `process.env`

- [ ] **Step 1: 写失败的测试**

在 `tests/backend/init.test.js` 加一个 phase：

1. 往 `process.env` 注入 `STORAGE_DIR=/tmp/injected-storage` 与 `PORT=9999`；
2. 写一个 `.env` 文件，内容含 `DB_NAME=dam_reload_test`、`JWT_SECRET=abc`、`STORAGE_DIR=./storage`、`PORT=8000`；
3. 调 `applyEnvToProcess(envFile)`；
4. 断言 `process.env.DB_NAME === 'dam_reload_test'`、`process.env.JWT_SECRET === 'abc'`；
5. **断言 `process.env.STORAGE_DIR` 仍是 `/tmp/injected-storage`**、`process.env.PORT` 仍是 `9999` —— 模板值不得覆盖注入值。

（测试结束要还原 `process.env` 里被改动的键，避免污染同进程里的其它 phase。）

- [ ] **Step 2: 跑测试确认失败**

```bash
export DB_PORT=3307 DB_USER=dam DB_PASSWORD=
node tests/backend/init.test.js
```

预期：`applyEnvToProcess is not a function`。

- [ ] **Step 3: 实现**

在 `src/server/lib/init.js` 里新增并导出：

```js
/**
 * The keys the wizard owns. Everything else in the file is a template
 * default and must not overwrite what the process was started with.
 */
const WIZARD_ENV_KEYS = [
  'DB_HOST', 'DB_PORT', 'DB_USER', 'DB_PASSWORD', 'DB_NAME', 'JWT_SECRET',
];

function applyEnvToProcess(envFile) {
  const values = readEnvFile(envFile);
  for (const key of WIZARD_ENV_KEYS) {
    if (Object.prototype.hasOwnProperty.call(values, key)) {
      process.env[key] = values[key];
    }
  }
}
```

关键：**不能用 `dotenv.config({ override: true })`，也不能"文件里有什么就应用什么"。** `renderEnv()` 以 `.env.example` 为骨架逐行渲染，没给值的键保留模板值 —— 所以向导写出的 `.env` 必然带着 `PORT=8000`、`HOST=0.0.0.0`、`STORAGE_DIR=./storage`、`DB_POOL_SIZE=10`、`UPLOAD_MAX_FILE_SIZE_MB=2048`、`SEED_SAMPLE_ASSETS=0`。全量应用会把 shell/容器注入的 `STORAGE_DIR` 覆盖成 `./storage`。

同时把 `applyEnvToProcess` 加进 `module.exports`（现在是九项：`readEnvFile, renderEnv, hasConfiguration, writeEnvFile, mergeEnv, isInitialized, initStatus, resolveInitToken, isStrongPassword`）。

- [ ] **Step 4: 跑测试确认通过**

```bash
export DB_PORT=3307 DB_USER=dam DB_PASSWORD=
node tests/backend/init.test.js
```

- [ ] **Step 5: 提交**

```bash
git add src/server/lib/init.js tests/backend/init.test.js
git commit -m "feat(init): only the six wizard-owned keys reach the process

The rendered .env carries every template default, so applying the
whole file would overwrite the storage directory the process was
started with."
```

---

### Task 3: `reloadConfiguration` —— 热加载的十步

**Files:**
- Create: `src/server/lib/reload.js`
- Test: `tests/backend/init.test.js`

**Interfaces:**
- Consumes:
  - `applyEnvToProcess(envFile)`（Task 2）
  - `db.rebind(nextPool)`（Task 1）
  - `getConfig()`（`src/server/config.js`）
  - `ensureDatabase(config)`、`createPool(config)`（`src/server/lib/db.js`）
  - `initSchema(db)`（`src/server/lib/schema.js`）
  - `seedDatabase(db, storageDir, options)`（`src/server/lib/seed.js`，Task 4 会改它）
  - `replayPendingManifestWrites(db, storageDir)`、`writeManifestIndex(...)`（`src/server/lib/manifest.js`）
- Produces: `reloadConfiguration({ db, envFile })` → `Promise<{ ok: true }>`

- [ ] **Step 1: 写失败的测试**

在 `tests/backend/init.test.js` 加一个 phase：

1. 用临时 `.env`（含 `DB_*` 指向测试库）与临时 `STORAGE_DIR`；
2. 造 `db = createDb(createPool(config))`，把 `app.locals.db` 指向它；
3. 调 `reloadConfiguration({ db, envFile })`；
4. 断言返回 `{ ok: true }`；
5. 断言 `db.pool` 换成了新的池（与调用前的池不是同一个对象）；
6. 断言新库里有 `tenants` 行与初始分类/标签行（热加载跑完了 boot 收尾）。

再加两条：

- **失败路径**：把 `.env` 里的 `DB_USER` 改成一个不存在的账号，调 `reloadConfiguration` 应当**抛错**（reject），而不是静默成功；
- **旧池排空**：换池之前先在旧池上跑一条长查询占住一个连接，`reloadConfiguration` 之后断言旧池 `end()` 是**等它跑完**才 resolve 的（不等的话 `end()` 会把那条查询打断）。这条锁住规格 §4.6 的"已在飞行中的查询走的是旧池，`end()` 会等它完成"。

- [ ] **Step 2: 跑测试确认失败**

```bash
export DB_PORT=3307 DB_USER=dam DB_PASSWORD=
node tests/backend/init.test.js
```

预期：`Cannot find module '../src/server/lib/reload'`。

- [ ] **Step 3: 实现**

`src/server/lib/reload.js`：

```js
'use strict';

/**
 * Configuration reload.
 *
 * The init wizard writes .env and then rebinds the running application
 * to the database the operator just configured. The order matters: the
 * seed runs before the JWT secret is written, so a failure here leaves
 * the instance uninitialized and the wizard open.
 */

const { getConfig } = require('../config');
const { createPool, ensureDatabase } = require('./db');
const { initSchema } = require('./schema');
const { seedDatabase } = require('./seed');
const { applyEnvToProcess } = require('./init');
const { replayPendingManifestWrites, writeManifestIndex } = require('./manifest');

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
    console.warn('[reload] manifest replay failed:', error.message);
  }

  if (previousPool && previousPool !== nextPool) {
    try {
      await previousPool.end();
    } catch (error) {
      console.warn('[reload] closing the previous pool failed:', error.message);
    }
  }

  return { ok: true };
}

module.exports = { reloadConfiguration };
```

要点：

- **步骤顺序就是规格 §4.4 的十步**，不可调换 —— 尤其"换池"在"补表"之前，"补种子"在"写密钥"之前（写密钥在 `/seed` 里做，不在这里）。
- `initSchema(db)` 与 `seedDatabase(db, ...)` 跑在**新池**上（`db.rebind` 之后 handle 已经指向新池）。
- manifest 收尾失败只 warn —— boot 期就是 `try/catch` + `console.warn('[manifest] startup replay failed', ...)`，两处保持同一种处理。
- 旧池 `end()` 失败只 warn，不让整个 `/seed` 失败。
- 日志前缀统一 `[reload]`。

- [ ] **Step 4: 跑测试确认通过**

```bash
export DB_PORT=3307 DB_USER=dam DB_PASSWORD=
node tests/backend/init.test.js
```

- [ ] **Step 5: 提交**

```bash
git add src/server/lib/reload.js tests/backend/init.test.js
git commit -m "feat(reload): the application can pick up a new .env without restarting"
```

---

# 阶段 B · 向导第三页与种子

### Task 4: 种子只种分类与标签

**Files:**
- Modify: `src/server/lib/seed.js`
- Test: `tests/backend/init.test.js`

**Interfaces:**
- Consumes: 现有 `seedDatabase(db, storageDir, options)`、`seedAdmin`、`seedCatalogue`
- Produces: `seedDatabase` 不再种 API Key；`seedCatalogue` 按表各一个事务

- [ ] **Step 1: 写失败的测试**

在 `tests/backend/init.test.js` 加一个 phase：

1. 调 `seedDatabase(db, storageDir, { tenantId })`；
2. 断言该租户下 `categories` 有 4 行、`tags` 有 8 行；
3. 断言该租户下 `api_keys` **0 行**；
4. 断言重复调用 `seedDatabase` 之后行数不变（幂等）。

再加一条：先把 `tags` 清空、保留 `categories`，再调一次 `seedDatabase`，断言 `tags` 被补回 8 行（现状下这个场景因粗粒度 gate 而补不回来）。

- [ ] **Step 2: 跑测试确认失败**

```bash
export DB_PORT=3307 DB_USER=dam DB_PASSWORD=
node tests/backend/init.test.js
```

预期：第 3 条断言失败（`api_keys` 有 1 行），第 4 条断言失败（`tags` 补不回来）。

- [ ] **Step 3: 实现**

在 `src/server/lib/seed.js` 里：

1. **整段删除 `seedApiKey` 函数**，并删掉 `seedDatabase` 里对它的调用（`await seedApiKey(db, tenantId);`）。该函数当前的形态是：raw key = `dam_` + `crypto.randomBytes(24).toString('hex')`，sha256 后入库，prefix `rawKey.slice(0, 12)`，名字 `'Demo Key'`，scopes `'read,upload,delete'`，并 `console.log('[seed] demo api key:', ...)` 明文。**这四样全部随函数一起消失** —— API Key 的唯一来源是 `POST /api/v1/api-keys`。
2. **`seedCatalogue` 改成按表各一个事务**。现状是一个查询 `SELECT COUNT(*) AS c FROM categories WHERE tenant_id = ?`，`if (categoryCount.c > 0) return;` —— 分类写入失败后，标签永远种不上。改成：

   - 分别 COUNT `categories` 与 `tags`；
   - `categories` 为 0 时，在 `db.transaction` 里插完 4 条（产品图/product、营销素材/marketing、AI 生成/ai-generated、视频/video）；
   - `tags` 为 0 时，在 `db.transaction` 里插完 8 条（封面、海报、人物、风景、抽象、品牌、SVG、动效），slug = `tag.toLowerCase()`；
   - 部分失败整表回滚，重试从 0 开始；
   - 已经成功种过的表仍被计数挡住 —— 运维删掉的默认分类不会在下次 boot 时复活，这个语义不能丢。

3. `seedSampleAssets` 与 `SAMPLE_DEFS` **保留不动**，只由 `config.seedSampleAssets` 控制是否调用。
4. `module.exports`（现在是 `{ seedDatabase, seedSampleAssets, SAMPLE_DEFS }`）**不用改** —— `seedApiKey` 本来就没有导出，删掉函数即可。

- [ ] **Step 4: 跑测试确认通过**

```bash
export DB_PORT=3307 DB_USER=dam DB_PASSWORD=
node tests/backend/init.test.js
```

- [ ] **Step 5: 提交**

```bash
git add src/server/lib/seed.js tests/backend/init.test.js
git commit -m "fix(seed): no API key, and the catalogue seeds per table

The wizard used to hand out a key nobody asked for. The catalogue now
seeds categories and tags in separate transactions, so a failure in the
middle no longer locks the tags out forever."
```

---

### Task 5: `/seed` 重写 —— 种子 → 热加载 → 最后写密钥

**Files:**
- Modify: `src/server/routes/init.js`
- Modify: `src/server/server.js`
- Test: `tests/backend/init.test.js`

**Interfaces:**
- Consumes:
  - `reloadConfiguration({ db, envFile })`（Task 3）
  - `mergeEnv(file, patch)`、`writeEnvFile(file, values, templateFile)`、`readEnvFile(file)`（`src/server/lib/init.js`）—— `writeEnvFile` 的第三个参数 `templateFile` 是**必填**的（`renderEnv` 以它为骨架），本文件里已有 `templateFileOf()` 提供它
  - `initSchema(db)`、`seedDatabase(db, storageDir, { tenantId })`
  - `createInitRouter.tokenChecker(token)`、`createInitRouter.envFileOf(...)`、`createInitRouter.closeWizardDb()`（现有导出）
- Produces:
  - `createInitRouter({ db, checkToken, reload })` —— **`onRestart` 参数删除**，`reload` 是必需依赖
  - `POST /api/init/seed` → `{ ok: true, jwt_secret_written: true }`（**响应体里没有 `api_key`**）
  - `POST /api/init/restart` **删除**

- [ ] **Step 1: 写失败的测试**

改写 `tests/backend/init.test.js` 第 6 步（`init.test.js:404-433`，现有断言是 `assert.ok(seed.body.api_key, ...)` 与 `assert.strictEqual(seededKeys.length, 1, ...)`）：

1. 断言 `seed.body.ok === true`；
2. 断言 `seed.body.api_key === undefined`（响应里不再有明文密钥）—— **替换**现有的 `assert.ok(seed.body.api_key, ...)` 与 `String(seed.body.api_key).startsWith('dam_')` 两段；
3. 断言 `seed.body.jwt_secret_written === true`；
4. 断言该租户下 `api_keys` 表 **0 行** —— **替换**现有的 `assert.strictEqual(seededKeys.length, 1, 'the seed step must create one key for the tenant')`；
5. 断言 `.env` 里有非空 `JWT_SECRET`（现有的 `secretMatch` 断言**保留**）；
6. **免重启断言**：用刚才第二页创建的管理员账号调 `POST /api/v1/auth/login`，拿到 `access_token`，再拿它调一个需要鉴权的只读端点（`GET /api/v1/assets`）返回 200 —— 这证明热加载已经生效，进程没重启也能用。**替换**现有的那段 `X-API-Key` 投递断言（`init.test.js:425-433`）—— 那一段现在没有 key 可用了。

   这条断言站得住的原因：`init.test.js` 的 `bootServer()`（`:175-187`）是**在同一个进程里** `require('../../src/server/server')`，而签发与校验令牌用的都是 `getConfig().jwtSecret`（`src/server/routes/auth.js:78`、`src/server/lib/auth.js:33`）—— `getConfig()` 每次调用都重新读 `process.env`。所以 `/seed` 一写 `process.env.JWT_SECRET`，登录立刻可用，不需要重启任何东西；
7. 断言分类 4 行、标签 8 行；
8. **第二次**调 `POST /api/init/seed` 返回 404 —— 这一条**已经存在**（`init.test.js:447-450` 的第 8 步"the wizard closes behind itself"），**保留不动**，它正好锁住"热加载已让向导关门"。

再加两条本任务专属的：

9. **并发双击**：同时 `Promise.all` 两个 `POST /api/init/seed`，断言两个响应都是 `{ ok: true }`（不是 409、不是其中一个失败），且 `api_keys` 仍 0 行；
10. **已有 `JWT_SECRET` 不被轮换**：先在 `.env` 里写死一个 `JWT_SECRET=fixed-secret-value`，跑完向导后断言 `.env` 里仍是 `fixed-secret-value`（没被换成随机值）。

- [ ] **Step 2: 跑测试确认失败**

```bash
export DB_PORT=3307 DB_USER=dam DB_PASSWORD=
node tests/backend/init.test.js
```

预期：第 2 条断言失败（现在响应里有 `api_key`）、第 6 条失败（现在必须重启进程才能登录）。

- [ ] **Step 3: 实现**

**`src/server/routes/init.js`：**

1. **模块级单飞**。在文件顶部（`cachedDb` 附近）加：

   ```js
   /** The in-flight reload, if one is running. Concurrent seed requests share it. */
   let reloadInFlight = null;
   ```

2. **`/seed` 重写**，顺序严格按规格 §3.3：

   1. 读 `.env`，取 `DB_*` 与已有的 `JWT_SECRET`；
   2. 用这些值连库（向导自己的连接），跑 `initSchema`；
   3. 查第一个租户，没有则 400 `'The administrator step has not run yet'`；
   4. `seedDatabase(db, storageDir, { tenantId })`；
   5. **热加载**（`await reload()`）—— 失败则直接抛错返回 400/500，**此时 `JWT_SECRET` 尚未写入**，实例仍是"未初始化"，向导仍打开；
   6. **最后**写 `JWT_SECRET`：复用 `.env` 里已有的非空值，没有则 `crypto.randomBytes(32).toString('hex')`；用 `mergeEnv(envFile, { JWT_SECRET: secret })` + `writeEnvFile(envFile, merged, templateFileOf())` 原子写入（`writeEnvFile` 的第三个参数不能省 —— `renderEnv` 以模板为骨架），同时 `process.env.JWT_SECRET = secret`；
   7. 响应 `{ ok: true, jwt_secret_written: true }`。

   **单飞的写法**：`reload()` 的调用包在一个模块级 promise 里：

   ```js
   if (!reloadInFlight) {
     reloadInFlight = Promise.resolve()
       .then(() => reload())
       .finally(() => { reloadInFlight = null; });
   }
   await reloadInFlight;
   ```

   后来的请求复用同一个 promise，**返回同一份结果**（不是 409）。前端按钮的 loading 只是体验，不是并发控制。

   **注意**：`JWT_SECRET` 的写入在单飞之外 —— 每次 `/seed` 都各自写一次自己读到的值，两次写的是同一个值（第一个写进去之后，第二个从 `.env` 里读到的就是它），结果一致。

3. **删除 `/restart`**（`routes/init.js:373-384`）与 `onRestart` 依赖。`createInitRouter` 的参数从 `{ db, checkToken, onRestart }` 改成 `{ db, checkToken, reload }`；`reload` 缺失时抛错（启动期装配错误要显式暴露）。

   **同时删掉 `/seed` 里那段 Setup Key 的铸造**（现在在 `routes/init.js:313-345`）：它会 `SELECT COUNT(*) FROM api_keys WHERE tenant_id = ?`，为 0 时插一条名字叫 `'Setup Key'` 的行，明文返回给前端。**整段删除** —— 包括 `const existingKey = ...`、`let apiKey = null`、`if (Number(existingKey.c) === 0) { ... }` 这三块。`nanoid` 的 require **保留**（`:264` 与 `:277` 还在用它）。

4. **更新文件头的契约注释**（`routes/init.js:12-18`）：`POST /seed -> { ok, jwt_secret_written }`（去掉 `api_key`），删掉 `POST /restart -> 202` 那一行。顺手修正那行过时的镜像注释 —— 它写的是 `frontend/src/api/init.ts`，实际前端文件是 `src/client/pages/init/initApi.ts`。

5. **`DEV_PLACEHOLDER_SECRET` 与 `keepsSecret` 保留** —— 它防的是"用户自己把占位符抄进了 `.env`"，与 `.env.example` 模板清理互补。

**`src/server/server.js`：**

1. 现在的装配是：

   ```js
   app.use('/api/init', createInitRouter({
     db: isConfigured ? db : null,
     checkToken: createInitRouter.tokenChecker(initToken.token),
     onRestart: () => process.exit(0),
   }));
   ```

   改成：

   ```js
   app.use('/api/init', createInitRouter({
     db: isConfigured ? db : null,
     checkToken: createInitRouter.tokenChecker(initToken.token),
     reload: () => reloadConfiguration({ db, envFile: ENV_FILE }),
   }));
   ```

   `reloadConfiguration` 从 `src/server/lib/reload.js` require 进来。

2. **热加载之后翻 `app.locals`**：`app.locals.isConfigured = true`，`app.locals.ready = Promise.resolve()`（现在是 boot 期那个 `ready` promise），并调 `createInitRouter.closeWizardDb()` 关掉向导自己那条连接（否则每次部署都多留一个指向同一个库的池）。

   具体做法：`reload` 闭包里除了调 `reloadConfiguration`，还要在它成功后执行这三件事：

   ```js
   reload: async () => {
     const result = await reloadConfiguration({ db, envFile: ENV_FILE });
     app.locals.isConfigured = true;
     app.locals.ready = Promise.resolve();
     // The wizard kept a connection of its own; the application now has
     // its own pool on the same schema, so the wizard's is one too many.
     await createInitRouter.closeWizardDb();
     return result;
   },
   ```

   `closeWizardDb()` 是 **async**（`routes/init.js:100-107`），必须 `await`。它内部已经把 `pool.end()` 的失败吞成 `.catch(() => {})`，所以 await 它不会让 `/seed` 失败。

   `app.locals.ready` 的赋值发生在 boot 之后（`server.js:232`），但闭包里的这次赋值发生在**请求时**，所以它会盖掉 boot 期那个 promise —— 这正是我们要的。

3. `server.js:59` 的 `const config = getConfig()` 与 `:74` 的 `const db = createDb(createPool(config))` **不动** —— `db` 是 handle，换池靠 `rebind`。

- [ ] **Step 4: 跑测试确认通过**

```bash
export DB_PORT=3307 DB_USER=dam DB_PASSWORD=
node tests/backend/init.test.js
```

- [ ] **Step 5: 跑全量后端与契约**

```bash
export DB_PORT=3307 DB_USER=dam DB_PASSWORD=
npm run test:backend
npm run test:contract
```

- [ ] **Step 6: 提交**

```bash
git add src/server/routes/init.js src/server/server.js tests/backend/init.test.js
git commit -m "feat(init): the seed step hot-reloads the instance

The JWT secret is written last, after the reload succeeded, so a failed
reload leaves the instance uninitialized and the wizard open for
another try. Concurrent seed calls share one reload and both see the
same result."
```

---

# 阶段 C · 模板、种子默认与前端

### Task 6: 示例资产默认关闭

**Files:**
- Modify: `src/server/config.js:108`
- Modify: `.env.example:46-49`
- Modify: `docker-compose.yml`
- Modify: `src/server/scripts/seed.js`
- Modify: `README.md`（配置表那一行）
- Test: `tests/backend/init.test.js`

**Interfaces:**
- Consumes: `config.seedSampleAssets`（现有）
- Produces: `config.seedSampleAssets` 的默认值从"开"翻成"关"

- [ ] **Step 1: 写失败的测试**

在 `tests/backend/init.test.js` 加一个 phase。`config.js` 导出的是函数 `getConfig()`（每次调用重新读 `process.env`，没有模块级缓存），所以直接逐次调用来测：

```js
const { getConfig } = require('../../src/server/config');

const original = process.env.SEED_SAMPLE_ASSETS;
try {
  delete process.env.SEED_SAMPLE_ASSETS;
  assert.strictEqual(getConfig().seedSampleAssets, false, 'unset must mean off');

  process.env.SEED_SAMPLE_ASSETS = '1';
  assert.strictEqual(getConfig().seedSampleAssets, true);

  process.env.SEED_SAMPLE_ASSETS = '0';
  assert.strictEqual(getConfig().seedSampleAssets, false);
} finally {
  if (original === undefined) delete process.env.SEED_SAMPLE_ASSETS;
  else process.env.SEED_SAMPLE_ASSETS = original;
}
```

四个断言的要点：**未设置 = 关**；`'1'` = 开；`'0'` = 关；改完要把 `process.env` 还原，不污染同进程里的其它 phase。

- [ ] **Step 2: 跑测试确认失败**

```bash
export DB_PORT=3307 DB_USER=dam DB_PASSWORD=
node tests/backend/init.test.js
```

预期：第 2 条失败（现在未设置时是 `true`）。

- [ ] **Step 3: 实现**

1. **`src/server/config.js:108`**：现在是 `seedSampleAssets: process.env.SEED_SAMPLE_ASSETS !== '0',`。改成：

   ```js
   seedSampleAssets: process.env.SEED_SAMPLE_ASSETS === '1',
   ```

   语义从"除非明确写 0，否则开"变成"只有明确写 1 才开"。注意：现有 `.env` 里写着 `SEED_SAMPLE_ASSETS=1`，所以本机实例的行为不变。

2. **`.env.example:46-49`**：把

   ```
   # --- First boot ---
   # Set to 0 to keep a fresh installation's library empty instead of
   # generating the twelve sample images.
   SEED_SAMPLE_ASSETS=1
   ```

   改成

   ```
   # --- First boot ---
   # Set to 1 to generate the twelve sample images on a fresh installation.
   # Left unset or 0, a new installation starts with an empty library.
   SEED_SAMPLE_ASSETS=0
   ```

3. **`docker-compose.yml`**：`SEED_SAMPLE_ASSETS: "1"` 改成 `"0"`（只改默认值，不动镜像逻辑）。

4. **`src/server/scripts/seed.js`**（注意路径是 `src/server/scripts/seed.js`，不是 `scripts/seed.js`）：脚本行为不变（它读的就是 `config.seedSampleAssets`），但两处文案要更新：

   - 现在那段过时注释（`src/server/scripts/seed.js:120-121`，**占两行**）`// The basic rows (admin, demo API key, categories, tags) are inserted` / `// only when their table is empty, so this never duplicates anything.` —— 里面提到 `demo API key`，改成 `// The basic rows (admin, categories, tags) are inserted` / `// only when their table is empty, so this never duplicates anything.`；
   - 跳过时的提示现在写的是 `[seed] sample assets skipped (SEED_SAMPLE_ASSETS=0)` —— 改成 `[seed] sample assets skipped (set SEED_SAMPLE_ASSETS=1 to generate them)`，把开启的写法说清楚；
   - 结尾那行 `[seed] users: …, api keys: …, assets: …` 保留（`api keys` 的计数现在会是 0，这是对的）。

   `npm run seed` 的**行为**不变：默认关之后它也不出样张，要样张得 `SEED_SAMPLE_ASSETS=1 npm run seed`。

5. **`README.md` 配置表**（`README.md:275`）：`SEED_SAMPLE_ASSETS=1             # 设为 0 则不生成示例资产` 改成 `SEED_SAMPLE_ASSETS=0             # 设为 1 才生成 12 张示例资产`。

- [ ] **Step 4: 跑测试确认通过**

```bash
export DB_PORT=3307 DB_USER=dam DB_PASSWORD=
node tests/backend/init.test.js
```

- [ ] **Step 5: 提交**

```bash
git add src/server/config.js .env.example docker-compose.yml src/server/scripts/seed.js README.md tests/backend/init.test.js
git commit -m "fix(seed): sample images are opt-in

A fresh installation starts with an empty library. SEED_SAMPLE_ASSETS=1
still generates the twelve images when that is what you want."
```

---

### Task 7: 模板不再带占位密钥

**Files:**
- Modify: `.env.example:36`
- Test: `tests/backend/init.test.js`

**Interfaces:**
- Consumes: `hasConfiguration(envFile)`、`initStatus({ envFile, db })`（`src/server/lib/init.js`）
- Produces: 无新接口

- [ ] **Step 1: 写失败的测试**

在 `tests/backend/init.test.js` 加一个 phase：

1. 把仓库里的 `.env.example` **原样**拷进临时目录，命名为 `.env`；
2. 断言 `hasConfiguration(envFile) === false`；
3. 断言 `initStatus({ envFile, db }).initialized === false`。

（注意 `hasConfiguration` 是**先看进程环境再看文件** —— 测试里要确保 `process.env.JWT_SECRET` 未设置，否则断言会被进程环境抢答。）

- [ ] **Step 2: 跑测试确认失败**

```bash
export DB_PORT=3307 DB_USER=dam DB_PASSWORD=
node tests/backend/init.test.js
```

预期：`hasConfiguration` 返回 `true`（模板第 36 行现在是 `JWT_SECRET=dam-dev-secret-change-me-in-production`）。

- [ ] **Step 3: 实现**

`.env.example:36` 改成留空，并把注释写清楚：

```
# Signing key for the access and refresh tokens. CHANGE THIS before any
# deployment that is reachable from outside the machine — changing it later
# invalidates every issued token.
#
# Leave it empty when you deploy through the init wizard (/init): the
# wizard's third page generates a random secret and writes it here. For a
# hand-rolled deployment, fill in a random string of at least 32 characters.
JWT_SECRET=
```

**`hasConfiguration()` / `isInitialized()` / `initStatus()` 的判定逻辑一个字不改** —— 改的只是模板。

代价要记住：`cp .env.example .env && npm start` 之后不再是"带样张的现成实例"，而是进向导。这正是本次要的效果。

**`docker-compose.yml` 的 `JWT_SECRET` 那行不动** —— compose 路径本来就不走向导，它必须自带一个非空值。

- [ ] **Step 4: 跑测试确认通过**

```bash
export DB_PORT=3307 DB_USER=dam DB_PASSWORD=
node tests/backend/init.test.js
```

- [ ] **Step 5: 提交**

```bash
git add .env.example tests/backend/init.test.js
git commit -m "fix(init): the template ships an empty JWT secret

Copying the template used to make the instance look configured, so the
wizard could never be opened."
```

---

### Task 8: 第三页改名重写

**Files:**
- Create: `src/client/pages/init/InitSeed.tsx`（由 `InitReview.tsx` 改名）
- Delete: `src/client/pages/init/InitReview.tsx`
- Modify: `src/client/pages/init/initApi.ts`
- Modify: `src/client/pages/init/initSteps.ts`
- Modify: `src/client/pages/init/InitWizard.tsx`
- Test: `tests/lib/runtime-checks-init.js`（不改）、`tests/lib/init-token-storage.js`（不改）、`tests/lib/frontend-calls.js`（不改）

**Interfaces:**
- Consumes: `POST /api/init/seed` → `{ ok, jwt_secret_written }`（Task 5）、`GET /api/init/env-preview`（现有）
- Produces: `initApi` 不再有 `restart()`；`SeedResult` 不再有 `api_key`；`initSteps.STEP_SEED`（值仍是 `2`）

- [ ] **Step 1: 写失败的测试**

`tests/lib/runtime-checks-init.js` 的三条规则（`stepFromStatus` 的判定）**不改** —— 规则没变，只是常量改名。

本任务新增的检查（加到 `tests/lib/runtime-checks-init.js`，沿用该文件第三条检查的写法 —— `fs.readFileSync(path.join(ctx.srcDir, 'pages', 'init', '<file>'), 'utf8')` 后做正则断言）：

1. 源码扫描 `src/client/pages/init/initApi.ts`，断言里面**不含** `restart`（`initApi.restart` 与 `restart:` 都不许出现）；
2. 源码扫描 `src/client/pages/init/initApi.ts`，断言 `SeedResult` 类型里**不含** `api_key`；
3. 源码扫描 `src/client/pages/init/InitSeed.tsx`，断言**不含** `initApi.restart()` 与 `api_key`；
4. 源码扫描 `src/client/pages/init/initSteps.ts`，断言含 `STEP_SEED` 且**不含** `STEP_REVIEW`。

每条断言都带一句说明"为什么"，与该文件现有风格一致（`assert.ok(cond, 'the wizard never opens on ...')`）。

（`tests/lib/init-token-storage.js` 的令牌存储禁令继续生效 —— 改写后的 `InitSeed.tsx` 仍然只能把令牌放在 React state 与 `initApi` 的模块内存里。）

- [ ] **Step 2: 跑测试确认失败**

```bash
npm run test:contract
```

预期：第 1 条失败（`initApi.ts` 现在有 `restart`）。

- [ ] **Step 3: 实现**

1. **`initApi.ts`**：
   - 删掉 `restart()` 函数与 `initApi` 对象里的 `restart` 项；
   - `SeedResult` 从 `interface SeedResult extends InitResult { api_key: string | null; jwt_secret_written: boolean }` 改成 `interface SeedResult extends InitResult { jwt_secret_written: boolean }`；
   - 文件头的 docblock 契约里删掉 `POST /restart -> 202` 那一行，`POST /seed` 的注释同步；
   - `runSeed` 的注释改成"调用 `POST /api/init/seed`：种子 → 热加载 → 写入 JWT 密钥，完成后进程不重启"。

2. **`initSteps.ts`**：`export const STEP_REVIEW = 2;` 改成 `export const STEP_SEED = 2;`，`return STEP_REVIEW;` 改成 `return STEP_SEED;`。**值不变、规则不变**，只是名字跟上语义。

3. **`InitReview.tsx` → `InitSeed.tsx`**（用 `git mv` 保留历史），内容重写：

   - 保留 `.env` 预览（脱敏）与"完成"按钮；
   - 删掉 `await initApi.restart();`（现在在 `:78`）；
   - 删掉 `seed.api_key` 的展示（现在在 `:167`/`:172`）；
   - 新增一块只读清单：将要创建的分类（产品图 / 营销素材 / AI 生成 / 视频）与标签（封面 / 海报 / 人物 / 风景 / 抽象 / 品牌 / SVG / 动效）。**清单在前端硬编码**（规格 §9 的倾向：省一条路由，清单本来就固定）；
   - 文案说明："这一步会创建初始分类与标签若干，不会创建 API Key；API Key 进入系统后在「集成」页申请"；按钮文案从"重启并进入系统"改成"完成并进入系统"；
   - 成功回调里 `window.location.href = '/'`（不再重启进程）；
   - 顺手修掉现在 `:40` 的格式缺陷 —— `}: InitReviewProps): JSX.Element {  const [preview, setPreview] = useState<string | null>(null);` 两条语句挤在一行，改成正常换行。

4. **`InitWizard.tsx`**：
   - `import InitReview from './InitReview';` 改成 `import InitSeed from './InitSeed';`；
   - `Steps` 的第三项标题 `'确认'` 改成 `'种子数据'`；
   - `<InitReview ... onFinished={() => { window.location.href = '/'; }} />` 改成 `<InitSeed ... onFinished={() => { window.location.href = '/'; }} />`。

   `tests/lib/runtime-checks-init.js` 会源码扫描这个文件里的 `initApi.status()` 与 `stepFromStatus(status.steps)` —— **那两行不能动**。

   **注意契约护栏的方向**：`tests/contract.test.js:149-152` 会报"前端调用了没有对应后端路由的路径"。本任务删前端调用、Task 5 删后端路由，两边同步，护栏不会红。反过来若只删一边就会红 —— 所以 **Task 5 与 Task 8 必须一起合入**，不要只提其中一个。

   **注意** `initApi.ts` 用的是自己的 axios 实例 + `call<T>()` 辅助函数，不属于护栏扫描的四种调用形状（`apiGet/apiPost/...`、`apiClient.get/...`、`apiClient.request({url, method})`、`useApi`）—— 所以删掉 `restart()` 不会被护栏自动发现，**上面 Step 1 的源码扫描断言才是它的护栏**。

- [ ] **Step 4: 跑测试确认通过**

```bash
npm run type-check
npm run test:contract
```

- [ ] **Step 5: 提交**

```bash
git add src/client/pages/init tests/lib/runtime-checks-init.js
git commit -m "feat(init): the third page seeds and moves on, no restart

The page no longer shows a key nobody asked for, and it no longer asks
the operator to restart the process."
```

---

# 阶段 D · 验收脚本与文档

### Task 9: 验收脚本与 README

**Files:**
- Modify: `tests/backend/acceptance.probe.js`
- Modify: `README.md`
- Test: `tests/backend/acceptance.probe.js`（手工跑）

**Interfaces:**
- Consumes: `POST /api/v1/auth/login`（现有契约：`{username, password, tenant?}` → `{ access_token, refresh_token, user }`）、`POST /api/v1/api-keys`（现有契约：JWT 鉴权，`{ name, scopes?, expires_at?, description? }` → **201**，响应体 `{ id, name, key, key_prefix, scopes, expires_at, warning }`）
- Produces: 无新接口

- [ ] **Step 1: 写失败的测试**

这个脚本**不在** `tests/backend/run.js` 的 SUITES 里（那是 `bd4b715` 留下的手工验收脚本），所以"失败"由人工观察：

```bash
export DB_PORT=3307 DB_USER=dam DB_PASSWORD=
node tests/backend/acceptance.probe.js
```

预期（改写前）：它在 `assert.ok(seed.body.api_key, ...)` 处失败 —— 响应里不再有 `api_key`。

- [ ] **Step 2: 确认失败点**

跑一次，记下失败位置。

- [ ] **Step 3: 实现**

**`tests/backend/acceptance.probe.js`：**

1. 现在的流程是：向导三页 → `assert.ok(seed.body.api_key)` → 拿那个 key 跑 ingest。改成：

   - 走完向导三页（`/database` → `/admin` → `/seed`）；
   - 断言 `seed.body.ok === true` 且 `seed.body.api_key === undefined`；
   - **用第二页填的管理员密码登录**：`POST /api/v1/auth/login`，body `{ username, password }`，拿到 `access_token`；
   - **再申请一把 API Key**：`POST /api/v1/api-keys`，带 `Authorization: Bearer <access_token>`，body `{ name: 'Acceptance Key', scopes: 'read,upload,delete' }`，断言 **201**，取响应体里的 **`key`**（字段名是 `key`，不是 `api_key`）；
   - 用这把 key 跑原来的 criterion 3/4（ingest 与 ComfyUI）；
   - 把脚本注释里"重启后才是已配置"的说法改成"热加载后立即已配置"；
   - **保留** `SEED_SAMPLE_ASSETS: '1'`（这个脚本要验证样张 12 张那条断言）—— 它是脚本自己的环境变量，与默认值无关。

   注意脚本里 `startBackend()` 传的 `JWT_SECRET: ''` 与 `INIT_TOKEN` 保留。

2. **`README.md`**：

   - 新增"初始化向导"一节：空机器 → `npm install && npm run build && npm start` → 控制台拿令牌 → 打开 `/init` → 三页 → **直接进系统，无需重启**；
   - 现有"方法二：`cp .env.example .env` 后填空 `DB_*` 即用"改成两条并列路径：
     - (a) **向导部署**：拷模板、不填 `JWT_SECRET`、走 `/init`；
     - (b) **纯环境变量部署**：拷模板、手工填 `JWT_SECRET`（≥32 位随机串）与 `DB_*`；
   - 安全建议第 3 条（`README.md:296`）从"**修改默认 API Key**：如启用了外部投递"改成"**为每个外部系统单独申请 API Key**：在「集成」页申请，用完即撤"；
   - 配置表里 `SEED_SAMPLE_ASSETS` 的默认值是 `0`（Task 6 已改，这里只核对）。

- [ ] **Step 4: 跑测试确认通过**

```bash
export DB_PORT=3307 DB_USER=dam DB_PASSWORD=
node tests/backend/acceptance.probe.js
```

预期：跑完不报错，样张 12 张、ingest、ComfyUI 三段都过。

- [ ] **Step 5: 提交**

```bash
git add tests/backend/acceptance.probe.js README.md
git commit -m "docs(init): the acceptance script asks for its own key

The wizard no longer hands out a credential, so the script logs in and
requests one the way an operator would."
```

---

# 完成标准

全部任务完成后：

```bash
npm run type-check          # 前端类型干净
npm run test:backend        # 后端 7 个 suite 全绿
npm run test:contract       # 契约护栏：静态 + 运行时
npm run build               # 前端构建
```

并且：

- 把仓库里的 `.env.example` 原样拷成 `.env`、起一个空实例，`/` 会走到 `/init`，向导三页走完后**不重启**就能用第二页建的账号登录；
- 走完向导后 `api_keys` 表 0 行，分类 4 行、标签 8 行，没有示例资产；
- 向导写出的 `.env` 里 `STORAGE_DIR` 是模板默认 `./storage`，但**运行中的进程**仍用启动时注入的那个目录；
- 重复点两次"完成"，两个响应都成功，库里没有重复行；
- 热加载失败时向导仍开着、`JWT_SECRET` 没被写进 `.env`。
