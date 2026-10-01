# DAM 统一站点改造 — 设计 Spec

日期：2026-10-01
分类：架构级（Architectural）

## 1. 目标与成功标准

**目标**：把当前散落的双前端（demo.html 独立 HTML + 半成品 React SPA）、零碎后端，改造为一个**单一站点的资产管理系统**。资产可被外部插件（特别是未来的 ComfyUI 插件）通过 API + 本地镜像两种方式发现、读取、登记。

**成功标准**：
1. 用户打开 `http://localhost:8000`，进入的是一个完整的 React SPA，包含：资产库、上传、分类、标签、API Key、ComfyUI 任务、统计仪表盘。
2. 外部插件（如 ComfyUI 适配器）既能通过 HTTP API 拉取资产列表，也能直接读取 `storage/manifests/index.json` 这个本地 JSON 索引。
3. 任何资产新增/更新/删除，都在 5 秒内同步到 manifest 镜像，并通过可选 Webhook 推送。
4. 删除 demo.html（避免双前端混淆）。
5. 后端继续是单文件 Express + better-sqlite3（**不引入 MySQL 依赖**，零配置），不破坏现有 API 契约。

## 2. 受众与场景

- **主要受众**：AI 创作者 / 设计师 / 团队管理员，把 ComfyUI 等工具的产出集中管理。
- **场景 A**：用户在 DAM 上传 ComfyUI 生成的图片，附带 prompt 与 seed 元数据，方便日后检索与衍生。
- **场景 B**：ComfyUI 插件独立运行，把生成的图直接调用 `/api/v1/assets/upload`（带 API Key）入 DAM，并在 DAM 中打上 `comfyui-job-xxx` 标签以便反查。
- **场景 C**：运营团队从 DAM 直接复制公开链接，发到 Slack / Notion；外部用户无需登录即可预览（带签名 URL）。

## 3. 架构概览

```
┌─────────────────────────────────────────────────────────┐
│   Frontend SPA (React 18 + TS + Vite 6 + AntD 5)        │
│   单一入口 · 按"创作工作流"组织页面 · 暗色主题 + 暖色强调 │
└──────────────────────────┬──────────────────────────────┘
                           │ /api/v1/* + /api/public/v1/*
┌──────────────────────────▼──────────────────────────────┐
│   Backend (Express + better-sqlite3，单文件)             │
│  - 资产管理 CRUD + 元数据扩展（prompt/seed/model/job_id）│
│  - 资产→manifest 镜像 → storage/manifests/index.json     │
│  - 可选 Webhook（HMAC 签名）                            │
│  - 公开投递 API（API Key）                               │
└─────┬────────────────────────┬───────────────────────┬───┘
      │ SQLite (dam.db)       │ storage/              │ Spring (JSON)
      │ 资产元数据 / 用户      │ originals/            │ manifests/
      │                       │ thumbnails/           │  index.json
      │                       │                       │ (插件可读)
```

## 4. 数据模型扩展

在现有 `assets` 表上扩展（**不破坏向后兼容**，仅 ADD COLUMN）：

| 新列 | 类型 | 含义 |
|------|------|------|
| `source_tool` | TEXT | 生成工具，如 `comfyui`、`midjourney`、`manual`、`import-url` |
| `prompt` | TEXT | 生成 prompt（ComfyUI/SD/MJ 等） |
| `seed` | INTEGER | 种子值 |
| `model_name` | TEXT | 模型名（如 SDXL、Flux） |
| `job_id` | TEXT | 外部任务 ID（关联 ComfyUI 等插件） |
| `metadata_json` | TEXT | 自由扩展字段（JSON 字符串） |

新增 `webhook_endpoints` 与 `webhook_logs` 两张表：

```
webhook_endpoints (id, name, url, secret, is_active, created_at)
webhook_logs (id, endpoint_id, event, payload, status, attempts, last_error, created_at)
```

新增 `manifest_writes` 一张极简审计表（每次写 manifest 留痕，可选）。

## 5. 模块拆分

### 5.1 后端（保持单文件 server.js，但内部按路由分组）

| 模块 | 职责 |
|------|------|
| `bootstrap` | DB schema、目录创建、种子数据（admin/samples/db 种子） |
| `auth` | JWT 登录 + me |
| `asset`, `category`, `tag`, `apiKey` | 现有 CRUD（保持兼容） |
| `manifest` | 每次资产变更增量更新 `storage/manifests/index.json` |
| `webhook` | 资产事件入队 + 异步发送 + HMAC 签名 |
| `stats`, `public` | 现有统计与公开投递 API |

新增路由：
- `GET  /api/v1/assets/:id/manifest` — 单资产完整 manifest JSON
- `GET  /storage/manifests/index.json` — 静态服务本地索引（**插件可直读**）
- `POST /api/v1/webhooks` — 注册 Webhook
- `GET/DELETE /api/v1/webhooks[/:id]` — 列表/停用

### 5.2 前端（React SPA）

按用户操作工作流重新组织，**不再按"CRUD 实体"罗列**：

| 路由 | 页面 | 角色 |
|------|------|------|
| `/login` | 登录 | 公共 |
| `/` (Dashboard) | **创作总览**：今日产出、最近任务、热门标签、空间占用 | 全员 |
| `/library` | **资产库**（替代原 `/assets`）：网格/列表/筛选/批量 | 全员 |
| `/library/:id` | 资产详情：预览 + 元数据 + prompt/seed + 版本 | 全员 |
| `/import` | **导入**：拖拽上传 / URL 抓取 / ComfyUI 任务 ID 导入 | 全员 |
| `/jobs` | **ComfyUI 任务**：列出本系统已登记的生成任务 | 全员 |
| `/organize` | 分类 + 标签管理（合并原 `/categories` `/tags`） | 管理员 |
| `/integrations` | API Key + Webhook + 插件契约 | 管理员 |
| `/settings` | 用户、主题、存储统计 | 管理员 |
| `/admin/users` | 用户管理 | 仅 admin |

### 5.3 共享类型契约（前后端共享 DTO）

`frontend/src/types/dto.ts`（新增）— 用 TS interface 描述 Asset/Category/Tag/ApiKey/Webhook/Job，**单一来源**，前后端都引用。

## 6. 插件契约（**最重要的对外能力**）

### 6.1 HTTP API（推荐路径）

插件（如 ComfyUI）调用：
- `POST /api/v1/assets/upload` 携带 `X-API-Key`，multipart `file` + 表单字段 `prompt`, `seed`, `model_name`, `job_id`, `source_tool=comfyui`, `tag_names`
- `GET /api/v1/assets?source_tool=comfyui&job_id=xxx` 反查
- `GET /api/v1/assets/:id/manifest` 单资产完整元数据

### 6.2 本地 JSON 镜像（离线/直读路径）

`storage/manifests/index.json`：

```json
{
  "version": 1,
  "updated_at": "2026-10-01T12:00:00Z",
  "count": 247,
  "assets": [
    {
      "id": "abc123",
      "title": "...",
      "source_tool": "comfyui",
      "job_id": "comfyui-987",
      "prompt": "...",
      "seed": 42,
      "model_name": "flux-dev",
      "original_path": "originals/abc123.png",
      "thumbnail_path": "thumbnails/abc123.webp",
      "public_url": "http://host/storage/originals/abc123.png",
      "created_at": "2026-10-01T11:55:00Z",
      "tags": ["ai-generated", "flux"],
      "category": "AI 生成"
    }
  ]
}
```

**写入策略**：每次资产 upsert/delete 后，异步（`setImmediate`）重写 `index.json`。失败时记录到 `manifest_writes` 表，下次重启时回放。

### 6.3 Webhook（实时推送）

事件：`asset.created` / `asset.updated` / `asset.deleted`。POST JSON 到端点，header `X-DAM-Signature: sha256=<HMAC(body, secret)>`。

## 7. 前端设计（按 frontend-design 技能打磨）

### 7.1 视觉方向

- **主题**：暗色优先（创作者工具的常规偏好），但 **避免** 简单的"深蓝底 + 单色蓝强调"的 SaaS 默认。
- **品牌色**：
  - 背景：墨黑 `#0d1117`（带极轻暖偏 `#10131a`）
  - 面板：`#161b22`
  - 边框：`#30363d`
  - 主色（按钮/链接）：**琥珀暖橙** `#f5a524`（替代 AntD 默认 `#1677ff` 蓝）
  - 辅色：**青绿** `#3fb950`（成功/已生成）、**紫红** `#f78166`（ComfyUI 任务）
  - 文字：`#f0f6fc`（主）、`#8b949e`（辅）
- **字体**：
  - 标题：`Inter Display` 或本地 `Inter` 700-800 weight，**tight letter-spacing**
  - 正文：`Inter` 400/500
  - **元数据/数字**（prompt seed 等）：`JetBrains Mono`（带给人"工程感"）
- **打破 SaaS 卡片套**：
  - **不使用**统一圆角的卡片堆叠；列表用紧凑行，详情用宽面板
  - **不使用**渐变光晕做装饰；强调色仅出现在操作按钮、状态徽标
  - **不使用** ALL-CAPS eyebrow label
  - 标题左侧加 **粗细分隔条**（2px solid amber），强化信息层级而非装饰
- **资产预览**：
  - 大网格视图：图片充满单元格，无 padding；鼠标悬停显示底部操作条
  - 列表视图：左侧缩略图 + 中部元数据 + 右侧快捷操作，密度高、可扫读
- **ComfyUI 任务卡片**：使用**紫红色块** + monospace `job_id`，区别于普通资产

### 7.2 信息层级与版式

- **左导航**：240px 宽，分组"创作 / 管理 / 设置"，每组 ≤5 项；当前页用 amber 1px 左 border + amber text
- **顶部**：单行高度 56px，logo + 面包屑 + 全局搜索 + 用户头像
- **页面主体**：最大宽度 1440px，居中；行宽不超过 80 字符（中文约 32 字）
- **响应式**：≥1280 三栏，768-1280 双栏，<768 折叠为汉堡

### 7.3 文案

- 用动词而非名词："上传资产"而不是"提交"
- 资产有 copy/状态 + 续接的微动作："已生成 247 个资产，查看最近 10 个 →"
- 错误用系统口吻而非人称："上传失败：文件超过 2GB"，不是"哎呀，上传出了问题"

### 7.4 动效

- 单一入场动画：页面切换时内容淡入 + 4px 上移（150ms），不堆叠 hover 微动效
- 资产预览切换用 crossfade（200ms），无 slide
- 尊重 `prefers-reduced-motion`

## 8. 错误处理与边界

- 上传失败：返回结构化错误 `{ code, message, request_id }`，前端用 notification 显示
- manifest 写失败：异步重试 3 次（指数退避），最终失败记录到 `manifest_writes` 表 + 后端日志
- Webhook 推送失败：同样重试 3 次，记录到 `webhook_logs.status`
- 资产删除：软删除 `status='deleted'`，7 天后由 `deleteStorage()` 后台清理（启动时跑一次）

## 9. 测试与质量

- 后端：保留 `backend/.venv-test/` 作为 SQLite 测试 harness；为 `asset CRUD`、`manifest 镜像`、`webhook 签名` 写单元测试
- 前端：保留 `tsc --noEmit` 类型检查；关键页面（资产库、详情、上传）做交互测试
- 端到端：手动验证三个场景（人工上传、API Key 上传、manifest 直读）

## 10. 不做的事（YAGNI）

- 不引入 MySQL/Postgres（保持 SQLite 零依赖）
- 不做视频转码、HLS、AI 标注（Roadmap 已列，不在本次范围）
- 不做多租户
- 不做 Vue 版本
- 不破坏现有 API 契约（向后兼容）

## 11. 实施分期

1. **阶段 A — 后端扩展**（单文件 server.js）：
   - Schema 扩展 + 资产元数据字段
   - manifest 镜像写入
   - Webhook 基础能力
2. **阶段 B — 前端整合**：
   - 删除 demo.html
   - 补齐 React SPA 所有页面（按 §5.2 路由）
   - 接入 §7 的视觉系统
3. **阶段 C — 端到端验证**：
   - 起服务，跑三个场景
   - 手动从插件角度读 manifest

---

## Spec 自审（自检）

- 占位符：✅ 无 TBD/TODO
- 内部一致性：✅ 前端路由与后端 API 对应
- 范围：✅ 单个实施计划可承载
- 歧义：✅ 关键术语（manifest、Webhook、插件）已在 §6 明确定义