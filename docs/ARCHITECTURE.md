# 数字资产管理系统 - 架构设计

## 系统定位

**Digital Asset Management (DAM)** — 通用型数字资产管理系统，用于集中存储、管理、分发图片与视频等数字资产，通过 RESTful API + API Key 向其他系统提供可控的资产投递能力。

## 核心能力

| 维度 | 能力 |
|---|---|
| 资产类型 | 图片（JPG/PNG/WebP/GIF/SVG/BMP）、视频（MP4/MOV/WebM/MKV） |
| 上传方式 | 单文件、批量、分片（大文件）、外部 URL 导入 |
| 元数据 | 自动提取 EXIF（图片）/ 视频元数据、手动标签/分类/描述 |
| 检索 | 关键字全文检索、标签筛选、分类筛选、类型筛选、上传者筛选、时间范围 |
| 投递 | API Key 调用 → 资产入库 → Webhook 通知 → 公开访问链接（带签名） |
| 权限 | 角色（admin/editor/viewer）+ API Key 范围（read/write/delete） |
| 审计 | 所有写操作落审计日志、API 调用落访问日志 |
| 媒体处理 | 缩略图、WebP 预览、视频封面、HLS 自适应码流（可选） |

## 技术架构

```
┌─────────────────────────────────────────────────────────────┐
│                  Frontend (React 18 + AntD 5)                │
│  仪表盘 · 资产库 · 上传 · 详情 · 分类 · 标签 · API Key · 用户 │
└───────────────────────────┬─────────────────────────────────┘
                            │ HTTPS / JSON
┌───────────────────────────▼─────────────────────────────────┐
│                  Backend (FastAPI + Python 3.13)             │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────────┐    │
│  │   Auth   │ │  Assets  │ │  Upload  │ │   Webhook    │    │
│  │ JWT+APIK │ │  CRUD    │ │  分片    │ │   投递通知   │    │
│  └──────────┘ └──────────┘ └──────────┘ └──────────────┘    │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────────┐    │
│  │  Media   │ │  Search  │ │  Audit   │ │   Public     │    │
│  │ 缩略图   │ │ 全文检索 │ │  日志    │ │   投递API    │    │
│  └──────────┘ └──────────┘ └──────────┘ └──────────────┘    │
└───────────┬─────────────────────────┬────────────────────────┘
            │                         │
   ┌────────▼─────────┐     ┌─────────▼──────────┐
   │     MySQL 8       │     │  本地文件系统       │
   │  资产元数据/索引  │     │ /storage/originals │
   │  用户/权限/审计   │     │ /storage/thumbs    │
   └──────────────────┘     │ /storage/previews  │
                            └────────────────────┘
```

## 数据模型（ER 概要）

```
users ─┬─< api_keys
       ├─< assets ──< asset_tags >── tags
       │      │
       │      └─< asset_versions
       │
       └─< audit_logs

categories（自引用树形）
upload_sessions（分片上传会话）
webhook_endpoints ─< webhook_logs
```

## API 设计原则

- **版本化**：`/api/v1/*`（内部管理） + `/api/public/v1/*`（外部投递）
- **鉴权双轨**：管理 API 用 JWT，外部投递用 API Key
- **响应统一**：`{ code, message, data, request_id }`
- **分页标准**：`page` / `page_size` / 总数 / 列表
- **错误规范**：HTTP 状态码 + 业务错误码

## 目录结构

```
DigitalManagement/
├── backend/                # FastAPI 后端
├── frontend/               # React 前端
├── storage/                # 本地文件存储
├── docs/                   # 设计文档
├── docker-compose.yml      # 一键启动
├── start.bat / start.sh    # 启动脚本
└── README.md
```

## 部署拓扑（统一端口）

**前后端共用同一端口**（默认 `8000`），由 FastAPI 通过 `StaticFiles` 托管前端构建产物：

```
http://localhost:8000/                       → 前端 SPA（index.html）
http://localhost:8000/assets/*               → 前端静态资源（JS/CSS）
http://localhost:8000/api/v1/*               → 管理后台 API（JWT）
http://localhost:8000/api/public/v1/*        → 外部投递 API（API Key）
http://localhost:8000/storage/originals/*    → 原图/视频直链（带签名）
http://localhost:8000/docs                   → Swagger UI（开发期）
```

优势：
- 无 CORS 跨域问题（前端与 API 同源）
- 部署极简：单进程 + MySQL
- 反向代理友好（一个 upstream）
- 静态资源可挂 CDN：把 `/assets/` 指到 CDN 即可

## 安全设计

- 密码 bcrypt 哈希
- JWT Access Token (15min) + Refresh Token (7d)
- API Key 仅生成时返回一次（哈希入库）
- 文件上传类型白名单 + 扩展名校验 + MIME 嗅探
- 公开访问链接带 HMAC 签名 + 过期时间
- CORS 白名单
- 操作审计（IP / UA / 时间 / 操作类型）
