# 数字资产管理系统 (Digital Asset Management)

> 一站式存储、管理、分发图片与视频等数字资产，通过 RESTful API + API Key 向其他系统提供可控的资产投递能力。

整个系统是 **Node.js 模块**：一个 Express 进程同时提供管理 API、投递 API、静态文件与前端界面，**只占一个端口（默认 8000）**。数据落在 MySQL 里。

## ✨ 核心特性

| 模块 | 能力 |
|------|------|
| 📦 **资产管理** | 图片（JPG/PNG/WebP/GIF/SVG/BMP/TIFF）+ 视频（MP4/MOV/WebM/MKV/AVI/M4V） |
| 🔐 **双轨认证** | 管理后台 JWT，外部投递 API Key |
| 📤 **上传方式** | 单次多文件、分片（大文件）、外部 URL 导入 |
| 🏷️ **分类标签** | 分类与标签管理 |
| 🖼️ **媒体处理** | 自动缩略图、WebP 预览、视频封面、EXIF 提取 |
| 🔑 **API Key** | 细粒度权限（read / upload / delete）、随时停用 |
| 🔔 **Webhook** | 资产变更实时通知，HMAC 签名校验 |
| 🗑️ **三态删除** | 软删除 → 回收站 → 永久删除，支持复原 |
| 🌓 **统一端口** | 单端口同时托管 UI + API + 静态资源 |

## 🛠 技术栈

**后端**：Node.js 22 LTS+ · Express 4 · mysql2 · sharp · multer · jsonwebtoken · bcryptjs · nanoid · dotenv

**前端**：React 18 · TypeScript 5 · Vite 6 · Ant Design 5 · Zustand · React Router 6 · axios

**数据库**：MySQL 8.0（5.7+ 同样可用）

**存储**：本地文件系统（`storage/`）

## 🚀 快速开始

### 方式一：一键脚本（推荐）

**Windows**：
```cmd
start.bat
```

**macOS / Linux**：
```bash
chmod +x start.sh
./start.sh
```

脚本会自动：
1. 检查 Node.js 环境
2. 安装后端依赖
3. 构建前端
4. 启动后端（单端口 8000，API + 界面都在这里）

### 方式二：手动启动

```bash
# 1. 依赖（前后端同一份）
npm install
cp .env.example .env        # Windows: copy .env.example .env

# 2. 填好 .env 里的 DB_HOST / DB_USER / DB_PASSWORD，
#    并确认 MySQL 已经在跑（服务会自动建库建表）

# 3. 构建前端（产物由后端托管）
npm run build

# 4. 启动（前台）
npm start
```

打开浏览器：**http://localhost:8000**

### 首次使用：初始化向导（推荐）

一台空机器（全新数据库、没有 `.env`）不需要手写任何配置：

1. `npm install && npm run build && npm start`
2. 后端启动时会在控制台打印一行 `X-Init-Token`，复制它
3. 浏览器打开 `http://localhost:8000/init`，粘贴令牌
4. 依次完成三页：**数据库 → 管理员 → 种子数据**
5. 第三页确认写入后，服务**热加载**新配置——不重启，直接「完成并进入系统」

向导会自己生成 JWT 密钥并写入 `.env`，同时创建首个租户、管理员账号和初始分类/标签。API Key 不在向导里发放：进入系统后在「集成」页按外部系统各自申请。

### 手动环境变量部署（不用向导）

已经有运维流程、想直接用 `.env` 管配置的，也可以完全绕开向导：复制 `.env.example`，手工填好 `DB_*` 各项与一个 32 字符以上的随机 `JWT_SECRET`，再启动即可——检测到完整配置时初始化接口自动关闭。

默认账号：
- 用户名：`admin`
- 密码：`Admin@123456`

> ⚠️ 首次部署后请立即修改密码！

服务启动时会在控制台列出**实际存在**的账号（租户、用户名、角色）。种子只在目标租户一个用户都没有时才会建这个 `admin`；走向导部署的实例里没有这个账号，账号名就是向导里你填的那个。

### 多租户与平台管理员

一个租户是库里所有数据归属的边界。**租户管理员管自己租户里的内容**（资产、分类、标签、用户、密钥），**平台管理员管租户本身**。

#### 两扇门

平台层比租户层**高一层**，所以登录有两条路：

| | 入口 | 谁进得来 | 进去之后 |
|---|---|---|---|
| **租户门** | `/login`（首页） | 该租户的账号 | 落在那个租户里，只管那个租户 |
| **平台门** | `/platform/login`（登录页底部那个链接） | 只有平台管理员 | 落在平台层：管租户、签发自己的 MCP 令牌 |

登录页先选租户再登凭据——租户清单是公开的（`GET /api/v1/auth/tenants`），只有 id、名称和状态，租户里有什么在登录之前不关别人的事。选中的租户就是这次会话的范围：顶部的租户选择器会跟着它走。

平台门对租户管理员是**拒绝**（403），不是跳转——租户管理员没有资格进自己租户之上那一层。平台门的会话不带租户范围，它就是平台自己的范围。

#### 平台层做什么

平台管理员在平台控制台（`/platform`，侧边栏「系统 → 租户管理」进去）里。平台层自己是一个**独立外壳**：不套应用的主界面，也没有租户作用域，它回答的是「整个平台现在是什么样」。控制台有六个页签：

| 页签 | 做什么 |
|---|---|
| **总览** | 跨租户统计：租户数、账号数、资产数、存储占用、分类/标签数，以及最近 24 小时的请求数与进出流量 |
| **租户** | 新建租户、改名改 slug、停用、删除 |
| **账号** | 跨租户的账号目录；搜索、按角色/状态筛；改角色、改归属租户、启停 |
| **审计** | 平台层做过的动作流水：谁、何时、对谁、做了什么 |
| **调用日志** | 整个平台的进出流量：谁在什么时候调了哪个接口、进来多少字节、出去多少字节 |
| **MCP 令牌** | 签发 / 吊销平台层自己的 MCP 令牌 |
| **设置** | 这个实例对外的**访问域名**，以及允许跨域调用它的来源；保存即生效 |

- **停用**是开关：该租户的所有账号**立刻无法登录**，数据留着，随时可以启用。
- **删除**不可逆：租户和它里面的资产、账号、分类、标签、密钥、文件一起消失。界面要求先输入租户 id 确认。
- **改角色 / 改归属**会结束该账号的现有会话：令牌里带着签发时的角色和租户，一个活得比角色还久的令牌，是平台收不回来的凭证。降级时必须**显式**指定回到哪个租户——平台不记忆它原来在哪。
- 平台层的动作落审计，租户 id 记成通配 `*`，所以删掉租户之后，「它被删了」这条记录还在。
- 租户里的人的改动也落审计，但落在**它自己租户**的名下：租户后台的「管理 → 操作日志」读的就是这一份。平台的审计页签只读平台层的动作（通配 `*`），两层各看各的。

#### 访问域名与跨域白名单

平台控制台的「设置」页签里有两个字段，它们说的是这个**实例**自己：

- **访问域名** —— 这个实例对外的地址，例如 `https://dam.example.com`。服务端生成的绝对链接（下载链接、资产清单里的 `public_url`）、租户后台「设置」页显示的「API 基础地址」、MCP 客户端要填的地址，都从它来。留空表示按当前请求推导：那种链接只在发起请求的浏览器里能用，粘到别处就不对了。
- **允许的跨域来源** —— 哪些来源的页面可以用浏览器直接调用这个实例的接口。默认是空的：界面和实例同源，不需要跨域。访问域名本身永远在允许之列——界面就是从那里来的，它当然能调用自己。

这两项以前是环境变量里的 `APP_BASE_URL` / `CORS_ORIGINS`，改一次要重启一次。现在落在库里，**保存即生效**。

`PUT /api/v1/platform/settings` **只改请求里带了的字段**：传 `access_domain` 不会顺手清掉跨域白名单，传空串才是清空。

#### 调用日志与流量

平台层还记着**流量**：每一次 API 调用落一行——方法、路径、命中的路由样式、状态码、耗时、进来的字节、出去的字节、说的是哪个租户、谁调的。

- 它和**审计**不是一回事：审计说「人改了什么」，日志说「这个实例被要求做了什么、搬了多少数据」。
- 行是在响应发出**之后**写的，所以日志再慢也不会拖慢接口。
- 前端的静态资源和健康探针**不记**——否则一堆 JS 请求会把真正的 API 流量埋掉。
- 日志是唯一一张自己会长大的表，所以它按保留期清理：默认留 30 天（`REQUEST_LOG_RETENTION_DAYS`），过期行每小时清一次。不想记就 `REQUEST_LOG_ENABLED=0`。

命令行做的是同一套事（规则同源，不存在「界面能建、命令行不能建」）：

```bash
# 建一个租户（--id 是请求里 X-Tenant 用的那个名字）
npm run tenant:create -- --name "Acme Corp" --slug acme --id acme
```

租户 **id 必须是 ASCII**：请求头 `X-Tenant` 只能是字节串，所以租户名是中文时 id 会自动生成一个能用的。

**平台管理员**（`role=superadmin`）的账号不属于任何租户：它默认能读整个平台，并可以用 `X-Tenant` 头把请求收窄到任意一个租户。这个角色没有对应的 API——能读所有租户的角色是一道安全边界，给它一个发放入口就是提权后门——所以它在控制台发：

```bash
# 新建一个平台管理员（不给 --password 就随机生成并打印一次）
npm run superadmin -- --username root

# 把一个已有的租户账号提升为平台管理员
npm run superadmin -- --username alice --promote
```

拿到账号后从平台门登录，右上角的「进入资产库」把你带回应用；应用里的租户选择器决定接下来在哪个租户里行事。

### 方式三：Docker Compose

```bash
docker compose up -d --build
```

单个容器跑完整系统（前端 + API + MySQL + 文件存储），应用同样只暴露 8000 端口。
数据库与文件分别落在 `mysql_data` / `dam_storage` 两个 volume 里。

### 方式四：Nginx / Caddy 反向代理

生产环境通常要在前面放一层反向代理来终止 TLS。**这个应用只占一个端口**，所以代理只需要一个 upstream。

完整的配置、缓存规则、上传体积、真实 IP 与排查清单见 **[`docs/DEPLOY-NGINX.md`](docs/DEPLOY-NGINX.md)**。

三件必须做的事：

1. 代理要转发 `X-Forwarded-For` 与 `X-Forwarded-Proto`；
2. 应用的 `.env` 里设 `TRUST_PROXY=loopback`（否则审计日志里的 IP 全是 `127.0.0.1`）；
3. 平台控制台「设置」里的**访问域名**填成对外的 `https://` 地址（签名文件链接按它生成）。

### 方式五：发布包（上传到裸服务器）

要部署到一台只有 Node.js 与 MySQL 的机器上，不带 Docker：

```bash
npm run release          # 构建前端，并把可发布内容整理到 up/
npm run release:verify   # 真的把 up/ 启动一遍，逐项验证
```

`up/` 就是**要上传到服务器的全部内容**：前端构建产物、服务端运行时、依赖清单、配置模板、可写目录骨架、建库 SQL、Nginx 配置样例和部署说明。

```bash
scp -r up/* deploy@server:/srv/dam/
ssh deploy@server 'cd /srv/dam && npm ci --omit=dev && ./start.sh'
```

包里**故意不带** `node_modules`（`sharp` 与 `bcryptjs` 带原生二进制，必须在目标机上编译）和 `.env`（里面是密钥）。完整的部署步骤、systemd 单元、上线自检清单和备份方案在 `up/DEPLOY.md`。

打包器会**拒绝用陈旧的前端构建产物出包** —— `dist/` 比源码旧就报错，而不是打一个看起来完整、其实发的是上一版代码的包。

### 开发模式（可选）

前端改动需要热更新时，用 Vite 的 dev server，它把 `/api` 代理到 8000：

```bash
npm run dev          # http://localhost:5173
npm run dev:server   # 后端热重启 :8000
```

> 这是**可选**的第二端口。默认的单端口模式（8000）不需要它。

## 📡 API 速览

**接口文档就在实例自己身上**：

| 地址 | 是什么 |
|------|--------|
| `/docs` | Swagger UI —— 可读、可试 |
| `/redoc` | ReDoc —— 只读，排版舒服 |
| `/openapi.json` | OpenAPI 3.0 规范本身，给工具用 |

规范文件是 `src/server/openapi.yaml`，**构建时会被检查**：它必须和后端真正注册的路由一一对应——少一条（后端有、规范没有）或者多一条（规范有、后端没有）都让构建变红。文档不会撒谎。

命名空间：

| 前缀 | 鉴权 | 用途 |
|------|------|------|
| `/api/v1` | `Authorization: Bearer <JWT>` | 管理 API |
| `/api/public/v1` | `X-API-Key: dam_xxx` | 投递 API |
| `/api/ingest/v1` | `X-API-Key: dam_xxx` | 外部接入 API（ComfyUI 节点等外部系统往里推） |
| `/api/health` | 无 | 健康检查 |
| `/storage/*` | 无 | 上传文件与缩略图 |

### 管理 API（JWT 鉴权）

| Method | Path | 描述 |
|--------|------|------|
| POST | `/api/v1/auth/login` | 租户登录，返回 access + refresh token（可带 `tenant` 指定租户） |
| POST | `/api/v1/auth/platform-login` | 平台登录（**仅平台管理员**，否则 403） |
| GET | `/api/v1/auth/tenants` | 公开租户清单（id / 名称 / 状态），登录页用 |
| POST | `/api/v1/auth/refresh` | 轮换令牌（旧 refresh 立即作废） |
| POST | `/api/v1/auth/logout` | 注销，吊销 access token 与会话 |
| GET | `/api/v1/auth/me` | 当前用户 |
| POST | `/api/v1/auth/change-password` | 修改密码 |
| GET | `/api/v1/audit` | 本租户的操作流水（管理员看整个租户，其余账号只看自己的） |
| GET | `/api/v1/users` | 用户列表 |
| POST | `/api/v1/users` | 新建用户 |
| PUT | `/api/v1/users/:id` | 更新用户 |
| DELETE | `/api/v1/users/:id` | 删除用户 |
| POST | `/api/v1/users/:id/reset-password` | 重置密码 |
| GET | `/api/v1/tenants` | 租户列表（**仅平台管理员**） |
| POST | `/api/v1/tenants` | 新建租户（仅平台管理员） |
| PUT | `/api/v1/tenants/:id` | 改名 / 改 slug / 停用（仅平台管理员） |
| DELETE | `/api/v1/tenants/:id` | 删除租户及其全部内容（仅平台管理员） |
| GET | `/api/v1/platform/stats` | 平台统计：租户 / 账号 / 资产 / 存储（仅平台管理员） |
| GET | `/api/v1/platform/accounts` | 跨租户账号目录（`keyword` / `role` / `status`，仅平台管理员） |
| PUT | `/api/v1/platform/accounts/:id` | 改角色 / 改归属租户 / 启停（仅平台管理员；会结束该账号会话） |
| GET | `/api/v1/platform/audit` | 平台层动作审计流水（仅平台管理员） |
| GET | `/api/v1/platform/requests` | 请求日志（`tenant_id` / `keyword` / `method` / `status_class` / `hours`，仅平台管理员） |
| GET | `/api/v1/platform/traffic` | 流量汇总：窗口总量、按小时的曲线、最重的接口（仅平台管理员） |
| GET | `/api/v1/platform/settings` | 平台设置：访问域名 + 跨域白名单（仅平台管理员） |
| PUT | `/api/v1/platform/settings` | 修改平台设置（仅平台管理员；只改请求里带的字段，保存即生效） |
| GET | `/api/v1/settings` | 实例的访问域名（任何登录账号可读） |
| GET | `/api/v1/mcp/tokens` | MCP 令牌列表（自己的；管理员看本租户全部） |
| POST | `/api/v1/mcp/tokens` | 签发 MCP 令牌（明文只返回一次） |
| DELETE | `/api/v1/mcp/tokens/:id` | 吊销 MCP 令牌 |
| GET | `/api/v1/assets` | 资产列表（筛选、搜索、分页） |
| POST | `/api/v1/assets/upload` | 上传（multipart，字段名 `files`，最多 20 个） |
| POST | `/api/v1/assets/import-url` | 从外部 URL 导入（拒绝内网地址） |
| POST | `/api/v1/assets/from-comfyui/:job_id` | 登记 ComfyUI 任务产物 |
| GET | `/api/v1/assets/:id` | 资产详情 |
| GET | `/api/v1/assets/:id/manifest` | 资产清单（原始尺寸、时长、来源） |
| PUT | `/api/v1/assets/:id` | 更新资产（标题、分类、标签等） |
| DELETE | `/api/v1/assets/:id` | 删除（`?permanent=true` 为永久删除） |
| POST | `/api/v1/assets/:id/restore` | 从回收站复原 |
| POST | `/api/v1/assets/:id/download` | 下载原文件 |
| GET | `/api/v1/assets/:id/workflow` | 下载资产的 ComfyUI 工作流（JSON 文件） |
| POST | `/api/v1/upload/init` | 初始化分片上传 |
| PUT | `/api/v1/upload/chunk/:session_id` | 上传分片（字段名 `chunk`，query `chunk_index`） |
| POST | `/api/v1/upload/complete` | 合并分片并生成资产 |
| GET | `/api/v1/categories` | 分类列表 |
| POST | `/api/v1/categories` | 新建分类 |
| PUT | `/api/v1/categories/:id` | 更新分类 |
| DELETE | `/api/v1/categories/:id` | 删除分类 |
| GET | `/api/v1/tags` | 标签列表 |
| POST | `/api/v1/tags` | 新建标签 |
| PUT | `/api/v1/tags/:id` | 更新标签 |
| DELETE | `/api/v1/tags/:id` | 删除标签 |
| GET | `/api/v1/api-keys` | API Key 列表（掩码显示） |
| POST | `/api/v1/api-keys` | 创建 API Key（明文只返回一次） |
| PUT | `/api/v1/api-keys/:id` | 更新 API Key |
| DELETE | `/api/v1/api-keys/:id` | 停用 API Key |
| GET | `/api/v1/webhooks` | Webhook 列表 |
| POST | `/api/v1/webhooks` | 创建 Webhook |
| PUT | `/api/v1/webhooks/:id` | 更新 Webhook |
| DELETE | `/api/v1/webhooks/:id` | 停用 Webhook |
| GET | `/api/v1/stats` | 统计汇总 |
| GET | `/api/v1/stats/dashboard` | 仪表盘统计 |
| GET | `/api/v1/jobs/by-comfyui/:job_id` | 按 ComfyUI 任务号查资产 |
| GET | `/api/v1/comfy-nodes` | 接入本租户的 ComfyUI 节点 |

> **平台管理员（`role=superadmin`）用 `X-Tenant` 指定这次请求服务的租户。**
>
> 平台管理员的凭证本身不属于任何租户，所以它的默认范围是**整个平台**：不带这个头时，所有读取覆盖全部租户。带上这个头，读和写**同时**收窄到这个租户——列表只看得到它的行，更新和删除也只作用在它的行上。一个头一个意思。
>
> 头的值是一个**引用**：租户的 id、slug 或名称都行（`X-Tenant: acme`、`X-Tenant: acme-slug`、`X-Tenant: Acme Corp`），后端按 id → slug → 名称的顺序解析。
>
> ⚠️ HTTP 头只能是字节串，所以**非 ASCII 的租户名放不进这个头**（请求在到达服务端之前就被拒了）。前端发的永远是租户 **id**；只有 ASCII 的 slug / 名称才能直接用在头上。
>
> - 不带这个头就写入 → `400 TENANT_REQUIRED`（写入必须落到一个具体租户；落在通配租户上的行谁都读不到）
> - 头指向的租户不存在 → `400 NO_SUCH_TENANT`
> - 头指向的租户已停用 → `403 TENANT_SUSPENDED`
>
> 普通租户的凭证会**忽略**这个头——它不能用来越权。
>
> `GET /api/v1/tenants` 只有平台管理员能读，它列出全部租户（id / 名称 / slug / 资产数 / 账号数），前端的头部租户选择器就是从它取数据的。这个接口**不**受 `X-Tenant` 影响：它正是用来*选*租户的。

### MCP（每个账户的 AI 接入）

每个账户都能在「账号菜单 → MCP 接入」签发自己的 MCP 令牌。它是 AI 客户端（Claude Desktop、Claude Code、Cursor 等）访问这个实例的凭证：

```bash
curl -X POST http://localhost:8000/mcp \
  -H "Authorization: Bearer dam_mcp_xxxxxxxx" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

令牌代表签发它的账户：它继承账户的租户与角色，**能做的事不会超过账户能做的事**。

| 角色 | 令牌能拿到的工具 |
| --- | --- |
| `viewer` | 读：`list_assets`、`get_asset`、`list_categories`、`list_tags`、`get_library_stats` |
| `editor` | 读 + 写：再加 `upload_asset`、`update_asset` |
| `admin` / `superadmin` | 读 + 写 + 删：再加 `delete_asset` |

平台管理员的令牌默认覆盖所有租户，用 `X-Tenant` 收窄到某一个——和它在界面里做的事是同一条规则。

明文令牌只在签发时出现一次，之后库里只剩哈希；丢了就重建一个，旧的吊销掉。

> 两个 `/mcp` 不是一个东西：协议端点在 **`/mcp`**（AI 客户端配置里的那个 URL），签发令牌的界面在 **`/mcp-access`**。服务端把 `/mcp` 整段交给了 MCP 传输层，页面不能待在那个路径上——刷新就会变成 405。契约护栏（`tests/lib/spa-routes.js`）会拦住这种撞车。

### 公开投递 API（API Key 鉴权）

> Header：`X-API-Key: dam_xxxxxxxx`。Scope 分为 `read` / `upload` / `delete`。

| Method | Path | 所需 Scope | 描述 |
|--------|------|-------------|------|
| GET | `/api/public/v1/delivery/assets` | `read` | 列出资产 |
| POST | `/api/public/v1/delivery/upload` | `upload` | 上传文件（multipart，字段名 `files`，最多 20 个） |

### 外部接入 API（ComfyUI 节点用）

> Header：`X-API-Key: dam_xxxxxxxx`。**Key 决定租户**——资产落在 Key 属于哪个租户就落在哪里，请求里没有、也不该有租户参数。

| Method | Path | 所需 Scope | 描述 |
|--------|------|-------------|------|
| POST | `/api/ingest/v1/nodes/register` | `upload` | 一台 ComfyUI 登记自己；幂等，重复登记刷新同一行 |
| POST | `/api/ingest/v1/comfyui/:job_id` | `upload` | 推送产物（multipart，字段名 `files`） |
| POST | `/api/ingest/v1/assets/:id/metadata` | `write` | 改资产元数据 |
| POST | `/api/ingest/v1/events` | `write` | 报一个事件（会转投 Webhook） |

`POST /api/ingest/v1/comfyui/:job_id` 还可以带一个 `workflow_json` 字段——那是产生这张图的工作流，原样存进资产，之后在资产详情页可以**下载 JSON**。

`POST /api/ingest/v1/nodes/register` 的响应里带 `platform_url`：平台自己的访问地址（控制台「设置」里填的那个）。节点拿它覆盖自己手里的地址，就不用在节点里填正式网址了。

仓库里带着一套现成的 ComfyUI 节点包，在 [`comfyui-node/`](comfyui-node/)：两个节点——**DAM 接入**（问清楚平台在哪儿并登记自己）和 **DAM 推送**（把图片和工作流一起推过去），输出接输入即可。

安装、配置（环境变量 / 配置文件 / 节点输入框）、租户归属、工作流示例、节点记住的三样东西、以及它实际发出的那几个请求，都写在 [`comfyui-node/README.md`](comfyui-node/README.md) 里。节点只用 Python 标准库，不碰 ComfyUI 的环境。

### 调用示例（curl）

```bash
# 1. 上传文件
curl -X POST http://localhost:8000/api/public/v1/delivery/upload \
  -H "X-API-Key: dam_xxxxxxxxxxxxxxxxxxxxxxxxxxxx" \
  -F "files=@/path/to/image.png" \
  -F "title=My Image"

# 2. 列出本 Key 资产
curl http://localhost:8000/api/public/v1/delivery/assets \
  -H "X-API-Key: dam_xxxxxxxxxxxxxxxxxxxxxxxxxxxx"
```

### Node.js 调用示例

```js
import { readFile } from 'node:fs/promises';

const API_BASE = 'http://localhost:8000/api/public/v1/delivery';
const API_KEY = 'dam_xxxxxxxxxxxxxxxxxxxxxxxxxxxx';

const headers = { 'X-API-Key': API_KEY };

// 上传
const form = new FormData();
form.append('files', new Blob([await readFile('image.png')]), 'image.png');
form.append('title', 'My Image');

const upload = await fetch(`${API_BASE}/upload`, { method: 'POST', headers, body: form });
const { items } = await upload.json();
console.log(items[0].id, items[0].title);

// 列出
const list = await fetch(`${API_BASE}/assets`, { headers });
const page = await list.json();
for (const asset of page.items) {
  console.log(asset.id, asset.title);
}
```

## 📁 目录结构

```
DigitalManagement/
├── src/
│   ├── server/               # Node.js 后端
│   │   ├── server.js         # 组装根：命名空间、静态托管、错误处理
│   │   ├── config.js         # 运行配置（全部来自环境变量）
│   │   ├── lib/              # 共享逻辑
│   │   │   ├── dto.js        # DTO —— 前后端唯一契约源
│   │   │   ├── schema.js     # 建表与种子数据
│   │   │   ├── auth.js       # 令牌签发、轮换、吊销
│   │   │   ├── assets.js     # 资产读写与筛选
│   │   │   ├── upload.js     # multer 与分片
│   │   │   ├── net.js        # SSRF 防护
│   │   │   ├── manifest.js   # 资产清单
│   │   │   ├── webhook.js    # Webhook 投递
│   │   │   └── util.js
│   │   ├── routes/           # 每个域一个路由工厂
│   │   │   ├── auth.js  users.js  assets.js  upload.js
│   │   │   ├── categories.js  tags.js  apikeys.js
│   │   │   ├── webhooks.js  stats.js  jobs.js  public.js
│   │   └── scripts/seed.js   # 种子 / 修复脚本
│   └── client/               # React 前端
│       ├── api/              # 每个域一个 API 模块
│       ├── components/       # 业务组件
│       ├── pages/            # 页面
│       ├── stores/           # Zustand 状态
│       ├── styles/  theme/   # 主题与全局样式
│       ├── types/            # DTO 类型
│       ├── utils/            # 工具
│       ├── main.tsx
│       └── router.tsx
├── tests/
│   ├── contract.test.js      # 前后端契约护栏入口
│   ├── lib/                  # 护栏实现（静态扫描 + 运行时）
│   └── backend/              # 后端 suite + 统一 runner
├── storage/                  # 上传文件（不入库）
├── public/                   # 静态资源
├── docs/
│   ├── ARCHITECTURE.md       # 架构设计
│   └── DEPLOY-NGINX.md       # 用 Nginx / Caddy 部署（反向代理）
├── comfyui-node/             # ComfyUI 自定义节点（见其 README）
├── index.html                # 前端入口
├── vite.config.ts            # 前端构建
├── tsconfig.json             # 前端类型
├── Dockerfile                # 多阶段构建：前端构建 + 后端运行
├── docker-compose.yml        # 单容器部署
├── scripts/
│   ├── build-release.mjs     # 打包器：把可发布内容整理到 up/
│   ├── create-database.sql   # 建库与建账号
│   └── release/              # 发布包里的运维文件与验证脚本
├── start.bat / start.sh      # 一键启动脚本
└── package.json              # 前后端共用的唯一依赖清单
```

> 前后端在**同一个 `package.json`** 里，共用一份 `node_modules`：服务端依赖与前端依赖装在一起，没有第二个清单要维护。

> `up/` 是发布包的输出目录，**不入版本库**。用 `npm run release` 重新生成。

## ⚙️ 关键配置（.env）

`.env` 是可选的 —— 所有值都有默认值（见 `src/server/config.js`）。相对路径一律相对**仓库根目录**解析，与启动位置无关。

```env
PORT=8000                        # 唯一端口：API + 界面
HOST=0.0.0.0
DB_HOST=127.0.0.1               # MySQL 地址
DB_PORT=3306
DB_USER=root
DB_PASSWORD=
DB_NAME=digital_management      # 不存在会自动创建
DB_POOL_SIZE=10                 # 连接池大小
STORAGE_DIR=./storage            # 上传文件目录
JWT_SECRET=                       # 走向导部署时留空（向导自动生成）；手动部署填 32+ 字符随机串
ACCESS_TOKEN_TTL=1h
REFRESH_TOKEN_TTL=30d
UPLOAD_MAX_FILE_SIZE_MB=2048     # 单个文件的上限（MB）
UPLOAD_MAX_REQUEST_SIZE_MB=2048  # 单次请求的上传总量上限（MB）；默认与单文件上限相同
SEED_SAMPLE_ASSETS=0             # 设为 1 才生成 12 张示例资产
REQUEST_LOG_ENABLED=1             # 设为 0 关闭请求日志（每次 API 调用一行）
REQUEST_LOG_RETENTION_DAYS=30     # 请求日志保留多少天；过期的行每小时清一次
STORAGE_URL_TTL_SECONDS=3600     # 签名文件链接的有效期（前端 <img src> 用）
INIT_TOKEN=                      # 向导令牌；留空则每次启动生成并打印到控制台
WEBHOOK_ALLOW_PRIVATE_TARGETS=0   # 设为 1 才允许 Webhook 投递到内网地址（默认拒绝）
TRUST_PROXY=off                   # 挂在反向代理后面时设为 loopback，让审计日志记下真实 IP
```

> **访问域名与跨域白名单不在 `.env` 里。** 它们以前是 `APP_BASE_URL` / `CORS_ORIGINS` 两个环境变量，改一次要重启一次；现在是平台控制台的「设置」页签里的两个字段，**保存即生效**。访问域名是这个实例对外的地址（服务端生成的绝对链接、界面上的「API 基础地址」、MCP 客户端要填的地址都从它来）；跨域白名单是允许从别的来源用浏览器调用这个实例的页面，访问域名本身永远在允许之列。

> **Webhook 目标默认不许指向内网。** Webhook 的目标 URL 是服务器自己发起的对外请求，默认拒绝 `10.x`、`172.16-31.x`、`192.168.x`、`127.0.0.1`、`169.254.x`（云元数据）等地址；检查在每次投递时执行，并把连接固定到已校验的 IP，防止 DNS 重绑定。接收方确实在你自己网络里时，把 `WEBHOOK_ALLOW_PRIVATE_TARGETS` 设为 `1`。

数据库连不上时，服务会在启动阶段直接报错退出（不会带着一个半成品 schema 跑起来）。表、列与索引在启动时自动补齐 —— **幂等迁移**，重复启动不会重复建。

> **JWT_SECRET 必须是自己的。** 仓库自带的占位串是公开的，用它签发的令牌任何人都能伪造。启动时若检测到仍在用占位串，控制台会明确警告。

## 🧪 测试

```bash
npm test              # 契约护栏 + 后端 9 个 suite
npm run test:contract # 静态核对 + 运行时集成 + 静态托管（78 项）
npm run test:backend  # 后端 suite
```

契约护栏会把后端 64 条路由与前端 81 个调用点逐一核对，任何一个对不上都直接失败；运行期在临时数据库上启动真实后端，用前端自己的 API 模块跑一遍完整流程——包括租户门与平台门这两扇门，以及平台层自己的统计、账号目录与审计。静态托管那一组问的是**运行中的实例**：外壳有没有被缓存、消失的 chunk 是不是诚实地答 404。
护栏需要 **Node.js ≥ 22.15**。

## 🔒 安全建议

1. **修改默认密码**：首次登录后立即修改
2. **修改 JWT_SECRET**：生产环境必须使用 32+ 字符随机字符串
3. **按系统申请 API Key**：在「集成」页为每个外部系统单独申请，用完即撤；向导不再发放默认 Key
4. **启用 HTTPS**：通过 Nginx/Caddy 反向代理，配置见 [`docs/DEPLOY-NGINX.md`](docs/DEPLOY-NGINX.md)；代理后面记得设 `TRUST_PROXY=loopback`，否则审计日志里的 IP 全是 `127.0.0.1`
5. **定期备份**：MySQL 数据库 + `storage/`
6. **限制存储目录**：通过文件系统权限限制 `storage/` 仅服务进程可写
7. **URL 导入已内置 SSRF 防护**：内网与回环地址会被拒绝
8. **上传会占内存**：文件在读取时整块缓存在进程内存里，单次请求的上传总量默认与单文件上限相同；机器内存吃紧就调小 `UPLOAD_MAX_FILE_SIZE_MB` / `UPLOAD_MAX_REQUEST_SIZE_MB`，超大文件走分片上传接口（分片全程落盘，不吃内存）

## 🗺️ Roadmap

- [ ] 视频转码（H.264/H.265，FFmpeg）
- [ ] HLS 自适应码流
- [ ] 全文检索（Meilisearch / Elasticsearch）
- [ ] 对象存储后端（S3 / MinIO / 阿里 OSS）
- [ ] 图片 AI 标注（自动打标签）
- [ ] 公开访问短链（带签名 + 过期）
- [x] 多租户支持（租户管理、租户级权限、MCP 接入）

## 📄 License

MIT
