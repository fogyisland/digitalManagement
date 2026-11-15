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

### 方式三：Docker Compose

```bash
docker compose up -d --build
```

单个容器跑完整系统（前端 + API + MySQL + 文件存储），应用同样只暴露 8000 端口。
数据库与文件分别落在 `mysql_data` / `dam_storage` 两个 volume 里。

### 开发模式（可选）

前端改动需要热更新时，用 Vite 的 dev server，它把 `/api` 代理到 8000：

```bash
npm run dev          # http://localhost:5173
npm run dev:server   # 后端热重启 :8000
```

> 这是**可选**的第二端口。默认的单端口模式（8000）不需要它。

## 📡 API 速览

命名空间：

| 前缀 | 鉴权 | 用途 |
|------|------|------|
| `/api/v1` | `Authorization: Bearer <JWT>` | 管理 API |
| `/api/public/v1` | `X-API-Key: dam_xxx` | 投递 API |
| `/api/health` | 无 | 健康检查 |
| `/storage/*` | 无 | 上传文件与缩略图 |

### 管理 API（JWT 鉴权）

| Method | Path | 描述 |
|--------|------|------|
| POST | `/api/v1/auth/login` | 登录，返回 access + refresh token |
| POST | `/api/v1/auth/refresh` | 轮换令牌（旧 refresh 立即作废） |
| POST | `/api/v1/auth/logout` | 注销，吊销 access token 与会话 |
| GET | `/api/v1/auth/me` | 当前用户 |
| POST | `/api/v1/auth/change-password` | 修改密码 |
| GET | `/api/v1/users` | 用户列表 |
| POST | `/api/v1/users` | 新建用户 |
| PUT | `/api/v1/users/:id` | 更新用户 |
| DELETE | `/api/v1/users/:id` | 删除用户 |
| POST | `/api/v1/users/:id/reset-password` | 重置密码 |
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

> **超级管理员（`role=superadmin`）写入时必须指明租户。** 超级管理员的凭证本身不属于任何租户，创建资源（用户 / 分类 / 标签 / API Key / Webhook / 资产）时需要带一个 `X-Tenant: <租户名>` 头，指明这次写入落到哪个租户；不带头返回 `400 TENANT_REQUIRED`，租户不存在返回 `400 NO_SUCH_TENANT`。普通租户的凭证会忽略这个头——它不能用来越权。

### 公开投递 API（API Key 鉴权）

> Header：`X-API-Key: dam_xxxxxxxx`。Scope 分为 `read` / `upload` / `delete`。

| Method | Path | 所需 Scope | 描述 |
|--------|------|-------------|------|
| GET | `/api/public/v1/delivery/assets` | `read` | 列出资产 |
| POST | `/api/public/v1/delivery/upload` | `upload` | 上传文件（multipart，字段名 `files`，最多 20 个） |

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
│   └── ARCHITECTURE.md
├── index.html                # 前端入口
├── vite.config.ts            # 前端构建
├── tsconfig.json             # 前端类型
├── Dockerfile                # 多阶段构建：前端构建 + 后端运行
├── docker-compose.yml        # 单容器部署
├── start.bat / start.sh      # 一键启动脚本
└── package.json              # 前后端共用的唯一依赖清单
```

> 前后端在**同一个 `package.json`** 里，共用一份 `node_modules`：服务端依赖与前端依赖装在一起，没有第二个清单要维护。

## ⚙️ 关键配置（.env）

`.env` 是可选的 —— 所有值都有默认值（见 `src/server/config.js`）。相对路径一律相对**仓库根目录**解析，与启动位置无关。

```env
PORT=8000                        # 唯一端口：API + 界面
HOST=0.0.0.0
CORS_ORIGINS=                    # 允许跨域访问的前端来源，逗号分隔；默认空（同源，无需跨域）
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
APP_BASE_URL=                    # 留空则按请求推导
STORAGE_URL_TTL_SECONDS=3600     # 签名文件链接的有效期（前端 <img src> 用）
INIT_TOKEN=                      # 向导令牌；留空则每次启动生成并打印到控制台
WEBHOOK_ALLOW_PRIVATE_TARGETS=0   # 设为 1 才允许 Webhook 投递到内网地址（默认拒绝）
```

> **Webhook 目标默认不许指向内网。** Webhook 的目标 URL 是服务器自己发起的对外请求，默认拒绝 `10.x`、`172.16-31.x`、`192.168.x`、`127.0.0.1`、`169.254.x`（云元数据）等地址；检查在每次投递时执行，并把连接固定到已校验的 IP，防止 DNS 重绑定。接收方确实在你自己网络里时，把 `WEBHOOK_ALLOW_PRIVATE_TARGETS` 设为 `1`。

数据库连不上时，服务会在启动阶段直接报错退出（不会带着一个半成品 schema 跑起来）。表、列与索引在启动时自动补齐 —— **幂等迁移**，重复启动不会重复建。

> **JWT_SECRET 必须是自己的。** 仓库自带的占位串是公开的，用它签发的令牌任何人都能伪造。启动时若检测到仍在用占位串，控制台会明确警告。

## 🧪 测试

```bash
npm test              # 契约护栏 + 后端 8 个 suite
npm run test:contract # 静态路由核对 + 运行时集成（33 项）
npm run test:backend  # 后端 suite
```

契约护栏会把后端 43 条路由与前端 61 个调用点逐一核对，任何一个对不上都直接失败；运行期在临时数据库上启动真实后端，用前端自己的 API 模块跑一遍完整流程。
护栏需要 **Node.js ≥ 22.15**。

## 🔒 安全建议

1. **修改默认密码**：首次登录后立即修改
2. **修改 JWT_SECRET**：生产环境必须使用 32+ 字符随机字符串
3. **按系统申请 API Key**：在「集成」页为每个外部系统单独申请，用完即撤；向导不再发放默认 Key
4. **启用 HTTPS**：通过 Nginx/Caddy 反向代理
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
- [ ] 多租户支持

## 📄 License

MIT
