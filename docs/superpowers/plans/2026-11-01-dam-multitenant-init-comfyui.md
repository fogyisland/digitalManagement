# DAM 多租户 · 初始化向导 · 对接协议 · ComfyUI 节点 —— 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 DAM 从单租户升级为多租户平台，补上网页初始化向导、对外接收接口与完整推送协议，并交付一个 ComfyUI 自定义节点。

**Architecture:** 四个可独立验证的阶段，A（多租户）是 B/C/D 的地基。租户通过 `tenant_id` 列落在共享库里，租户身份由 API Key 与 JWT 携带，鉴权中间件把它挂到 `req.tenant`；护栏强制每条业务 SQL 都带租户条件。初始化向导是前端 `/init` 三页 + 后端 `/api/init/*`，原子写 `.env`。对外接收走 `/api/ingest/v1`，复用现有的 `processUpload`。ComfyUI 节点是独立的 Python 包，只依赖 HTTP 契约。

**Tech Stack:** Node.js 22 LTS+ · Express 4 · mysql2 · React 18 · TypeScript 5 · Vite 6 · Zustand · Python 3.10+（仅 ComfyUI 节点）

**Spec:** `docs/superpowers/specs/2026-11-01-dam-multitenant-init-comfyui-design.md`

## Global Constraints

- **Node.js ≥ 22.15** —— 契约护栏依赖 `node:module` 的 `registerHooks`。
- **MySQL 5.7+ 或 8.0** —— 不使用 8.0 独有的语法（`ADD COLUMN IF NOT EXISTS`、`CTE`、窗口函数）。
- **不新增第三方依赖** —— 主仓库只用已有的依赖；ComfyUI 节点是独立 Python 包，且只用标准库（`urllib`），不引入 `requests`。
- **模块系统**：后端是 CommonJS（`require`），前端是 ESM（`import`），`tests/` 是 ESM，`tests/backend/` 是 CommonJS。三者靠嵌套 `package.json` 区分，不要改。
- **单文件 300–500 行以内，单函数 ≤ 50 行。**
- **文件必须以 `0x0a` 结尾。**
- **布尔值以 `is` / `has` / `can` 开头；严格类型，不用 `any`（前端用 `unknown` 或具体 interface）。**
- **不留 stub / TODO / 省略号** —— 每个函数都要有真实实现。
- **每完成一个任务都要提交**，提交信息末尾带 `Co-Authored-By: Claude Code <noreply@anthropic.com>`。
- **提交前必须跑**：`npm run test:backend` 与 `npm run test:contract`（后者需要 MySQL）。
- **绝不手工修改用户的 `.env` 之外的配置**；`.env` 由 init 向导写入，开发者只改本地那一份。
- **所有面向用户的文案用中文。**

## Review Focus

以下五类输入/状况最容易咬人，每个都要有对应的测试：

1. **跨租户越权** —— A 阶段最重要的失败模式。一个租户的 A Key 去读 B 的资产，必须 404（不是 403、不是 200）。测试要覆盖 ID 遍历、列表过滤、软删/复原、Webhook 派发四条路径。
2. **半初始化的实例** —— `.env` 写了但管理员没建、或管理员建了但 `.env` 没写完。init 向导必须能从任意中断点继续，且不能重复建租户。
3. **`.env` 写入被打断** —— 进程在写 `.env` 的中途被杀，不能留下半个 `.env`。必须用临时文件 + rename。
4. **webhook 接收方不升级** —— 签名口径从 body 改成 `timestamp.body` 是破坏性变更。老接收方必须能同时验两种签名。
5. **ComfyUI 节点在真实 ComfyUI 里的行为** —— ComfyUI 传的可能是 `IMAGE` 张量对象而不是文件字节；节点必须把它转成 PNG 字节再上传。

## 前置条件

阶段 A/C/D 的运行时测试都需要 MySQL。若尚未配置，先执行一次：

```bash
mysql -u root -p < scripts/create-database.sql
```

然后在 `.env` 里填好 `DB_PASSWORD`。未配置时，阶段 A 的静态护栏与 `tsc` 仍可运行。

---

# 阶段 A · 多租户基础

### Task A1: `tenants` 表与 `tenant_id` 迁移

**Files:**
- Modify: `src/server/lib/schema.js`
- Test: `tests/backend/server.test.js`

**Interfaces:**
- Consumes: 现有的 `initSchema(db)`、`ensureColumns(db, table, defs)`、`existingIndexes(db, table)`
- Produces: `TENANTS_TABLE_SQL`、`TENANT_SCOPED_TABLES`、`TENANT_UNIQUE_KEYS`、`DEFAULT_TENANT_ID = 'default'`

- [ ] **Step 1: 写失败的测试**

在 `tests/backend/server.test.js` 的 `phaseSchema` 里加一段断言：所有业务表都有 `tenant_id` 列，且 `tenants` 表存在且有一个 `default` 行。

```js
  const [tenantRows] = await pool.execute(
    'SELECT id, slug FROM tenants WHERE id = ?',
    ['default'],
  );
  assert.strictEqual(tenantRows.length, 1, 'the default tenant must exist');
  for (const table of TENANT_SCOPED_TABLES) {
    const [cols] = await pool.execute(
      `SELECT COLUMN_NAME AS name FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?`,
      [dbName, table],
    );
    assert.ok(
      cols.some((c) => c.name === 'tenant_id'),
      `${table} must have a tenant_id column`,
    );
  }
```

- [ ] **Step 2: 跑测试确认失败**

```bash
npm run test:backend
```
预期：`missing table: tenants`。

- [ ] **Step 3: 实现**

在 `src/server/lib/schema.js` 里加：

```js
/** The tenant every row belongs to when the database is upgraded. */
const DEFAULT_TENANT_ID = 'default';

/** Every table whose rows belong to one tenant. */
const TENANT_SCOPED_TABLES = [
  'users', 'assets', 'asset_tags', 'categories', 'tags', 'api_keys',
  'audit_logs', 'webhook_endpoints', 'webhook_logs', 'manifest_writes',
  'upload_sessions', 'token_registry', 'revoked_tokens',
];

/** The unique keys that must become tenant-scoped. */
const TENANT_UNIQUE_KEYS = [
  ['users', 'uq_users_username', 'username'],
  ['categories', 'uq_categories_name', 'name'],
  ['categories', 'uq_categories_slug', 'slug'],
  ['tags', 'uq_tags_name', 'name'],
  ['tags', 'uq_tags_slug', 'slug'],
];
```

`tenants` 表的 DDL 放进 `BASE_SCHEMA_SQL`（第一张）：

```sql
CREATE TABLE IF NOT EXISTS tenants (
  id VARCHAR(64) NOT NULL PRIMARY KEY,
  name VARCHAR(191) NOT NULL,
  slug VARCHAR(191) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'active',
  settings_json TEXT,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_tenants_slug (slug)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
```

`initSchema` 里，遍历 `TENANT_SCOPED_TABLES` 调 `ensureColumns(db, table, ['tenant_id VARCHAR(64) NOT NULL DEFAULT \'default\''])`；再把 `TENANT_UNIQUE_KEYS` 里已存在的旧唯一索引删掉、换成复合索引。删索引前先用 `existingIndexes` 判断存在与否。

`asset_tags` 的主键要从 `(asset_id, tag_id)` 改成 `(tenant_id, asset_id, tag_id)`：先删旧主键（`ALTER TABLE asset_tags DROP PRIMARY KEY`），再加新的。MySQL 5.7 不支持 `DROP PRIMARY KEY` 后直接改列的隐式更新，需要按顺序执行：加列 → 删旧主键 → 加新主键 → 回填 tenant_id（`UPDATE asset_tags SET tenant_id = 'default'`）。

- [ ] **Step 4: 跑测试确认通过**

```bash
npm run test:backend
```

- [ ] **Step 5: 提交**

```bash
git add src/server/lib/schema.js tests/backend/server.test.js
git commit -m "feat(tenant): the tenants table and the tenant_id columns

Every business row now belongs to a tenant. The migration is idempotent
in the same way the column migrations already are: a column is added
only when it is missing, and the unique keys that would collide across
tenants become composite keys."
```

---

### Task A2: 租户上下文解析

**Files:**
- Create: `src/server/lib/tenant.js`
- Test: `tests/backend/server.test.js`

**Interfaces:**
- Produces:
  - `resolveTenantFromUser(user)` → `{ id, slug, name, status } | null`
  - `tenantScope(tenant)` → `{ tenantId, isSuperadmin }`
  - `SUPERADMIN_ROLE = 'superadmin'`

- [ ] **Step 1: 写失败的测试**

在 `tests/backend/server.test.js` 加一个 phase：插入两个租户、两个用户（一个普通、一个 superadmin），断言 `resolveTenantFromUser` 对普通用户返回其租户、对 superadmin 返回 `isSuperadmin: true` 的通配范围。

- [ ] **Step 2: 跑测试确认失败**

```bash
npm run test:backend
```
预期：`Cannot find module '../src/server/lib/tenant'`。

- [ ] **Step 3: 实现**

`src/server/lib/tenant.js`：

```js
'use strict';

/**
 * Tenant resolution.
 *
 * A request's tenant comes from the credential, never from the request
 * body: an API key belongs to exactly one tenant, and a management token
 * carries the tenant it was issued for.
 */

/** The role that may act across every tenant. */
const SUPERADMIN_ROLE = 'superadmin';

/** The tenant scope of a platform administrator. */
const ALL_TENANTS = '*';

/**
 * The tenant a user belongs to.
 *
 * @param {{id: string, username: string, role: string, tenant_id: string}} user
 * @param {{id: string, slug: string, name: string, status: string} | null} tenant
 * @returns {{tenantId: string, isSuperadmin: boolean} | null}
 */
function tenantScope(user, tenant) {
  if (!user) return null;
  if (user.role === SUPERADMIN_ROLE) {
    return { tenantId: ALL_TENANTS, isSuperadmin: true };
  }
  if (!tenant) return null;
  return { tenantId: tenant.id, isSuperadmin: false };
}

module.exports = { SUPERADMIN_ROLE, ALL_TENANTS, tenantScope };
```

- [ ] **Step 4: 跑测试确认通过**

```bash
npm run test:backend
```

- [ ] **Step 5: 提交**

```bash
git add src/server/lib/tenant.js tests/backend/server.test.js
git commit -m "feat(tenant): resolve the tenant a credential speaks for"
```

---

### Task A3: 鉴权中间件带上租户

**Files:**
- Modify: `src/server/lib/auth.js`
- Modify: `src/server/lib/dto.js`（用户 DTO 增加 `tenant_id`）
- Test: `tests/backend/server.test.js`

**Interfaces:**
- Consumes: `tenantScope(user, tenant)`（Task A2）
- Produces: `req.tenant = { id, slug, name, status }`、`req.tenantScope = { tenantId, isSuperadmin }`；`issueTokenPair(db, user)` 写入的 JWT 含 `tid`

- [ ] **Step 1: 写失败的测试**

登录后解码 access token，断言 payload 里有 `tid`；用该 token 请求 `/api/v1/auth/me`，断言 `req.tenant` 已被解析（通过 `/auth/me` 返回体新增的 `tenant_id` 字段验证）。

- [ ] **Step 2: 跑测试确认失败**

```bash
npm run test:backend
```

- [ ] **Step 3: 实现**

`issueTokenPair` 的 payload 里加 `tid: user.tenant_id`。

`authRequired` 里，用户查出后多查一次租户：

```js
      const tenant = await db
        .prepare('SELECT id, slug, name, status FROM tenants WHERE id = ?')
        .get(user.tenant_id);
      if (!tenant) return res.status(403).json({ detail: 'Tenant not found' });
      if (tenant.status !== 'active') return res.status(403).json({ detail: 'Tenant is suspended' });
      req.tenant = tenant;
      req.tenantScope = tenantScope(user, tenant);
```

`apiKeyRequired` 里，Key 查询带上 `tenant_id`，然后同样解析租户并挂到 `req.tenant`。

`dto.js` 的 `toUser` 增加 `tenant_id: row.tenant_id`。

- [ ] **Step 4: 跑测试确认通过**

```bash
npm run test:backend
```

- [ ] **Step 5: 提交**

```bash
git add src/server/lib/auth.js src/server/lib/dto.js tests/backend/server.test.js
git commit -m "feat(tenant): the credential decides the tenant

Both credentials now answer the same question: which tenant does this
request speak for. The management token carries the tenant it was
issued for, the API key carries the one it was created in, and the
middleware puts both on the request."
```

---

### Task A4: 所有业务查询带上租户条件

**Files:**
- Modify: `src/server/routes/*.js`（全部）
- Modify: `src/server/lib/assets.js`、`src/server/lib/auth.js`、`src/server/lib/manifest.js`
- Test: `tests/backend/server.test.js`

**Interfaces:**
- Consumes: `req.tenantScope.tenantId`（Task A3）
- Produces: 每个涉及业务表的 SQL 都含 `tenant_id = ?`

- [ ] **Step 1: 写失败的测试**

在 `tests/backend/server.test.js` 加一个 phase：建租户 A 与 B，各放一个资产；用 A 的 token 请求 `/api/v1/assets`，断言只看到 A 的资产；用 A 的 token 直接 GET B 的资产 id，断言 404。

再加一个 superadmin 的断言：用 role 为 `superadmin` 的用户登录，请求 `/api/v1/assets`，断言能看到 A 与 B 的资产，且响应里每条资产都带自己的 `tenant_id`。

- [ ] **Step 2: 跑测试确认失败**

```bash
npm run test:backend
```

- [ ] **Step 3: 实现**

逐个 handler 加租户条件。以 `src/server/routes/assets.js` 为例：

```js
  const tenantId = req.tenantScope.tenantId;
  const assets = await listAssets(db, {
    ...
    where: buildAssetWhere(filters, tenantId),
  });
```

`buildAssetWhere` 的第一个参数变成租户 id，所有 `WHERE` 以 `a.tenant_id = ?` 开头。列表里的 `total` 计数、单个资源的读取（`WHERE id = ? AND tenant_id = ?`）同样要带。

**规则**：`isSuperadmin` 时 `tenantId` 为 `'*'`，此时不注入租户条件（平台管理员可以看到全部）。注入逻辑统一放在一个 helper：

```js
/**
 * The tenant condition for a query.
 *
 * @param {{tenantId: string, isSuperadmin: boolean}} scope
 * @returns {{sql: string, params: unknown[]}} the clause and its parameter
 */
function tenantClause(scope, column = 'tenant_id') {
  if (scope.isSuperadmin) return { sql: '', params: [] };
  return { sql: ` AND ${column} = ?`, params: [scope.tenantId] };
}
```

放在 `src/server/lib/tenant.js`。

- [ ] **Step 4: 跑测试确认通过**

```bash
npm run test:backend
```

- [ ] **Step 5: 提交**

```bash
git add src/server/routes src/server/lib
git commit -m "feat(tenant): every query is scoped to a tenant

A query that forgets the tenant condition is a leak, so the rule is
enforced twice: once by the helper the handlers use, and once by the
contract guard, which fails on any business SQL without it."
```

---

### Task A5: 护栏强制检查租户条件

**Files:**
- Modify: `tests/lib/backend-routes.js`（或新建 `tests/lib/tenant-lint.js`）
- Modify: `tests/contract.test.js`

**Interfaces:**
- Produces: `findUnscopedQueries({ srcDir, repoRoot })` → `string[]`（每条一个 `文件:行号` 说明）

- [ ] **Step 1: 写失败的测试**

在 `tests/contract.test.js` 的静态半程里加一段：对 `src/server/routes` 与 `src/server/lib` 扫描 `db.prepare('...')` 的 SQL 字符串，命中业务表名（`assets`/`users`/`api_keys`/`categories`/`tags`/`webhook_endpoints`/`upload_sessions`/`audit_logs`/`asset_tags`/`manifest_writes`）且不含 `tenant_id` 的，收集成违规。

先用一个临时文件证明它能抓到：新建 `src/server/lib/__lint_probe.js`，里面写一句 `db.prepare('SELECT * FROM assets')`，跑护栏应失败；确认后删掉这个探针文件。

- [ ] **Step 2: 跑测试确认失败**

```bash
CONTRACT_STATIC_ONLY=1 node tests/contract.test.js
```
预期：探针文件被报为未加租户条件。

- [ ] **Step 3: 实现**

新建 `tests/lib/tenant-lint.js`：

```js
/**
 * Find business queries that do not mention the tenant.
 *
 * The tenant filter is the only thing between two tenants' data, so a
 * query that forgets it is a leak. This scans the SQL the server actually
 * runs and names the ones that do not carry it.
 */

const BUSINESS_TABLES = [
  'assets', 'users', 'api_keys', 'categories', 'tags',
  'webhook_endpoints', 'upload_sessions', 'audit_logs',
  'asset_tags', 'manifest_writes',
];

/**
 * @param {{srcDir: string, repoRoot: string}} input
 * @returns {string[]} the violations
 */
export function findUnscopedQueries({ srcDir, repoRoot }) {
  ...
}
```

扫描方式与 `frontend-calls.js` 相同：读文件、提取 `db.prepare(...)` 的 SQL 字符串常量，命中业务表名且不含 `tenant_id` 的记一条。

在 `contract.test.js` 的 `runStaticLint` 里把结果并入 `violations`。

- [ ] **Step 4: 跑测试确认通过**

```bash
CONTRACT_STATIC_ONLY=1 node tests/contract.test.js
npm run test:contract
```

- [ ] **Step 5: 提交**

```bash
git add tests/lib/tenant-lint.js tests/contract.test.js
git commit -m "test(tenant): fail on a business query without a tenant filter"
```

---

# 阶段 B · 初始化向导

### Task B1: init 状态与 `.env` 原子写入

**Files:**
- Create: `src/server/lib/init.js`
- Create: `src/server/routes/init.js`
- Modify: `src/server/server.js`
- Test: `tests/backend/init.test.js`（新建）

**Interfaces:**
- Produces:
  - `readEnvFile(file)` → `Record<string, string>`
  - `writeEnvFile(file, values)` → `void`（原子写）
  - `isInitialized({ env, db })` → `Promise<boolean>`
  - 路由：`GET /api/init/status`、`POST /api/init/database`、`POST /api/init/admin`、`POST /api/init/seed`、`GET /api/init/env-preview`、`POST /api/init/restart`

- [ ] **Step 1: 写失败的测试**

新建 `tests/backend/init.test.js`：起一个后端实例（用临时 MySQL 库），断言

- `GET /api/init/status` 返回 `{ initialized: false }`（`.env` 不存在）；
- `POST /api/init/database` 之后，`.env` 文件存在且含 `DB_NAME`；
- 进程被杀掉再起，`GET /api/init/status` 返回 `{ initialized: true }`。

- [ ] **Step 2: 跑测试确认失败**

```bash
node tests/backend/init.test.js
```
预期：`404`（路由不存在）。

- [ ] **Step 3: 实现**

`src/server/lib/init.js` 提供 `.env` 读写：

```js
/**
 * Write the environment file atomically.
 *
 * A half-written .env would leave the next boot with a broken
 * configuration, so the content goes to a temporary file first and is
 * then renamed over the original — a rename is atomic on every platform
 * this project runs on.
 */
function writeEnvFile(file, values) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, renderEnv(values), 'utf8');
  fs.renameSync(tmp, file);
}
```

`renderEnv` 以 `.env.example` 的**键顺序**为骨架，缺的值用默认值补齐。

`src/server/routes/init.js` 实现六个端点，全部要求请求头 `X-Init-Token`（令牌来自 `INIT_TOKEN` 环境变量；未设置时服务启动时随机生成并打印）。

- [ ] **Step 4: 跑测试确认通过**

```bash
node tests/backend/init.test.js
```

- [ ] **Step 5: 提交**

```bash
git add src/server/lib/init.js src/server/routes/init.js src/server/server.js tests/backend/init.test.js
git commit -m "feat(init): the init API and an atomic .env write"
```

---

### Task B2: 数据库连接页

**Files:**
- Modify: `src/server/routes/init.js`
- Test: `tests/backend/init.test.js`

- [ ] **Step 1: 写失败的测试**

断言 `POST /api/init/database` 传一组**错误的**密码返回 400 且 `.env` 未被创建；传正确的密码返回 200 且 `.env` 里 `DB_USER`/`DB_PASSWORD`/`DB_NAME` 正确、目标库存在且表已建好。

- [ ] **Step 2: 跑测试确认失败**

```bash
node tests/backend/init.test.js
```

- [ ] **Step 3: 实现**

`POST /api/init/database` 的动作顺序：

1. 用传入的连接参数 `createConnection` 试连 —— 失败返回 400 `{ detail: 'Cannot connect to the database' }`；
2. `CREATE DATABASE IF NOT EXISTS`；
3. 建 pool，用 `initSchema` 建表；
4. 把 `DB_*` 写进 `.env`（连同 `.env.example` 的其余键）。

**注意**：这一步之后服务当前进程仍连着旧库，需要 `POST /api/init/restart` 才会生效 —— 这是有意的，向导会在界面上说明。

- [ ] **Step 4: 跑测试确认通过**

```bash
node tests/backend/init.test.js
```

- [ ] **Step 5: 提交**

```bash
git add src/server/routes/init.js tests/backend/init.test.js
git commit -m "feat(init): the database step connects, creates the schema and writes .env"
```

---

### Task B3: 管理员与租户

**Files:**
- Modify: `src/server/routes/init.js`
- Test: `tests/backend/init.test.js`

- [ ] **Step 1: 写失败的测试**

断言 `POST /api/init/admin` 用弱密码返回 400；用合规密码返回 200，库里有对应的 `users` 行（bcrypt 哈希）、有 `tenants` 行、该用户的 `tenant_id` 指向该租户；重复调用不会建第二个租户。

- [ ] **Step 2: 跑测试确认失败**

```bash
node tests/backend/init.test.js
```

- [ ] **Step 3: 实现**

`POST /api/init/admin` 的输入：`{ username, password, email, tenantName }`。

- 密码规则：≥10 位且同时含字母与数字，否则 400；
- 租户：`SELECT COUNT(*) FROM tenants` 为 0 时创建（`id` 用 nanoid，`slug` 取自 `tenantName` 的 slug），否则沿用已有的那个并把 `name` 更新为用户填的值；
- 用户：`INSERT INTO users (id, username, email, password_hash, role, tenant_id)`，`role` 取 `admin`，密码用 bcrypt（10 轮）；
- 用户名在租户内唯一 —— 冲突返回 409。

- [ ] **Step 4: 跑测试确认通过**

```bash
node tests/backend/init.test.js
```

- [ ] **Step 5: 提交**

```bash
git add src/server/routes/init.js tests/backend/init.test.js
git commit -m "feat(init): the administrator step creates the first tenant and its owner"
```

---

### Task B4: Seed 与 JWT / API Key 生成

**Files:**
- Modify: `src/server/routes/init.js`
- Modify: `src/server/lib/schema.js`（seed 需要能指定租户）
- Test: `tests/backend/init.test.js`

- [ ] **Step 1: 写失败的测试**

断言 `POST /api/init/seed` 之后：`.env` 里有非空 `JWT_SECRET`（长度 ≥ 32）；`api_keys` 表有一行且其 `tenant_id` 指向默认租户；响应体里的 `api_key` 明文可用（拿它调 `/api/public/v1/delivery/assets` 返回 200）。

- [ ] **Step 2: 跑测试确认失败**

```bash
node tests/backend/init.test.js
```

- [ ] **Step 3: 实现**

`POST /api/init/seed`：

1. 生成 `JWT_SECRET = crypto.randomBytes(32).toString('hex')`（若 `.env` 里已有且非空则沿用 —— 不轮换已发出的密钥）；
2. 写入 `.env`；
3. 跑 `seedDatabase`（分类、标签、管理员、示例资产），全部归到默认租户；
4. 生成 Demo API Key（`dam_` + 48 hex），哈希入库，明文只在响应里出现一次；
5. 响应体返回 `{ api_key, jwt_secret_written: true }`。

**seed 的租户归属**：`seedDatabase` 现在的插入没有 `tenant_id`，A1 的列有 `DEFAULT 'default'`，所以默认落进 default 租户。但当第一个租户的 id 不是 `default`（空库初始化场景）时，必须显式指定 —— 给 `seedDatabase` 加一个 `tenantId` 参数，A4 的改动里一并传下去。

- [ ] **Step 4: 跑测试确认通过**

```bash
node tests/backend/init.test.js
```

- [ ] **Step 5: 提交**

```bash
git add src/server/routes/init.js src/server/lib/schema.js tests/backend/init.test.js
git commit -m "feat(init): the seed step writes the JWT secret and hands out the first API key"
```

---

### Task B5: 前端 `/init` 三页向导

**Files:**
- Create: `src/client/pages/init/InitDatabase.tsx`
- Create: `src/client/pages/init/InitAdmin.tsx`
- Create: `src/client/pages/init/InitReview.tsx`
- Create: `src/client/pages/init/initApi.ts`
- Modify: `src/client/router.tsx`
- Modify: `src/client/main.tsx`

**Interfaces:**
- Consumes: `/api/init/*`（Task B1–B4）
- Produces: 路由 `/init`；未初始化时 `/` 重定向到 `/init`

- [ ] **Step 1: 写失败的测试**

在 `tests/lib/runtime-checks-identity.js` 加一项检查：数据库全新（无租户）时，`GET /api/init/status` 返回 `initialized: false`，且 `POST /api/init/database` 用错误凭据返回 400。

- [ ] **Step 2: 跑测试确认失败**

```bash
npm run test:contract
```

- [ ] **Step 3: 实现**

`initApi.ts`：

```ts
export interface InitStatus {
  initialized: boolean;
  steps: { database: boolean; admin: boolean; seed: boolean };
}

export async function getInitStatus(): Promise<InitStatus> { ... }
export async function saveDatabase(input: DatabaseInput): Promise<InitResult> { ... }
export async function saveAdmin(input: AdminInput): Promise<InitResult> { ... }
export async function runSeed(): Promise<InitResult> { ... }
export async function getEnvPreview(): Promise<string> { ... }
export async function restart(): Promise<void> { ... }
```

三个页面用 Ant Design 的 `Steps` + `Form` 组织，每页一个组件，`InitDatabase` → `InitAdmin` → `InitReview`。`InitReview` 展示 `getEnvPreview()` 的内容（密码字段掩码）与将要创建的记录摘要，最后一个按钮调用 `runSeed()` 再 `restart()`。

`router.tsx` 增加 `/init` 路由；`main.tsx` 里在渲染前先问 `getInitStatus()`，未初始化时把根路径导航到 `/init`。

- [ ] **Step 4: 跑测试确认通过**

```bash
npm run type-check
npm run test:contract
```

- [ ] **Step 5: 提交**

```bash
git add src/client/pages/init src/client/router.tsx src/client/main.tsx tests/lib/runtime-checks-identity.js
git commit -m "feat(init): the browser wizard, three pages from the database to the seed"
```

---

# 阶段 C · 接收接口与推送协议

### Task C1: `/api/ingest/v1` 接收端点

**Files:**
- Create: `src/server/routes/ingest.js`
- Modify: `src/server/server.js`
- Modify: `src/server/lib/assets.js`（`processUpload` 接受租户）
- Test: `tests/lib/runtime-checks-integrations.js`

- [ ] **Step 1: 写失败的测试**

加一项检查：用 API Key 调 `POST /api/ingest/v1/assets`（multipart `files`），断言 201、资产落在 Key 的租户下；用没有 `upload` scope 的 Key 调同一个端点，断言 403。

- [ ] **Step 2: 跑测试确认失败**

```bash
npm run test:contract
```

- [ ] **Step 3: 实现**

`src/server/routes/ingest.js`：

```js
  router.post(
    '/ingest/v1/assets',
    apiKeyRequired(db, 'upload'),
    asyncHandler(async (req, res) => {
      const tenantId = req.tenant.id;
      // 复用内部上传：去重、缩略图、清单、Webhook 全部一致
      const result = await processUpload(db, req.files, {
        title: body.title,
        tenantId,
      });
      return res.status(201).json(result);
    }),
  );
```

`processUpload` 增加 `tenantId` 参数，插入时带上。

`server.js` 挂载：

```js
app.use('/api', createIngestRouter({ db, uploader }));
```

- [ ] **Step 4: 跑测试确认通过**

```bash
npm run test:contract
```

- [ ] **Step 5: 提交**

```bash
git add src/server/routes/ingest.js src/server/server.js src/server/lib/assets.js tests/lib/runtime-checks-integrations.js
git commit -m "feat(ingest): an inbound API for external systems"
```

---

### Task C2: Webhook 签名 v2 与防重放

**Files:**
- Modify: `src/server/lib/webhook.js`
- Modify: `src/server/routes/webhooks.js`（文档注释）
- Test: `tests/backend/webhook.smoke.js`

- [ ] **Step 1: 写失败的测试**

在 `webhook.smoke.js` 里加一项：捕获请求里的 `X-DAM-Timestamp` 与 `X-DAM-Signature`，用 `HMAC-SHA256(secret, `${timestamp}.${body}`)` 重算并比对，必须相等。

- [ ] **Step 2: 跑测试确认失败**

```bash
node tests/backend/webhook.smoke.js
```

- [ ] **Step 3: 实现**

`signPayload(secret, body, timestamp)` 改成签 `${timestamp}.${body}`；`dispatch` 生成 `timestamp = Math.floor(Date.now() / 1000)`，带上 `X-DAM-Timestamp` 与 `X-DAM-Delivery`（= `webhook_logs.id`）。

**兼容**：同时发两个签名头 ——

- `X-DAM-Signature`（新：`timestamp.body`）
- `X-DAM-Signature-V1`（旧：只签 body）

接收方可以先按旧的验，验不过再按新的验，迁移期两边都能用。文档里写清楚推荐切到新签名。

- [ ] **Step 4: 跑测试确认通过**

```bash
node tests/backend/webhook.smoke.js
```

- [ ] **Step 5: 提交**

```bash
git add src/server/lib/webhook.js src/server/routes/webhooks.js tests/backend/webhook.smoke.js
git commit -m "feat(webhook): sign the timestamp with the body

The old signature covered the body alone, so a captured delivery could
be replayed. The new one covers the timestamp as well, and the old
signature still ships alongside it so existing receivers keep working."
```

---

### Task C3: 补齐事件

**Files:**
- Modify: `src/server/lib/webhook.js`
- Modify: `src/server/lib/assets.js`（复原时派发）
- Modify: `src/client/api/webhooks.ts`（前端镜像）
- Test: `tests/backend/server.test.js`

- [ ] **Step 1: 写失败的测试**

断言软删资产触发 `asset.deleted`，复原触发 `asset.restored`，更新元数据触发 `asset.metadata_updated`。

- [ ] **Step 2: 跑测试确认失败**

```bash
npm run test:backend
```

- [ ] **Step 3: 实现**

`WEBHOOK_EVENTS` 增加 `asset.restored` 与 `asset.metadata_updated`；`restoreAsset` 与资产更新路径补上 `emitAssetEvent` 调用。前端 `src/client/api/webhooks.ts` 的事件列表同步。

**前后端事件表必须一致** —— 在契约护栏里加一条检查：两边的事件数组相同。

- [ ] **Step 4: 跑测试确认通过**

```bash
npm run test:backend
npm run test:contract
```

- [ ] **Step 5: 提交**

```bash
git add src/server/lib/webhook.js src/server/lib/assets.js src/client/api/webhooks.ts tests/backend/server.test.js tests/contract.test.js
git commit -m "feat(webhook): the events that were missing"
```

---

# 阶段 D · ComfyUI 节点

### Task D1: 节点包骨架与客户端

**Files:**
- Create: `comfyui-node/pyproject.toml`
- Create: `comfyui-node/dam_node/__init__.py`
- Create: `comfyui-node/dam_node/config.py`
- Create: `comfyui-node/dam_node/client.py`
- Test: `comfyui-node/tests/test_client.py`

- [ ] **Step 1: 写失败的测试**

`comfyui-node/tests/test_client.py`：用 `unittest` + 一个假的 HTTP 服务（或 mock）断言 `client.upload_asset()` 发出的是 multipart、字段名是 `files`、路径是 `/api/ingest/v1/comfyui/{job_id}`、带上 `X-API-Key`。

- [ ] **Step 2: 跑测试确认失败**

```bash
cd comfyui-node && python -m unittest discover tests
```
预期：`ModuleNotFoundError: No module named 'dam_node'`。

- [ ] **Step 3: 实现**

`pyproject.toml`：

```toml
[project]
name = "dam-comfyui-node"
version = "0.1.0"
description = "ComfyUI nodes that publish their output to the DAM"
requires-python = ">=3.10"
dependencies = []
```

`config.py` 从环境变量读 `DAM_API_URL` / `DAM_API_KEY` / `DAM_TENANT`，其次读 `dam_config.json`。

`client.py` 只用标准库：`urllib.request` 发 multipart，`json` 解析响应。

- [ ] **Step 4: 跑测试确认通过**

```bash
cd comfyui-node && python -m unittest discover tests
```

- [ ] **Step 5: 提交**

```bash
git add comfyui-node
git commit -m "feat(comfyui): the node package and its HTTP client"
```

---

### Task D2: ComfyUI 接收端点

**Files:**
- Modify: `src/server/routes/ingest.js`
- Test: `tests/lib/runtime-checks-integrations.js`

- [ ] **Step 1: 写失败的测试**

用 API Key 调 `POST /api/ingest/v1/comfyui/{job_id}`（multipart `files`），断言 201、资产带 `job_id`、`GET /jobs/by-comfyui/{job_id}` 能反查到它。

- [ ] **Step 2: 跑测试确认失败**

```bash
npm run test:contract
```

- [ ] **Step 3: 实现**

```js
  router.post(
    '/ingest/v1/comfyui/:job_id',
    apiKeyRequired(db, 'upload'),
    asyncHandler(async (req, res) => {
      const jobId = String(req.params.job_id);
      const result = await processUpload(db, req.files, {
        title: body.title || jobId,
        tenantId: req.tenant.id,
        extra: { job_id: jobId, source_tool: 'comfyui' },
      });
      return res.status(201).json(result);
    }),
  );
```

- [ ] **Step 4: 跑测试确认通过**

```bash
npm run test:contract
```

- [ ] **Step 5: 提交**

```bash
git add src/server/routes/ingest.js tests/lib/runtime-checks-integrations.js
git commit -m "feat(ingest): one call registers the job and uploads the artifact"
```

---

### Task D3: 节点实现与安装说明

**Files:**
- Create: `comfyui-node/dam_node/node.py`
- Create: `comfyui-node/README.md`
- Test: `comfyui-node/tests/test_node.py`

- [ ] **Step 1: 写失败的测试**

断言 `DAMUpload` 的 `INPUT_TYPES` 声明了 `image`/`title`/`tags`/`job_id`，且 `tensor_to_bytes` 能把 ComfyUI 的 `IMAGE` 张量（一个 `[B, H, W, C]` 的 float 数组）转成 PNG 字节 —— 用一个 2×2 的张量验证输出是合法的 PNG（文件头 `89 50 4E 47`）。

- [ ] **Step 2: 跑测试确认失败**

```bash
cd comfyui-node && python -m unittest discover tests
```

- [ ] **Step 3: 实现**

`node.py` 定义三个节点：

- `DAMUpload` —— 输入 `image`（任意类型）、`title`、`tags`、`job_id`；输出 `asset_id`、`status`；
- `DAMRegisterJob` —— 只登记占位；
- `DAMLookupJob` —— 反查。

`IMAGE` 张量转 PNG 的实现（纯标准库不行，需要 PNG 编码器 —— 用 `zlib` + `struct` 手写一个最小 PNG 编码器，约 30 行）：

```python
def encode_png(rgba_rows: bytes, width: int, height: int) -> bytes:
    """Encode raw RGBA rows as a PNG. zlib + struct only, no Pillow."""
```

节点读取配置后调用 `client.upload_asset`。

`README.md` 写清安装（把 `comfyui-node/` 复制到 `ComfyUI/custom_nodes/`）、配置（三项环境变量）、三个节点的用法与一个 ComfyUI 工作流示例 JSON。

- [ ] **Step 4: 跑测试确认通过**

```bash
cd comfyui-node && python -m unittest discover tests
```

- [ ] **Step 5: 提交**

```bash
git add comfyui-node
git commit -m "feat(comfyui): the nodes themselves, and how to install them"
```

---

# 完成标准

四个阶段全部完成后：

```bash
npm run type-check          # 前端类型干净
npm run test:backend        # 后端 5 个 suite 全绿
npm run test:contract       # 契约护栏：静态 + 运行时
npm run build               # 前端构建
```

并且：

- 一个只有 `dam` 账号的租户 A 与一个租户 B 互相看不到对方的数据；
- 空库状态下访问 `/` 会走到 `/init`，走完三页后服务重启、登录成功、能看到示例资产；
- 外部系统用 API Key 推一张图进 `/api/ingest/v1/assets`，前端列表里立刻出现；
- ComfyUI 节点上传一张图，DAM 里出现对应资产，且 `GET /jobs/by-comfyui/{job_id}` 能查到。
