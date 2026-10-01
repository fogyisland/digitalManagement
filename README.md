# 数字资产管理系统 (Digital Asset Management)

> 一站式存储、管理、分发图片与视频等数字资产，通过 RESTful API + API Key 向其他系统提供可控的资产投递能力。

## ✨ 核心特性

| 模块 | 能力 |
|------|------|
| 📦 **资产管理** | 图片（JPG/PNG/WebP/GIF/SVG/BMP/TIFF）+ 视频（MP4/MOV/WebM/MKV/AVI/M4V） |
| 🔐 **双轨认证** | 管理后台 JWT，外部投递 API Key |
| 📤 **上传方式** | 单文件、批量、分片（大文件）、外部 URL 导入 |
| 🏷️ **分类标签** | 多级树形分类、灵活标签系统 |
| 🖼️ **媒体处理** | 自动缩略图、WebP 预览、视频封面、EXIF 提取 |
| 🔑 **API Key** | 细粒度权限（读/写/删）、过期控制、调用审计 |
| 🔔 **Webhook** | 资产变更实时通知，HMAC 签名校验 |
| 📊 **审计日志** | 所有敏感操作全程留痕 |
| 🌓 **统一端口** | 单端口同时托管 UI + API + 静态资源 |

## 🛠 技术栈

**后端**：Python 3.13 · FastAPI · SQLAlchemy 2 · Alembic · PyMySQL · Pillow · imageio-ffmpeg

**前端**：React 18 · TypeScript · Vite 6 · Ant Design 5 · Zustand · React Router 6

**数据库**：MySQL 8.0

**存储**：本地文件系统（`./storage`）

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
1. 检查 Python / Node 环境
2. 创建虚拟环境并安装依赖
3. 构建前端
4. 启动后端

### 方式二：手动启动

#### 1. 准备 MySQL

```sql
CREATE DATABASE digital_management CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'dam'@'localhost' IDENTIFIED BY 'dam_pass';
GRANT ALL PRIVILEGES ON digital_management.* TO 'dam'@'localhost';
FLUSH PRIVILEGES;
```

#### 2. 启动后端

```bash
cd backend
cp .env.example .env       # 按需修改 DB_*/SECRET_KEY 等配置
python -m venv venv
source venv/bin/activate   # Windows: venv\Scripts\activate
pip install -r requirements.txt
python -m uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload
```

#### 3. 构建前端

```bash
cd frontend
npm install
npm run build               # 生产构建（后端会自动托管 dist/）
# 或：
npm run dev                 # 开发模式，访问 http://localhost:5173
```

#### 4. 访问

打开浏览器：**http://localhost:8000**

默认账号：
- 用户名：`admin`
- 密码：`Admin@123456`

> ⚠️ 首次部署后请立即修改密码！

### 方式三：Docker Compose

```bash
docker compose up -d
```

服务包括：MySQL 8.0 + Backend。

## 📡 API 速览

### 管理 API（JWT 鉴权）

| Method | Path | 描述 |
|--------|------|------|
| POST | `/api/v1/auth/login` | 登录获取 Token |
| GET | `/api/v1/auth/me` | 当前用户信息 |
| GET | `/api/v1/assets` | 资产列表（支持筛选、搜索、分页） |
| POST | `/api/v1/assets/upload` | 单文件上传 |
| POST | `/api/v1/assets/upload/batch` | 批量上传 |
| GET | `/api/v1/assets/{id}` | 资产详情 |
| PATCH | `/api/v1/assets/{id}` | 更新资产 |
| DELETE | `/api/v1/assets/{id}?permanent=false` | 软删除 / 永久删除 |
| POST | `/api/v1/assets/{id}/restore` | 恢复 |
| POST | `/api/v1/assets/{id}/download` | 下载 |
| POST | `/api/v1/upload/init` | 初始化分片上传 |
| PUT | `/api/v1/upload/chunk/{session_id}` | 上传分片 |
| POST | `/api/v1/upload/complete` | 完成上传 |
| GET | `/api/v1/categories/tree` | 分类树 |
| GET | `/api/v1/tags` | 标签列表 |
| GET/POST/PATCH/DELETE | `/api/v1/api-keys` | API Key 管理 |
| GET | `/api/v1/stats/dashboard` | 仪表盘统计 |

完整文档：访问 `/docs`（Swagger UI）或 `/redoc`。

### 公开投递 API（API Key 鉴权）

> 其他系统使用 `X-API-Key: dam_xxxxxxxx` Header 调用。

| Method | Path | 所需 Scope | 描述 |
|--------|------|-------------|------|
| POST | `/api/public/v1/delivery/upload` | `assets:write` | 上传文件 |
| POST | `/api/public/v1/delivery/import-url` | `assets:write` | URL 导入 |
| GET | `/api/public/v1/delivery/assets` | `assets:read` | 列出本 Key 的资产 |
| GET | `/api/public/v1/delivery/assets/{code}` | `assets:read` | 资产详情 |
| DELETE | `/api/public/v1/delivery/assets/{code}` | `assets:delete` | 删除资产 |

### 调用示例（curl）

```bash
# 1. 上传文件
curl -X POST http://localhost:8000/api/public/v1/delivery/upload \
  -H "X-API-Key: dam_xxxxxxxxxxxxxxxxxxxxxxxxxxxx" \
  -F "file=@/path/to/image.png" \
  -F "title=My Image" \
  -F "tag_names=ai-generated,product" \
  -F "external_ref=order-12345"

# 2. URL 导入
curl -X POST http://localhost:8000/api/public/v1/delivery/import-url \
  -H "X-API-Key: dam_xxxxxxxxxxxxxxxxxxxxxxxxxxxx" \
  -H "Content-Type: application/json" \
  -d '{"url": "https://example.com/sample.jpg", "title": "Sample"}'

# 3. 列出本 Key 资产
curl http://localhost:8000/api/public/v1/delivery/assets \
  -H "X-API-Key: dam_xxxxxxxxxxxxxxxxxxxxxxxxxxxx"
```

### Python SDK 示例

```python
import requests

API_BASE = "http://localhost:8000/api/public/v1/delivery"
API_KEY = "dam_xxxxxxxxxxxxxxxxxxxxxxxxxxxx"

headers = {"X-API-Key": API_KEY}

# 上传
with open("image.png", "rb") as f:
    resp = requests.post(
        f"{API_BASE}/upload",
        headers=headers,
        files={"file": f},
        data={"title": "My Image", "tag_names": "demo,test"},
    )
asset = resp.json()["data"]
print(asset["original_url"])

# 列出
resp = requests.get(f"{API_BASE}/assets", headers=headers, params={"page": 1, "page_size": 20})
for item in resp.json()["data"]["items"]:
    print(item["asset_code"], item["original_url"])
```

## 📁 目录结构

```
DigitalManagement/
├── backend/                # FastAPI 后端
│   ├── app/
│   │   ├── api/            # API 路由（v1 管理 + public 投递）
│   │   ├── core/           # 配置、数据库、安全
│   │   ├── models/         # SQLAlchemy 数据模型
│   │   ├── schemas/        # Pydantic 数据契约
│   │   ├── services/       # 业务逻辑层
│   │   ├── utils/          # 工具（文件、媒体处理）
│   │   ├── middleware/     # 中间件
│   │   └── main.py         # 应用入口
│   ├── alembic/            # 数据库迁移
│   ├── requirements.txt
│   └── .env.example
├── frontend/               # React 前端
│   ├── src/
│   │   ├── api/            # API 客户端
│   │   ├── components/     # 业务组件
│   │   ├── pages/          # 页面
│   │   ├── stores/         # Zustand 状态
│   │   ├── styles/         # 主题 & 全局样式
│   │   └── router.tsx
│   ├── package.json
│   └── vite.config.ts
├── storage/                # 本地文件存储
│   ├── originals/          # 原始文件
│   ├── thumbnails/         # 缩略图
│   ├── previews/           # WebP 预览
│   └── temp/               # 临时上传
├── docs/
│   └── ARCHITECTURE.md
├── docker-compose.yml
├── start.bat / start.sh    # 一键启动脚本
└── README.md
```

## ⚙️ 关键配置（backend/.env）

```env
APP_PORT=8000
SECRET_KEY=<随机 32 字符以上>
DB_HOST=127.0.0.1
DB_PORT=3306
DB_USER=dam
DB_PASSWORD=dam_pass
DB_NAME=digital_management
STORAGE_ROOT=./storage
UPLOAD_MAX_FILE_SIZE_MB=2048
THUMBNAIL_SIZE=320
PREVIEW_MAX_WIDTH=1920
DEFAULT_ADMIN_USERNAME=admin
DEFAULT_ADMIN_PASSWORD=Admin@123456
```

## 🔒 安全建议

1. **修改默认密码**：首次登录后立即修改
2. **修改 SECRET_KEY**：生产环境必须使用 32+ 字符随机字符串
3. **修改默认 API Key**：如启用了外部投递
4. **启用 HTTPS**：通过 Nginx/Caddy 反向代理
5. **定期备份**：`./storage` + MySQL 数据库
6. **限制存储目录**：通过文件系统权限限制 `storage/` 仅服务进程可写

## 🗺️ Roadmap

- [ ] 视频转码（H.264/H.265，FFmpeg）
- [ ] HLS 自适应码流
- [ ] 全文检索（Meilisearch / Elasticsearch）
- [ ] 对象存储后端（S3 / MinIO / 阿里 OSS）
- [ ] 图片 AI 标注（自动打标签）
- [ ] 公开访问短链（带签名 + 过期）
- [ ] 多租户支持
- [ ] Vue 3 前端版本（可选）

## 📄 License

MIT
