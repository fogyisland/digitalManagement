# DAM 多租户 · 初始化向导 · 对接协议 · ComfyUI 节点 —— 设计文档

**日期**：2026-11-01
**状态**：待批准
**范围**：四个相互关联但可分期交付的子系统

---

## 1. 背景

系统目前是单租户的：所有表都没有租户列，任何一个 API Key 都能看到全部资产。新增四件事：

1. **多租户** —— 平台化，多个团队/客户的数据彼此隔离；
2. **初始化向导** —— 现在要手工编辑 `.env`、手工建库，新部署很难上手；
3. **接收接口与推送协议** —— 推送（webhook）已有，**接收**（外部系统把数据推进来）是空的；
4. **ComfyUI 节点** —— 后端已有 `/assets/from-comfyui/:job_id`，但 ComfyUI 那一侧没有任何东西。

### 已确认的决策

| 决策点 | 结论 |
|---|---|
| 租户隔离 | 共享库 + `tenant_id` 列 |
| 租户识别 | API Key 绑定租户；管理端 JWT 携带 `tenant_id` |
| 初始化形态 | 网页向导（`/init`）+ 后端 `/api/init/*` |
| ComfyUI 节点 | Python 薄节点（ComfyUI 生态只认 Python），核心逻辑仍在 Node 侧 |

> ComfyUI 节点是**唯一的 Python 部分**，放在独立的 `comfyui-node/` 目录，不进入主仓库的 Node 依赖树。

---

## 2. 多租户

### 2.1 数据模型

新增 `tenants` 表：

```sql
CREATE TABLE tenants (
  id            VARCHAR(64) NOT NULL PRIMARY KEY,
  name          VARCHAR(191) NOT NULL,
  slug          VARCHAR(191) NOT NULL,
  status        VARCHAR(32) NOT NULL DEFAULT 'active',   -- active | suspended
  settings_json TEXT,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_tenants_slug (slug)
)
```

**所有业务表增加 `tenant_id VARCHAR(64) NOT NULL`**：

`users` · `assets` · `asset_tags` · `categories` · `tags` · `api_keys` · `audit_logs` · `webhook_endpoints` · `webhook_logs` · `manifest_writes` · `upload_sessions` · `token_registry` · `revoked_tokens`

**唯一约束改为复合键**，否则跨租户会撞名：

| 表 | 原来 | 改成 |
|---|---|---|
| `users` | `username` 唯一 | `(tenant_id, username)` |
| `categories` | `name` / `slug` 唯一 | `(tenant_id, name)` / `(tenant_id, slug)` |
| `tags` | `name` / `slug` 唯一 | `(tenant_id, name)` / `(tenant_id, slug)` |
| `api_keys` | 无 | `(tenant_id, key_hash)` 唯一 |

`asset_tags` 的主键改为 `(tenant_id, asset_id, tag_id)`。

### 2.2 迁移

现有数据归入一个名为 **default** 的租户（`id = 'default'`）：

1. 建 `tenants` 表，插入 default 租户；
2. 每张业务表 `ALTER TABLE ... ADD COLUMN tenant_id VARCHAR(64) NOT NULL DEFAULT 'default'`；
3. 改唯一索引（`DROP INDEX` + `ADD UNIQUE KEY`）；
4. `asset_tags` 加 tenant_id 并改主键。

迁移在 `initSchema` 里以幂等方式完成 —— 与现有的"缺列才 ALTER"同一套机制（查 `information_schema` 再动）。

**两条路径要区分清楚**（init 向导与迁移都会碰到 tenants 表）：

| 场景 | `tenants` 表 | 第一个租户 |
|---|---|---|
| 空库首次初始化 | 空 | 向导第 2 页创建，id 用 nanoid，slug 取自用户填的租户名 |
| 已有库升级 | 迁移已插入 `default` | 沿用 `default`，向导第 2 页改为"修改默认租户名称" |

判据是 `tenants` 表是否已有行，而不是"有没有 users 表" —— 空库但已建过租户的情况必须被识别为"已初始化"。

### 2.3 租户上下文

**鉴权中间件负责解析租户，挂到 `req.tenant`**：

| 鉴权方式 | 租户来源 |
|---|---|
| 管理端 JWT | payload 里的 `tid`（签发时写入） |
| API Key（`X-API-Key`） | `api_keys.tenant_id` |
| 超管令牌 | `tid = '*'`，允许跨租户读（写仍需指定租户） |

新增平台级角色 `superadmin`（`users.role`）：可列出所有租户、在任意租户下操作。

**所有查询必须带租户条件**。落地上不靠每个 handler 自觉 —— 用两个入口函数把「忘记加租户条件」变成不可能：

- `src/server/lib/tenant.js` 导出 `scopedDb(db, tenantId)`，返回一个代理：`db.prepare(sql)` 时自动把 `WHERE`/`INSERT` 的第一个占位符替换为租户条件。
  - 实现方式：不做 SQL 解析（脆弱）。改为**约定式**：所有业务 SQL 以 `WHERE tenant_id = ?` 开头或包含标记 `-- tenant` ，代理在 `prepare` 时注入 `AND tenant_id = ?` 并把参数前置。
  - 更稳的落法：**每条业务 SQL 显式写 `tenant_id = ?`**，由护栏（静态检查）核对"每个涉及业务表的 SQL 是否含 tenant_id"。护栏已经能扫路由与 lib 的 SQL —— 扩展它，让漏写租户条件直接失败。
- **选后者**（显式 + 护栏强制）。理由：SQL 改写代理在 INSERT/子查询/聚合上极易出错，而护栏能给出确定性结论。

**护栏新增检查**：扫描 `src/server/{routes,lib}` 中所有 `db.prepare(...)` 的 SQL 字符串，凡涉及业务表且不含 `tenant_id` 的，一律失败并指名文件行号。

### 2.4 越权防护

- `req.tenant` 为空（未鉴权或 Key 无租户）→ 403。
- 跨租户访问（资源 id 属于别的租户）→ 404 而不是 403（不泄露"存在"这个事实）。
- `api_keys` 的 scope 之外，租户本身也是一个维度：Key 只能看到自己租户的数据。

---

## 3. 初始化向导

### 3.1 形态

前端路由 `/init`，三页向导；后端 `/api/init/*`。**只有未初始化的实例才开放这些端点**，初始化完成后 `/api/init/*` 一律 404。

```
/init
  第 1 页  数据库连接     host / port / user / password / database
  第 2 页  管理员         用户名 / 密码 / 邮箱 / 租户名称
  第 3 页  确认与写入     预览 .env 内容 + seed 摘要 → 写入并应用
```

根路径 `/` 在未初始化时重定向到 `/init`；已初始化则正常进入应用。

### 3.2 后端接口

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/api/init/status` | `{ initialized: boolean, steps: {...} }` —— 未初始化时永远可访问 |
| POST | `/api/init/database` | 测连接 → 建库 → 建表 → 回写 `.env` 的 `DB_*` |
| POST | `/api/init/admin` | 建默认租户 → 建管理员（密码 bcrypt） |
| POST | `/api/init/seed` | 生成 JWT_SECRET / Demo API Key → 写入 `.env` → 跑 seed |
| GET | `/api/init/env-preview` | 返回将要写入 `.env` 的完整内容（脱敏） |

**"已初始化"的判定**：`.env` 存在且包含非空的 `JWT_SECRET`，**且** `tenants` 表里已有租户。两个条件都满足才算完成 —— 只写了一半时可以继续向导。

### 3.3 `.env` 写入

`.env.example` 是模板。init 写 `.env` 时：**以 `.env.example` 的键为骨架**，逐个填值：

- 用户填的（DB_*, 管理员信息不进 .env）；
- 生成的（`JWT_SECRET` = 32 字节随机 hex；Demo API Key 的明文只在这里出现一次）；
- 保留默认的（`PORT`、`STORAGE_DIR`、TTL、上传上限）。

写入是**原子**的：先写 `.env.tmp`，再 `rename` 覆盖。写完不自动重启 —— 向导提示"重启后生效"，并提供"重启并进入系统"的按钮（后端 `POST /api/init/restart` 触发 `process.exit`，由进程管理器拉起）。

### 3.4 安全

- init 接口只在本机监听时可用（`HOST` 是 `0.0.0.0` 时拒绝）—— 或者反过来，要求 `INIT_TOKEN` 环境变量。**决定：默认要求请求带 `X-Init-Token`，令牌由启动时随机生成并打印在控制台**，避免裸奔在公网上。
- 管理员密码强度校验（≥10 位，含字母与数字）。
- init 全部完成后，`GET /api/init/status` 仍可访问（用于前端判断跳转），但其余端点关闭。

---

## 4. 接收接口与推送协议

### 4.1 接收（ingest）

新增命名空间 `/api/ingest/v1`，用 **API Key** 鉴权（租户由 Key 决定），面向外部系统把数据推进来：

| 方法 | 路径 | 作用 |
|---|---|---|
| POST | `/api/ingest/v1/assets` | multipart（`files`）或 JSON（`url`）推入资产，等价于内部上传，但归属 Key 的租户 |
| POST | `/api/ingest/v1/assets/:id/metadata` | 推送/更新元数据（标题、标签、分类、状态） |
| POST | `/api/ingest/v1/events` | 推送任意业务事件，写入 `audit_logs` 并可触发 webhook |

scope 要求：推资产要 `upload`，推元数据要 `write`，推事件要 `write`。

`POST /api/ingest/v1/assets` 复用 `processUpload`，因此去重、缩略图、清单、Webhook 派发全部一致 —— **ingest 不是另一套实现，只是另一个入口**。

### 4.2 推送（webhook）协议

已有实现保留，补齐协议要素：

**请求头**：

| 头 | 含义 |
|---|---|
| `X-DAM-Signature` | `sha256=<hex>`，HMAC-SHA256(secret, `${timestamp}.${body}`) |
| `X-DAM-Timestamp` | Unix 秒 —— **新增**，用于防重放 |
| `X-DAM-Event` | 事件名 |
| `X-DAM-Attempt` | 第几次尝试（1..3） |
| `X-DAM-Delivery` | 投递 ID（可追溯到 `webhook_logs.id`） |

**签名口径变更**：现有实现签的是 body 本身。改为签 `${timestamp}.${body}`，接收方必须校验时间戳偏差（建议 ±5 分钟）—— 这是防重放的最小代价，会改变已部署接收方的校验逻辑，属**破坏性变更**，在 spec 中明确。

**投递策略**：最多 3 次，指数退避（1s / 4s / 16s），4xx 不重试（除 429），5xx 与网络错误重试；失败**不自动停用**端点（保留现状）。

**事件词汇表**（`WEBHOOK_EVENTS`，前后端各一份，需同步）：

```
asset.created  asset.updated  asset.deleted
asset.restored  asset.metadata_updated
tenant.created  tenant.updated
```

新增 `asset.restored` 与 `asset.metadata_updated`（当前软删/复原不触发事件，这是缺口）。

---

## 5. ComfyUI 节点

### 5.1 位置与形态

独立目录 `comfyui-node/`，一个可 `pip install -e .` 的 Python 包（ComfyUI 自定义节点标准）。它**不进入主仓库依赖树**，只通过 HTTP 与本系统通信。

```
comfyui-node/
├── pyproject.toml
├── README.md
├── dam_node/__init__.py
├── dam_node/node.py          # 节点定义
├── dam_node/client.py        # HTTP 客户端（零依赖，用 urllib）
└── dam_node/config.py        # 配置读取
```

### 5.2 节点行为

| 节点 | 输入 | 输出 | 行为 |
|---|---|---|---|
| `DAM Upload` | `image`/`video`/`audio`（任意类型）、`title`、`tags`、`wait_for_ready` | `asset_id`（STRING）、`status`（STRING） | 上传到 DAM，落地为资产 |
| `DAM Register Job` | `job_id`、`title` | `asset_id` | 只登记占位（对应现有的 `/assets/from-comfyui/:job_id`） |
| `DAM Lookup Job` | `job_id` | `asset_id`、`status` | 反查任务对应的资产 |

**上传走哪条路**：新增 `POST /api/ingest/v1/comfyui/:job_id`（multipart `files`），一个端点同时完成"登记任务"和"上传产物"，避免节点要调两次。节点内部用 `urllib` 发 multipart（不引入 requests 依赖）。

### 5.3 配置

```
DAM_API_URL=http://127.0.0.1:8000
DAM_API_KEY=dam_xxx
DAM_TENANT=default     # 仅用于日志展示，真实租户由 Key 决定
```

配置来源：环境变量优先，其次 ComfyUI 的 `extra_model_paths.yaml` 旁的 `dam_config.json`。

### 5.4 节点状态回写

节点上传后，把 `job_id` 写进资产的 `job_id` 字段 —— 这正是现有 `GET /jobs/by-comfyui/:job_id` 反查所依赖的字段，因此 ComfyUI 侧的任务与 DAM 侧的资产可以互查。

---

## 6. 交付顺序

四个子系统按依赖排序，每个阶段都能独立验证：

| 阶段 | 内容 | 验证 |
|---|---|---|
| **A. 多租户基础** | `tenants` 表 + `tenant_id` 列 + 迁移 + JWT/API Key 带租户 + 护栏检查租户条件 | 后端 suite + 护栏；跨租户访问返回 404 |
| **B. 初始化向导** | `/api/init/*` + 前端 `/init` 三页 + `.env` 原子写入 | 空库走完向导 → 服务起来 → 登录成功 |
| **C. 接收与推送** | `/api/ingest/v1/*` + webhook 签名口径变更 + 新事件 | ingest 推资产 → 前端可见；webhook 收到签名 |
| **D. ComfyUI 节点** | `comfyui-node/` 包 + `POST /api/ingest/v1/comfyui/:job_id` | 节点上传 → DAM 出现资产 → 反查得到 job_id |

阶段 A 是 B/C/D 的地基（init 向导要建租户，ingest 要按租户落数据，ComfyUI 走 ingest）。

---

## 7. 不做的事

- 不做数据库级隔离（已决定共享表 + `tenant_id`）。
- 不做子域名（已决定用 API Key / JWT 携带租户）。
- 不做 OAuth / SSO 接入。
- ComfyUI 侧不做模型推理相关逻辑 —— 节点只负责把产物送进 DAM。
- 不做多语言（界面沿用现有中文）。

---

## 8. 风险

| 风险 | 缓解 |
|---|---|
| 给所有表加 `tenant_id` 漏改查询 → 跨租户泄漏 | 护栏强制检查（阶段 A 的一部分） |
| 复合唯一键改造使旧索引失效 | 迁移里 `DROP INDEX` + `ADD UNIQUE KEY`，并校验 |
| webhook 签名口径变更破坏已有接收方 | 明确写进 changelog 与 README；可加 `X-DAM-Signature-V2` 双签过渡 |
| init 接口裸奔在公网 | 强制 `X-Init-Token` |
| ComfyUI 节点的 Python 与主仓库 Node 体系割裂 | 目录隔离 + 契约测试（节点只依赖 HTTP 契约） |
