# DAM 初始化路径（init）—— 设计文档

**日期**：2026-11-05
**状态**：待批准
**范围**：部署用的初始化向导：三页（数据库 → 管理员 → 种子），完成后**不重启**直接进入系统
**关联**：[2026-11-01-dam-multitenant-init-comfyui-design.md](./2026-11-01-dam-multitenant-init-comfyui-design.md) §3（本文件改造其向导部分，其余章节继续有效）

---

## 1. 背景

2026-11-01 那次交付里，初始化向导已经存在（`/init` + `/api/init/*`），但它按"填完配置 → 重启进程 → 由进程管理器拉起"的方式工作，并且第三页在 seed 时顺手发了两个凭据：一个 `Demo Key`（`seedDatabase` 里）和一份示例资产（`SEED_SAMPLE_ASSETS` 默认开）。

现在要把这条路径收紧成**部署专用**的形态：运维拿到一台空机器 + 一个数据库账号，打开 `/init`，三页填完，**直接进系统**，中间不碰命令行、不重启、也不会凭空多出它没申请过的凭据。

### 已确认的决策

| 决策点 | 结论 |
|---|---|
| 用途 | 为后续部署服务，不用于日常运维 |
| 三页顺序 | 数据库 → 管理员 → 种子 |
| 第一页做到什么程度 | 给数据库就行：测连接 → `CREATE DATABASE IF NOT EXISTS` → 建表 → 写 `.env` |
| 示例资产 | 不要。默认关闭 |
| 第三页种什么 | `JWT_SECRET` + 初始分类与标签。**没有示例资产，没有自动发 API Key** |
| API Key 从哪来 | 进入系统后由使用者自己申请（`POST /api/v1/api-keys`） |
| 部署形态 | 直接 npm，不从容器走 |
| 完成之后 | **热加载**，进程不退出 |

---

## 2. 目标与非目标

### 目标

1. 一台空机器、一个可建库的 MySQL 账号，三页之内变成一个能登录的实例。
2. 完成后**当前进程**即已可用：不需要重启，不需要进程管理器配合。
3. 产物只有两样：数据库里的表与初始行、`.env` 里的配置。
4. 幂等：任何一步重做（重新打开向导、重启进程、重复调用）都不产生第二份数据。

### 非目标

- 一次性的批量建库/多租户开通（走现有的 `POST /api/v1/tenants` 或后续管理面）。
- 从旧库迁移数据、导入已有资产。
- Docker 部署路径（`docker-compose.yml` 只做一处默认值对齐，不新增镜像逻辑）。
- 修改 `PORT` / `HOST` / `STORAGE_DIR` 的运行时生效（向导不写这几个键，见 §4.3）。

### 反目标（这样做就算失败）

- 向导在后台凭空签出一个 API Key —— 一个没人申请过的凭据会出现在响应体、浏览器历史和日志里。
- 向导要求"重启后生效" —— 那正是本次要消灭的摩擦。
- 向导失败后把实例卡在"看起来已初始化、实际连不上库"的状态里，让人只能去手改 `.env` 才能回来。

---

## 3. 三步的语义

```
/init
  第 1 页  数据库    host / port / user / password / database
                     测连接 → CREATE DATABASE IF NOT EXISTS → initSchema → 写 .env 的 DB_*
  第 2 页  管理员    用户名 / 密码 / 邮箱 / 租户名称
                     建（或复用）第一个租户 → 建管理员（bcrypt）
  第 3 页  种子      写 JWT_SECRET → 种初始分类与标签 → 热加载 → 进系统
```

前三页的顺序不可跳：后一页依赖前一页的产物（页 2 要能连上页 1 建的库，页 3 要有一个租户可以挂数据）。这一点由 `stepFromStatus` 已经保证，本次不改它的规则。

### 3.1 第一页：数据库（保持不变）

行为沿用现有实现 `POST /api/init/database`：

1. 5 秒超时测连接，连不上返回 400，不写任何东西；
2. **不传 `database` 就拒绝** —— 由用户给出库名，不替它猜（现有实现已经要求 `database` 必填）；
3. `CREATE DATABASE IF NOT EXISTS`（库名做反引号转义）；
4. 用 app 自己的 handle 形状跑 `initSchema`（建表、补列、补索引，幂等）；
5. `mergeEnv` + `writeEnvFile` 原子写入 `DB_HOST/DB_PORT/DB_USER/DB_PASSWORD/DB_NAME`，并把占位符 `JWT_SECRET` 清空（否则实例会"看起来已配置"，向导会自己关掉）。

页面上只做展示与提交，不改。

**模板里不再带占位密钥（本文定为）**：`.env.example` 第 36 行现在是 `JWT_SECRET=dam-dev-secret-change-me-in-production`，而 `hasConfiguration()` 只判断"非空"，所以 README 的 `cp .env.example .env` 一执行，实例就被判为"已配置"——向导永远打不开，`/init` 直接被 404 挡住。这正是本次要消灭的坑。

改法：**`.env.example` 里 `JWT_SECRET=` 留空**（注释写明"部署时由 /init 第三页生成；手工部署请填入 ≥32 位的随机串"）。

- 不改 `hasConfiguration()` / `isInitialized()` / `initStatus()` 的判定规则 —— 它们对"空值 = 未配置"的处理已经是正确的；要动的只是模板别把占位符送进去。
- 现有部署不受影响：它们 `.env` 里那个占位符仍然非空，仍然算"已配置"，不会因为这次改动突然掉回向导（本机 3306 上跑着的实例就是这种状态，升级后行为不变）。
- `routes/init.js` 里 `DEV_PLACEHOLDER_SECRET` 与 `keepsSecret` 的那段保留 —— 它防的是"用户自己把占位符抄进了 `.env`"，与本条互补，不能因为模板干净了就删掉。
- 代价：`cp .env.example .env && npm start` 之后不再是"带样张的现成实例"，而是进向导。对"直接 npm 部署"这个目标而言这是**想要**的结果；想走纯环境变量部署的人自己填 `JWT_SECRET` 即可（README 两种路径都写）。

### 3.2 第二页：管理员（保持不变）

行为沿用 `POST /api/init/admin`：

- 已有租户则复用（升序第一条），只更新名称与 slug；没有则新建；
- 用户名在租户内查重，重复返回 409；
- 密码强度 ≥10 位且含字母与数字；
- 写 `users` 行，`role='admin'`、`is_active=1`、bcrypt。

### 3.3 第三页：种子（替换掉现在的 `InitReview`）

现有第三页 `InitReview.tsx` 做三件事：预览 `.env`、调 `/seed`（里面会发 `Setup Key`）、调 `/restart` 让进程退出。新的一页只做前两件的一半：

| 现有 | 改成 |
|---|---|
| 展示 `.env` 预览（脱敏） | 保留。先让人看清将要写入的配置 |
| 调 `POST /api/init/seed` 并展示 `api_key` | 调 `POST /api/init/seed`，**响应里没有 `api_key`** |
| "重启并进入系统" → `POST /api/init/restart` | **去掉**。成功后直接 `window.location.href = '/'` |
| — | 新增：展示将要种下的分类与标签清单（只读，来自后端描述） |

页面文案要说明"这一步会创建初始分类与标签若干，不会创建 API Key；API Key 进入系统后在「集成」页申请"。

**`POST /api/init/seed` 的新行为**：

1. 读 `.env`，取 `DB_*`；`JWT_SECRET` 已存在则复用，绝不轮换（轮换会让已签发的令牌全部失效）；
2. 用这些值连库，跑 `initSchema`；
3. 查第一个租户，没有则 400（"the administrator step has not run yet"）；
4. `seedDatabase(db, storageDir, { tenantId })` —— 只种初始分类与标签（见 §3.4）；
5. 热加载（§4）：重建连接池、换掉正在用的 handle、跑 boot 期该做的收尾；
6. **最后**写 `JWT_SECRET` 到 `.env` 并同步进 `process.env`；
7. 返回 `{ ok: true, jwt_secret_written: true }`。

第 5 步在第 6 步之前是有意的：`JWT_SECRET` 一旦落盘，`initStatus` 就会认为实例已初始化、向导立即关闭（§5.1）。把"可能失败的那半"放在前面，"锁门"的动作放在最后，失败时实例仍然是"未初始化"，`/seed` 可以原样重试。

也正因为门禁在锁门之前对一切请求放行，`/seed` 必须**单飞**：模块级一个 `let reloadInFlight = null`，同时进来的第二次请求复用同一个 promise，不各自跑一遍 reload（否则第二次 `rebind` 会盖掉第一次刚换上的池，泄漏一个 pool，并且两次都对同一个旧池 `end()`）。前端的按钮 loading 只是体验，不是并发控制。

`/seed` 的响应形状：先到的请求返回结果，后来的请求返回同一份结果（而不是 409）—— 运维双击时两边的界面都该看到成功。

### 3.4 种什么

保留（幂等，表里已有行就跳过）：

- 分类：产品图 / 营销素材 / AI 生成 / 视频
- 标签：封面、海报、人物、风景、抽象、品牌、SVG、动效

不再出现：

- **`seedApiKey` 整段删除**。`seedDatabase` 不再调它；`scripts/seed.js` 的注释与输出相应更新。API Key 的唯一来源是 `POST /api/v1/api-keys`（管理端、JWT 鉴权、按调用者的租户签发）。
- **示例资产默认关闭**。`SEED_SAMPLE_ASSETS` 的默认值从"开"翻成"关"：
  - `src/server/config.js`：`process.env.SEED_SAMPLE_ASSETS === '1'`；
  - `.env.example`：`SEED_SAMPLE_ASSETS=0`，注释改成"设为 1 才生成 12 张示例图"；
  - `docker-compose.yml`：`SEED_SAMPLE_ASSETS: "0"`（只改默认值，不动镜像逻辑）；
  - README 的配置表同步。

  `seedSampleAssets()` 函数本身保留。`scripts/seed.js` 的逻辑不动 —— 它读的就是 `config.seedSampleAssets`，所以默认关闭之后 **`npm run seed` 也不出样张**，要样张得 `SEED_SAMPLE_ASSETS=1 npm run seed`。（本文定为：不改脚本行为，只改脚本里那句"跳过"的提示文案，把环境变量写法说清楚。）

**幂等的粒度（本文定为）**：现有 `seedCatalogue` 只要该租户有一条 categories 就整体跳过。第 3 条分类写入失败后，重试会因"已有分类"直接返回，8 条标签永远种不上 —— §4.6 承诺的"`/seed` 可原样重试"就成了空话。

改成**按表各一个事务、各自计数为 0 才插满**：

- categories 与 tags 各自先 COUNT，为 0 时在 `db.transaction` 里插完 4 条 / 8 条；
- 部分失败整表回滚，重试从 0 开始，标签不会被"已有分类"挡住；
- 已经成功种过的表仍被计数挡住 —— 运维删掉的默认分类不会在下次 boot 时复活，那是现在粗粒度 gate 在保护的语义，不能丢；
- 两个计数分开查，所以"分类齐了、标签被清空"的情况下次 boot 会补上标签。

**关于首次 boot 的默认管理员**：不经向导、直接用环境变量配置的部署，boot 期 `seedDatabase` 仍会建默认租户 + `admin / Admin@123456` + 初始分类标签。这是既有行为，本次保留（README 写着默认账号）。向导路径下管理员由页 2 输入，`seedAdmin` 看到"该租户已有用户"就跳过。

---

## 4. 热加载

### 4.1 为什么不能只是"重新读一遍 .env"

`server.js` 有三处在 boot 时就被固定住了：

| 位置 | 固定了什么 | 后果 |
|---|---|---|
| `server.js:59` | `const config = getConfig()` | 只用于建池与建目录；`getConfig()` 本身是每次调用重新读 `process.env` 的，所以路由层不受影响 |
| `server.js:74` | `const db = createDb(createPool(config))` | `createDb` 闭包捕获了 `pool` 参数，`pool` 属性是只读的；换库要先让这个闭包能换池 |
| `server.js:82` | `const isConfigured = hasConfiguration(ENV_FILE)` | 未配置的 boot 会跳过建库/建表/seed，并把 `db: null` 交给向导 |

所以热加载要补三件事：**让 handle 可换池**、**把 `.env` 读进 `process.env`**、**在新池上补跑一遍 boot 收尾**。

### 4.2 `db` 句柄支持换池

`src/server/lib/db.js` 的 `createDb(pool)` 改成：

```js
function createDb(pool) {
  let activePool = pool;                    // 所有方法读这个，而不是参数
  const handle = {
    prepare(sql) { /* 内部用 activePool */ },
    async query(sql, params = []) { /* activePool */ },
    async exec(sql) { /* activePool */ },
    async transaction(fn) { /* activePool.getConnection() */ },

    /**
     * Point every later statement at a different pool.
     * In-flight statements keep the pool they started on; the caller owns
     * closing the old one.
     */
    rebind(nextPool) { activePool = nextPool; },

    get pool() { return activePool; },
  };
  return handle;
}
```

要点：

- `prepare()` 返回的语句对象在 **调用时**读取 `activePool`，所以换池之后同一个 handle 上后续的语句走新池；
- `pool` 从只读属性改成 getter，`tests/backend/*.js` 里 `app.locals.db.pool.end()` 的写法继续有效；
- `rebind` 不负责关旧池 —— 关池是调用方的责任，这样它可以在拿到新池、确认能用之后再关旧的。

### 4.3 `.env` 进 `process.env`：只应用向导拥有的六个键

`src/server/lib/init.js` 新增 `applyEnvToProcess(envFile)`：读出文件里的键值，**只把下面这六个写进 `process.env`**：

```
DB_HOST  DB_PORT  DB_USER  DB_PASSWORD  DB_NAME  JWT_SECRET
```

不能"文件里有什么就应用什么"：`renderEnv()` 以 `.env.example` 为骨架逐行渲染，没给值的键保留模板值 —— 所以向导写出的 `.env` 必然带着 `PORT=8000`、`HOST=0.0.0.0`、`STORAGE_DIR=./storage`、`DB_POOL_SIZE=10`、`UPLOAD_MAX_FILE_SIZE_MB=2048`、`SEED_SAMPLE_ASSETS=0`。全量应用会把 shell/容器注入的 `STORAGE_DIR` 覆盖成 `./storage`，热加载后 `getConfig().storageDir` 就跳到仓库根下，`writeManifestIndex` 会写进开发者真实的 storage 目录（`tests/backend/init.test.js` 正是靠注入 `STORAGE_DIR` 指向临时目录的）。

也不走 `dotenv.config({ override: true })`，理由同上：它会把模板的每一个默认值都盖到已注入的环境变量上。

只应用这六个键之后，§4.6 那句"改 `PORT` / `HOST` / `STORAGE_DIR` 不生效"就从一个说法变成了可验证的事实 —— 其余键在热加载前后保持进程启动时的值。

### 4.4 一次热加载做的事

新增 `src/server/lib/reload.js`，导出 `reloadConfiguration({ db, envFile })`，按顺序：

1. `applyEnvToProcess(envFile)` —— 新的 `DB_*` 与 `JWT_SECRET` 进入进程环境；
2. `const next = getConfig()`；
3. `await ensureDatabase(next)` —— 库在第一页已建好，这里是幂等的兜底；
4. `const nextPool = createPool(next)`；
5. `db.rebind(nextPool)` —— 从这一刻起路由层走新库；
6. `await initSchema(db)` —— 补表/补列/补索引；
7. `await seedDatabase(db, next.storageDir)` —— 种分类与标签（幂等）；
8. `replayPendingManifestWrites(db, next.storageDir)` + `writeManifestIndex(...)` —— 与 boot 期同一套收尾，失败只 warn，不中断（boot 期就是这么处理的）；
9. 旧池 `end()`（等它排空），失败只 warn；
10. 调用方拿到 `{ ok: true }`。

`server.js` 侧：`app.locals.ready` 换成一个 resolved promise（或重新赋值为 `Promise.resolve()`），`app.locals.isConfigured = true`，并 `closeWizardDb()` 掉向导自己那条连接（否则每次部署都会多留一个指向同一个库的池）。

### 4.5 谁调用它

`src/server/routes/init.js` 的 `/seed`，`createInitRouter` 增加一个依赖：`reload: () => reloadConfiguration({ db, envFile })`。`server.js` 传进去，闭包里持有 `db` 与 `ENV_FILE`。

`onRestart` 参数与 `POST /api/init/restart` 一并删除 —— 向导不再需要它，而"从请求处理器里 `process.exit`"正是这次要拿掉的东西。

### 4.6 边界与失败语义

| 情况 | 行为 |
|---|---|
| 第 3–8 步任何一步抛错 | 400/500，响应带 `detail`；`JWT_SECRET` 未写入 → 实例仍是"未初始化"，向导仍打开，`/seed` 可重试（所有 seed 步骤幂等） |
| 旧池 `end()` 失败 | 只 warn。旧池指向的是 boot 期的默认配置（未配置的 boot 上它连一次都没连过），排空失败不影响新池 |
| 已在飞行中的查询 | 走的是旧池，`end()` 会等它完成；未配置的 boot 上路由层本来什么都查不到（`/health` 不打库），实际风险可忽略 |
| 改 `PORT` / `HOST` / `STORAGE_DIR` | **不生效**：向导不写这几个键，`.env.example` 模板保留默认值。真要改，仍是改配置 + 重启进程 |
| 已初始化后再次打开 `/init` | 不变：`/api/init/status` 仍 200，其余 `/api/init/*` 404 |

---

## 5. 状态与前端

### 5.1 "已初始化"的判定（不变）

`.env`（或进程环境）里有非空 `JWT_SECRET`，**且** `tenants` 表里有行。向导的所有端点靠这个条件自我关闭。

判定规则一个字不改。§3.1 改动的是**模板**（`.env.example` 不再带占位值），不是判定 —— 这条区分要记住：判定层保持现状，才不会有既有部署在升级后突然"看起来未配置"。

因此 §3.3 的第 5→6 步顺序是**唯一**能让"热加载失败时可恢复"成立的地方，实现时不能调换。

### 5.2 `steps` 的含义

沿用现有三项，不改语义：

| 字段 | 含义 | 向导里的作用 |
|---|---|---|
| `steps.database` | `.env` 有 `DB_NAME` 且库里有租户 | 打开在第 2 页 |
| `steps.admin` | 有租户且有 admin 用户 | 打开在第 3 页 |
| `steps.seed` | `.env` 有 `JWT_SECRET` | 第 3 页的"完成"状态 |

`steps.seed` 仍然只表示"签名密钥已写入" —— 那正是第 3 页唯一不可逆（写入即锁门）的动作。分类与标签是幂等补种的，不参与状态判定。

`src/client/pages/init/initSteps.ts` 的 `stepFromStatus` 与 `tests/lib/runtime-checks-init.js` 的断言全部保持有效；只把常量名 `STEP_REVIEW` 改成 `STEP_SEED`（含义变了，名字要跟上）。

### 5.3 前端改动

| 文件 | 改动 |
|---|---|
| `InitReview.tsx` | 改名为 `InitSeed.tsx`，重写内容：脱敏 `.env` 预览 + "将创建的分类/标签" + 完成按钮；去掉 `api_key` 展示与 `initApi.restart()` |
| `InitWizard.tsx` | import 改成 `InitSeed`；`Steps` 第三项标题 `确认` → `种子数据` |
| `initApi.ts` | 删 `restart()`；`SeedResult` 去掉 `api_key`（只保留 `jwt_secret_written`）；`runSeed` 的注释同步 |
| `initSteps.ts` | `STEP_REVIEW` → `STEP_SEED` |

令牌仍然只存在 React state 与 `initApi` 的模块内存里，`tests/lib/init-token-storage.js` 的禁令继续生效。

### 5.4 `main.tsx` 的跳转（不变）

未初始化时 `/` 重定向到 `/init`。热加载完成后 `initStatus` 变真，刷新即进系统；第三页成功后直接 `href='/'`，走的就是这条路。

---

## 6. 安全

- `X-Init-Token` 逐次启动随机生成、打印在控制台、只存在内存（既有行为，不改）。`INIT_TOKEN` 环境变量可固定它，供自动化部署用。
- 令牌比较继续用 `crypto.timingSafeEqual`。
- 管理员密码强度校验（≥10 位、字母 + 数字）不变。
- 向导不打印、不返回任何凭据明文。`JWT_SECRET` 生成后只写进 `.env`（原子替换、`0o600`）。
- `.env` 预览继续按 `/SECRET|PASSWORD|TOKEN/i` 脱敏。
- 已初始化后向导端点 404，避免被当作"重置入口"。
- **未初始化时的签名密钥**：`JWT_SECRET` 为空的情况下 `config.js` 会落到开发占位符（第 95 行 `|| 'dam-dev-secret-change-me-in-production'`）。这条路径不可利用 —— 未初始化的 boot 不建表、不 seed、没有租户也没有用户，`POST /api/v1/auth/login` 无账号可查，签不出任何能用的令牌；而热加载的第一步就是把真实密钥写进 `process.env`，早于任何新请求进入业务路由。本文不改这个兜底值（改动会让现有开发环境的令牌全部失效），只在此记录它是已知且被其他条件堵死的。
- **占位密钥不再随模板外发**（§3.1）：`.env.example` 的 `JWT_SECRET` 留空，减少"照抄模板 → 线上用了人人皆知的密钥"这一类事故。

---

## 7. 测试与文档

### 必须改的测试

| 文件 | 改动 |
|---|---|
| `tests/backend/init.test.js` | 第 6 步：删掉 `seed.body.api_key` 的三个断言，代之以 `assert.strictEqual(seed.body.api_key, undefined)`、`api_keys` 表在该租户下 0 行；新增"分页种子里有分类与标签"的断言；新增**免重启**断言 —— 直接用它刚建的管理员登录 `POST /api/v1/auth/login` 并拿到可用的 access token；新增"`/seed` 第二次返回 404"（热加载已让向导关门） |
| `tests/backend/server.test.js` 等 | 不受影响：它们自己 `INSERT INTO api_keys` 造 key，不依赖 seed 发的 |
| `tests/backend/acceptance.probe.js` | **要改**（本文定为维护它，不放弃）。它不在 `run.js` 的套件里，是 `bd4b715` 留下的手工验收脚本，现状会在这轮之后必然失败：`assert.ok(seed.body.api_key)` 与随后用该 key 跑 ingest。改成 —— 向导三页 → 用页 2 的管理员密码登录拿 JWT → `POST /api/v1/api-keys` 申请一把 → 用它跑 criterion 3/4 的 ingest 与 ComfyUI。同时把它注释里"重启后才是已配置"的说法改成"热加载后立即已配置"，并把 `SEED_SAMPLE_ASSETS: '1'` 保留（它要验证样张 12 张那条断言） |
| `tests/backend/init.test.js`（新增一条） | 把仓库里的 `.env.example` **原样拷进临时目录当 `.env`**，断言 `hasConfiguration()` 为 `false`、`/api/init/status` 的 `initialized` 为 `false`。这条锁住 §3.1 的"模板不带占位密钥"，将来谁再把占位符写回模板，测试立刻红 |
| `tests/lib/runtime-checks-init.js` | 不改（`stepFromStatus` 规则未变） |
| `tests/lib/runtime-checks-identity.js` | 不改（已配置实例的 `steps` 形状未变） |

### 必须改的文档

- `README.md`：新增"初始化向导"一节（空机器 → `npm install && npm run build && npm start` → 控制台拿令牌 → `/init` 三页 → 直接进系统），并说明第一条 API Key 在「集成」页申请；配置表里 `SEED_SAMPLE_ASSETS` 改成默认 0；同时把现有的"方法二：`cp .env.example .env` 后填空 `DB_*` 即用"改成两条并列路径 —— (a) 向导部署（拷模板、不填 `JWT_SECRET`、走 `/init`），(b) 纯环境变量部署（拷模板、手工填 `JWT_SECRET` 与 `DB_*`）；安全建议第 3 条从"修改默认 API Key"改成"为每个外部系统单独申请 API Key"。
- `.env.example`：`SEED_SAMPLE_ASSETS=0` 并改注释；`JWT_SECRET=` **留空**，注释说明由向导生成或手工填 ≥32 位随机串。
- `docker-compose.yml`：`SEED_SAMPLE_ASSETS: "0"`。**`JWT_SECRET` 那行不动** —— compose 路径本来就不走向导，它必须自带一个非空值，占位文案保留并继续提示"上线前必改"。

---

## 8. 风险

| 风险 | 应对 |
|---|---|
| 热加载中途失败，实例半配置 | 顺序保证（§3.3 第 5→6 步）：锁门动作最后做；失败时向导仍开着，`/seed` 可重试 |
| `rebind` 之后旧池仍有借用连接 | `end()` 排空并只 warn；未配置的 boot 上旧池从未建立连接 |
| 重名校验只在租户内 | 既有行为；`(tenant_id, username)` 是复合唯一键，跨租户重名合法 |
| `db.js` / `init.js` 接近 500 行上限 | 热加载放独立模块 `lib/reload.js`；`init.js` 删掉 `/restart` 与 Setup Key 一段后净减少 |
| 运维仍按旧文档找"重启" | README 与第三页文案都明确写"完成后无需重启" |

---

## 9. 交由实现者决定的点

- `reload.js` 内部拆几个函数、日志前缀（建议 `[reload]`）。
- 第三页"将创建的分类/标签"清单是前端硬编码常量还是新增一个只读端点 `GET /api/init/seed-plan`。**倾向**：前者，省一条路由，清单本来就在种子模块里固定；若清单要从 `seed.js` 单一来源读取，再加端点。
- `seedDatabase` 的 `skipSamples` 选项在默认关示例资产之后是否还需要：保留（`scripts/seed.js` 仍用它控制"由脚本自己等样张生成完毕"）。
