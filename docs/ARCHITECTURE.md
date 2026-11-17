# 数字资产管理系统 - 架构设计

## 系统定位

**Digital Asset Management (DAM)** — 通用型数字资产管理系统，用于集中存储、管理、分发图片与视频等数字资产，通过 RESTful API + API Key 向其他系统提供可控的资产投递能力。

整个系统是一套 **Node.js 模块**：一个 Express 进程同时提供管理 API、投递 API、静态文件与前端界面，只占一个端口。

## 核心能力

| 维度 | 能力 |
|---|---|
| 资产类型 | 图片（JPG/PNG/WebP/GIF/SVG/BMP/TIFF）、视频（MP4/MOV/WebM/MKV/AVI/M4V） |
| 上传方式 | 一次多文件、分片（大文件）、外部 URL 导入 |
| 元数据 | 自动提取 EXIF（图片）/ 视频元数据、手动标签/分类/描述 |
| 检索 | 关键字匹配、标签筛选、分类筛选、类型筛选、时间范围、分页排序 |
| 投递 | API Key 调用 → 资产入库 → Webhook 通知 |
| 权限 | 角色（admin / editor / viewer）+ API Key scope（read / upload / delete） |
| 审计 | 写操作落 `audit_logs`，Webhook 投递落 `webhook_logs` |
| 媒体处理 | 缩略图、WebP 预览、视频封面 |
| 生命周期 | 软删除 → 回收站 → 永久删除，三态可逆 |

## 技术架构

```
┌─────────────────────────────────────────────────────────────┐
│                  Frontend (React 18 + AntD 5)                │
│  仪表盘 · 资产库 · 上传 · 详情 · 分类 · 标签 · API Key · 用户 │
└───────────────────────────┬─────────────────────────────────┘
                            │ 同源 / JSON
┌───────────────────────────▼─────────────────────────────────┐
│                  Backend (Node.js + Express 4)               │
│                                                             │
│  server.js —— 组装根：命名空间 · 静态托管 · 错误处理          │
│  ┌───────────────────────────────────────────────────────┐  │
│  │ routes/  每个域一个路由工厂，server.js 负责挂载        │  │
│  │ auth users assets upload categories tags apikeys      │  │
│  │ webhooks stats jobs public                            │  │
│  └───────────────────────────────────────────────────────┘  │
│  ┌───────────────────────────────────────────────────────┐  │
│  │ lib/  共享逻辑                                         │  │
│  │ dto(契约源) schema auth assets upload net manifest    │  │
│  │ webhook util config                                   │  │
│  └───────────────────────────────────────────────────────┘  │
└───────────┬─────────────────────────┬────────────────────────┘
            │                         │
   ┌────────▼─────────┐     ┌─────────▼──────────┐
   │   MySQL 8.0       │     │  本地文件系统       │
   │  用户/权限/审计    │     │  storage/          │
   │  资产元数据/索引   │     │  originals/ thumbs │
   └──────────────────┘     │  previews/ tmp      │
                            └────────────────────┘
```

### 前后端只有一个契约源

`src/server/lib/dto.js` 定义了所有对外的响应结构（`toAsset` / `toUser` / `toApiKey` / `toTag` / `toCategory` / `toWebhook` / `toPage`）。前端的 TypeScript 类型与之逐字段对应 —— 这是"一套体系"的核心：**字段名、字段类型、字段缺失与否，只定义一次**。

`tests/` 下的契约护栏把这个约定变成可执行的检查：

- **静态半程**：从 `server.js` 的 `app.use(prefix, createXxxRouter(...))` 推导挂载前缀，再扫 `src/server/routes/*.js` 的 `router.<verb>('path')` 还原出完整路由表；反向核对每个路由文件都被挂载、每个被挂载的工厂都有对应文件；再把前端的每一个 HTTP 调用点与路由表双向比对，任何对不上的调用点直接失败（无匹配路由 = 硬失败）。
- **运行时半程**：在临时数据库上启动真实后端，用前端**自己的** API 模块跑一遍完整流程（登录、令牌轮换、上传、软删/复原/永久删除、API Key 与投递 API、分片上传、URL 导入的 SSRF 防护、Webhook）。

## 数据模型

```
users ─┬─< api_keys
       ├─< assets ──< asset_tags >── tags
       │      │
       │      └─< manifest_writes
       │
       └─< audit_logs

categories
upload_sessions（分片上传会话）
webhook_endpoints ─< webhook_logs
revoked_tokens / token_registry（令牌吊销与轮换）
```

## API 设计原则

- **版本化**：`/api/v1/*`（内部管理） + `/api/public/v1/*`（外部投递）
- **鉴权双轨**：管理 API 用 JWT，外部投递用 API Key
- **响应统一**：列表用分页信封 `{ items, total, page, page_size, total_pages }`；错误用 `{ detail }`，需要分支判断的错误再带一个 `code`（如 `TENANT_REQUIRED`）
- **分页标准**：`page` / `page_size`
- **错误规范**：HTTP 状态码 + `detail` 文案

### 令牌轮换

`POST /auth/refresh` 会烧毁 presented 的 refresh token（写入 `revoked_tokens`），同时签发新的令牌对。旧 token 再次使用会得到 `401 Refresh token revoked`。注销时 access token 的 `jti` 与会话 `sid` 一并吊销。

改密码（`POST /auth/change-password`）与管理员重置密码（`POST /users/:id/reset-password`）都会吊销该账号用旧密码开出的全部会话——发起改密的那个会话除外，否则改密请求会把自己踢下线。

### 删除的三态

`DELETE /assets/:id` 默认是**软删除**（`status='deleted'` + `deleted_at`），资产进入回收站；`?permanent=true` 才是物理删除；`POST /assets/:id/restore` 复原。若资产不在回收站，restore 返回 `400 Asset is not in the trash`。

### 上传的两道上限

上传的文件在读取时整块缓存在进程内存里，所以有两道上限：**单文件**（`UPLOAD_MAX_FILE_SIZE_MB`）与**单请求总量**（`UPLOAD_MAX_REQUEST_SIZE_MB`，默认与单文件上限相同）。只设单文件上限是不够的——一个请求可以带 20 个文件，那会把单文件上限的二十倍拉进内存。

分片上传（`/upload/init` → `/upload/chunk` → `/upload/complete`）全程落盘：分片写进 `STORAGE_DIR/tmp/<session_id>/`，合并也在磁盘上完成，因此它不受内存上限约束，是大文件的正确通道。单块不得超过会话声明的块大小；会话一小时过期，过期的会话与其暂存目录会被定期回收。

## 目录结构

```
DigitalManagement/
├── src/
│   ├── server/             # Node.js 后端
│   │   ├── server.js  config.js
│   │   ├── lib/            # 共享逻辑
│   │   ├── routes/         # 路由工厂
│   │   └── scripts/seed.js # 种子 / 修复脚本
│   └── client/             # React 前端
│       ├── api/            # 每个域一个 API 模块
│       ├── types/          # DTO 类型
│       └── ...
├── tests/
│   ├── contract.test.js    # 前后端契约护栏入口
│   ├── lib/                # 护栏实现
│   └── backend/            # 后端 suite + 统一 runner
├── storage/                # 上传文件
├── docs/                   # 设计文档
├── Dockerfile              # 多阶段构建
├── docker-compose.yml      # 单容器部署
├── start.bat / start.sh    # 一键启动脚本
├── package.json            # 前后端共用的唯一依赖清单
└── README.md
```

前后端在同一个 `package.json` 下，共用一份 `node_modules` 与一次 `npm install`。

## 部署拓扑（统一端口）

**前后端共用同一端口**（默认 `8000`），由 Express 托管前端构建产物：

```
http://localhost:8000/                       → 前端 SPA（index.html）
http://localhost:8000/assets/*               → 前端静态资源（JS/CSS）
http://localhost:8000/api/v1/*               → 管理后台 API（JWT）
http://localhost:8000/api/public/v1/*        → 外部投递 API（API Key）
http://localhost:8000/api/health             → 健康检查
http://localhost:8000/storage/*              → 原图 / 缩略图
```

SPA 深链接（`/library/123`）由一个排除 `/api` 与 `/storage` 的兜底路由回落到 `index.html`，因此直接刷新任意页面都不会 404。

但**像文件一样的路径不回落**：`/assets/index-abc.js` 是构建出来的 chunk，不是路由；下一次构建把它删掉之后，这条路径必须诚实地答 404，而不是答一页 HTML —— 后者会让浏览器报「动态导入失败」，把一件过期页面的事说成网络故障。外壳（`index.html`）永远不缓存：它正是**点名那些 chunk 的那个文件**，缓存它等于让浏览器拿着上一个构建的名单去要文件。

优势：
- 无 CORS 跨域问题（前端与 API 同源）
- 部署极简：单进程 + 一个 MySQL 实例
- 反向代理友好（一个 upstream）
- 静态资源可挂 CDN：把 `/assets/` 指到 CDN 即可

放在 Nginx / Caddy 后面时的完整配置（缓存规则、上传体积、真实 IP、排查清单）见 [`DEPLOY-NGINX.md`](DEPLOY-NGINX.md)。

## 安全设计

- 密码 bcrypt 哈希
- JWT Access Token（1h）+ Refresh Token（30d），refresh 单次使用
- API Key 仅生成时返回一次（哈希入库），列表中掩码显示
- 文件上传类型白名单 + 扩展名校验 + MIME 嗅探
- URL 导入内置 SSRF 防护：拒绝回环与私有网段地址
- 静态文件目录不对外暴露目录列表
- 操作审计（`audit_logs`）
