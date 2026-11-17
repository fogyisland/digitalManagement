# 部署说明

数字资产管理系统（DAM）—— 单端口实例：API 与前端由同一个 Node 进程发出。

这个目录就是**要上传到服务器的全部内容**。包里没有 `node_modules`（原生模块要在目标机上编译）、没有 `.env`（里面是密钥）、没有上传的原件（数据在 `storage/` 和数据库里）。

---

## 0. 前置条件

| 需要 | 版本 | 说明 |
|---|---|---|
| Node.js | **18 或更高** | 用 `node -v` 确认 |
| MySQL | **5.7+** | 或 MariaDB 10.4+ |
| 磁盘 | 按数据量 | 至少留出上传原件体积的 2 倍（原件 + 缩略图 + 预览） |
| Nginx | 任意稳定版 | 可选，但对外提供服务强烈建议挂 |

---

## 1. 上传

把整个 `up/` 目录传到服务器，例如 `/srv/dam`：

```bash
scp -r up/* deploy@server:/srv/dam/
```

传完先核对一遍，文件在传输中损坏过是最难查的问题：

```bash
cd /srv/dam
sha256sum -c SHA256SUMS
```

每一行都该是 `OK`。有 `FAILED` 就是文件没传全，重传。

---

## 2. 安装依赖

```bash
cd /srv/dam
npm ci --omit=dev
```

`sharp`（缩略图）和 `bcryptjs`（密码哈希）带原生二进制，这一步会在目标机上编译/下载对应平台的版本，所以**必须在服务器上做**，不能从别处拷 `node_modules` 过来。

---

## 3. 建库与建账号

用 MySQL 管理员执行：

```bash
mysql -u root -p < scripts/create-database.sql
```

**改掉脚本里的 `change-me` 密码**（脚本第 14、15 行）。应用自己会建表、建种子数据，所以这一步只需要把库和账号交出来。

如果不想给应用建库权限，也可以手动建库后让它只连已有的库 —— 那需要应用账号对 `digital_management` 有 `CREATE` 权限（它要自己建表）。

---

## 4. 配置

两条路，选一条。

### 路线 A：初始化向导（推荐）

**什么都不用配**，直接启动，然后浏览器打开 `http://服务器地址:8000/init`：

```bash
cd /srv/dam
./start.sh
```

控制台会打印一个**一次性令牌**（形如 `init-xxxxxxxx`）。在向导里：

1. 填数据库连接（库名 `digital_management`、账号 `dam`、密码你在第 3 步设的）
2. 建管理员账号
3. 生成一份 `.env`（向导会随机生成 `JWT_SECRET` 并写进文件）

向导走完后，`.env` 就有了。

### 路线 B：手写 `.env`

```bash
cd /srv/dam
cp .env.example .env
vi .env
```

**至少要改这三项**，其余保持默认：

```ini
DB_PASSWORD=第3步设的密码
JWT_SECRET=至少32位随机字符串
TRUST_PROXY=loopback
```

`JWT_SECRET` 留空 = 任何人都能伪造登录令牌。生成一个：

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

> `TRUST_PROXY=loopback` 是**挂了 Nginx 之后**要设的。不设的话，审计日志、调用日志、平台审计里每条记录的 IP 都是 `127.0.0.1` —— 一条指不出人的审计链。细节见 `docs/DEPLOY-NGINX.md`。

---

## 5. 启动

先自检：

```bash
./start.sh --check
```

它会检查 Node 版本、依赖、可写目录、`JWT_SECRET`、前端构建产物，然后不启动。

### 前台启动（先试跑）

```bash
./start.sh
```

看到 `DAM backend listening on http://...` 就成了。浏览器打开 `http://服务器地址:8000` 应该能看到登录页。

### systemd（长期运行）

`/etc/systemd/system/dam.service`：

```ini
[Unit]
Description=Digital Asset Management (DAM)
After=network.target mysql.service
Requires=mysql.service

[Service]
Type=simple
User=dam
Group=dam
WorkingDirectory=/srv/dam
Environment=NODE_ENV=production
ExecStart=/usr/bin/node src/server/server.js
Restart=always
RestartSec=5

# 上传会整块缓存在内存里，这个限制与 UPLOAD_MAX_FILE_SIZE_MB 配套
MemoryMax=4G

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now dam
sudo systemctl status dam
```

`WorkingDirectory` 必须是 `/srv/dam` —— 应用把 `dist/` 和 `storage/` 都按**仓库根目录**解析（`src/server` 上两级），工作目录不对就找不到前端。

---

## 6. 挂 Nginx

1. 改 `nginx.conf.example` 里的三处：`server_name`、`ssl_certificate`、`client_max_body_size`
2. 装到 `/etc/nginx/conf.d/dam.conf`
3. `nginx -t && nginx -s reload`

```bash
cp nginx.conf.example /etc/nginx/conf.d/dam.conf
sudo vi /etc/nginx/conf.d/dam.conf
sudo nginx -t && sudo systemctl reload nginx
```

**别忘了应用那边也要动**（少一样就是半成品）：

- `.env` 里 `TRUST_PROXY=loopback`
- 平台控制台 → 设置 → 访问域名，填 `https://你的域名`（**带 https**）—— 签名文件链接是绝对地址，前端 `<img src>` 直接用它，填错就是一片裂图
- **8000 端口不要对外**：`ufw deny 8000/tcp`。直连端口又开了 `TRUST_PROXY` 的话，任何人都能在审计记录里写成别人

完整说明（含模式 B：Nginx 自己发前端）见 `docs/DEPLOY-NGINX.md`。

---

## 7. 上线自检

逐条确认，每条都有明确的判据：

| 检查 | 怎么查 | 应该是 |
|---|---|---|
| 服务在跑 | `curl -s localhost:8000/api/health` | 200 与健康信息 |
| 前端能打开 | `curl -sI localhost:8000/` | `200` + `text/html` |
| 深链接能开 | `curl -sI localhost:8000/organize` | `200`（不是 404） |
| 接口文档在 | `curl -sI localhost:8000/docs` | `200` |
| MCP 在 | `curl -sI localhost:8000/mcp` | 不是 404（405 也对） |
| 外壳不缓存 | `curl -sI localhost:8000/ \| grep -i cache-control` | 含 `no-cache` |
| chunk 长期缓存 | `curl -sI localhost:8000/assets/<某个chunk>` | 含 `max-age=31536000` |
| 审计 IP 是真人 | 登录后看平台审计里的 IP | 不是 `127.0.0.1`（说明 `TRUST_PROXY` 生效） |
| 上传能过 | 上传一个小文件 | 200，资产库里能看到 |
| 缩略图能看 | 打开那个资产的详情页 | 缩略图正常显示，不是裂图 |
| 签名链接可访问 | 复制资产的签名 URL 换浏览器打开 | 200 |

> 前端能开但**深链接 404** ⇒ 兜底规则不对。若用 Nginx 模式 B，兜底必须和应用一致，
> 见 `docs/DEPLOY-NGINX.md` 的「模式 B 的三条规则」。

---

## 8. 升级

1. 备份数据库与 `storage/`（**这两样才是数据**，代码可以重来）
2. 上传新的发布包，**但不要覆盖 `.env` 和 `storage/`**：

```bash
# 只换代码，保留配置与数据
rsync -av --exclude '.env' --exclude 'storage/' up/ deploy@server:/srv/dam/
```

3. 重启：

```bash
cd /srv/dam && npm ci --omit=dev && sudo systemctl restart dam
```

数据库的表和列由应用自己在启动时补齐（缺什么加什么），一般不需要手工迁移。

---

## 9. 备份什么

| 对象 | 位置 | 工具 |
|---|---|---|
| 数据库 | MySQL 里的 `digital_management` | `mysqldump -u dam -p digital_management > dam-$(date +%F).sql` |
| 上传原件 | `/srv/dam/storage/originals` | `rsync` / 快照 |
| 缩略图与预览 | `/srv/dam/storage/{thumbnails,previews}` | 可再生，但一起备更省事 |
| 配置 | `/srv/dam/.env` | 手工另存（含密钥，别进版本库） |

---

## 10. 常见问题

**启动报 `EADDRINUSE`** —— 8000 被占了。`ss -lptn 'sport = :8000'` 看是谁。

**前端一片裂图** —— 平台控制台里的「访问域名」没填，或没带 `https`。签名文件链接是绝对地址。

**审计日志 IP 全是 `127.0.0.1`** —— 没设 `TRUST_PROXY=loopback`，或者 Nginx 没转发 `X-Forwarded-For`。

**上传报 413** —— Nginx 的 `client_max_body_size` 小于应用的上限。应用有**两道**上限（`UPLOAD_MAX_FILE_SIZE_MB` / `UPLOAD_MAX_REQUEST_SIZE_MB`，默认都是 2048），Nginx 要取**较大值**。

**上传报 413 但直连应用正常** —— 就是上面那条：Nginx 先拒了，应用根本不知道。

**浏览器报「Failed to fetch dynamically imported module」** —— 缓存了旧的外壳去要已删除的 chunk。应用自己发的外壳带 `Cache-Control: no-cache`；用 Nginx 模式 B 时要照指南加上外壳不缓存那条。

**`/docs` 打开是首页** —— Nginx 模式 B 的兜底规则漏了 `docs` / `redoc` 排除项，它们会被当成页面路径答成 `index.html`。

**`.env` 里的相对路径** —— 相对路径按**仓库根目录**解析（`src/server` 上两级），不按工作目录。所以 `STORAGE_DIR=./storage` 指的是 `/srv/dam/storage`，无论从哪儿启动。

---

## 包里有什么

见 `MANIFEST.txt`（含每个文件的 SHA-256）。几个要点：

- `dist/` —— 前端构建产物，已构建好，服务器上不用再 `npm run build`（那需要开发依赖）
- `src/server/` —— 服务端运行时，含 `openapi.yaml`（`/docs` 与 `/redoc` 靠它）
- `package.json` + `package-lock.json` —— `npm ci --omit=dev` 会装出**和测试时同一棵**依赖树
- `storage/` —— 只有目录骨架，空的
