# 用 Nginx 部署

这份指南讲的是：**把一个 DAM 实例放到 Nginx 后面**，由 Nginx 终止 TLS、转发请求。

本项目只占**一个端口**（API、前端构建产物、上传文件都由同一个 Express 进程应答，默认 `8000`），所以 Nginx 只需要一个 upstream —— 没有 CORS 问题，也没有路径前缀要改。

---

## 这份指南解决什么

| 部署时真正会踩的坑 | 在哪一节 |
|---|---|
| Nginx 先答 413，应用根本没收到请求 | [上传体积](#3-上传体积两道上限与-nginx-的一道) |
| 前端 `<img>` 全是裂图 | [访问域名](#1-访问域名平台控制台--设置) |
| 审计日志里每条记录的 IP 都是 `127.0.0.1` | [真实 IP](#2-真实-ip) |
| ComfyUI 节点拿到的平台地址是 `http://` | [真实 IP](#2-真实-ip) 里的 `X-Forwarded-Proto` |
| 重建之后浏览器报「动态导入失败」 | [模式 B 的第三条规则](#3-兜底规则必须和应用一致) |

---

## 两种模式

### 模式 A：全部反代（推荐）

Nginx 把**每一个**请求转给应用。静态资源也由应用来答。

- 优点：只有一份规则，应用的缓存策略、404 语义、签名 URL 全部原样生效；升级应用不用动 Nginx。
- 缺点：静态资源也过一遍 Node。资产量小、并发不高时完全够用。

### 模式 B：Nginx 直接托管前端构建产物

Nginx 从磁盘直接答 `index.html` 与 `/assets/*`，其余转给应用。

- 优点：静态资源不过 Node，节省内存与 CPU；也方便把 `/assets/` 挂到 CDN。
- 缺点：**缓存规则与兜底规则要自己抄一份**，抄错了就会把应用刚修好的两个问题原样带回来（见下文「模式 B 的三条规则」）。

---

## 模式 A：完整配置

```nginx
# HTTP 只做一件事：把明文请求引到 HTTPS。
server {
    listen 80;
    server_name dam.example.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    # nginx ≥ 1.25.1 用这一行；更老的版本写 `listen 443 ssl http2;`
    http2 on;
    server_name dam.example.com;

    ssl_certificate     /etc/letsencrypt/live/dam.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/dam.example.com/privkey.pem;

    # 整个请求体的上限。必须 ≥ 应用的两道上限（默认 2048 MB），
    # 否则 Nginx 会先答 413，而应用连发生了什么都不知道。
    client_max_body_size 2100m;

    location / {
        proxy_pass http://127.0.0.1:8000;
        proxy_http_version 1.1;

        # 真实 IP 与协议。审计日志、调用日志、ingest 记录都靠这几行，
        # 缺了它们，nginx 后面的一切都记成 127.0.0.1 / http。
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Host  $host;

        # 上传：请求体直接流向应用，不在 Nginx 再落一份盘；
        # 大文件上传与缩略图生成都可能超过默认的 60 秒。
        proxy_request_buffering off;
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;

        # MCP（/mcp）是无会话的 streamable HTTP。关掉缓冲更稳，
        # 普通请求不受影响。
        proxy_buffering off;
    }
}
```

就这么多。这个实例的接口全在**一个端口**上，所以**不需要**为 `/api`、`/storage`、`/mcp` 分别写 location —— 一条 `location /` 就够。

> **别开 `proxy_cache`。** 应用的 `index.html` 带 `Cache-Control: no-cache`，一旦 Nginx 也缓存它，浏览器就会拿着上一个构建的外壳去要已经删掉的 chunk，报「Failed to fetch dynamically imported module」。

---

## 应用那边要做的三件事

### 1. 访问域名（平台控制台 → 设置）

应用的**签名文件链接是绝对地址**，按平台控制台「设置」里填的地址生成。前端的 `<img src>` 直接用它，所以这里填错就是一片裂图。

- 填：`https://dam.example.com`（**带 https**）
- 不要填：`http://127.0.0.1:8000`，也不要留空

> 留空也不是不能跑：ComfyUI 节点会改用「请求到达时的地址」来推断平台地址 —— 那就是 Nginx 转发的那个 `Host` 与 `X-Forwarded-Proto`，所以 **Nginx 必须转发这两个头**，否则节点会拿到 `http://dam.example.com`，然后它自己就用明文 HTTP 推图。

### 2. 真实 IP

在 `.env` 里加一行：

```ini
# Nginx 与应用在同一台机器上 ⇒ 只信回环地址来的转发头
TRUST_PROXY=loopback
```

| 值 | 含义 |
|---|---|
| `off`（默认） | 谁也不信。请求的来源地址就是来源地址 |
| `loopback` | 只在来源是回环地址时相信 `X-Forwarded-For`。**同机反代的正确设置** |
| `true` | 谁都能说自己是别人。只在端口不对外开放时可用 |
| 数字 | 相信这么多跳 |

不开的话，**审计日志、调用日志、平台审计**里每条记录的 IP 都是 `127.0.0.1` —— 一条指不出人的审计链。

> 为什么不默认开：转发头是**请求方可以自己写的**。端口若能直接从外面访问而应用又信了这个头，任何人都能在审计记录里写成别人。

### 3. 上传体积：两道上限，与 Nginx 的一道

应用有**两道**上限：

| 环境变量 | 含义 | 默认 |
|---|---|---|
| `UPLOAD_MAX_FILE_SIZE_MB` | 单个文件 | `2048` |
| `UPLOAD_MAX_REQUEST_SIZE_MB` | 一个请求的总量 | `2048`（与单文件相同） |

文件在读取时**整块缓存在进程内存**里，所以真正要卡住的是总量：一次请求可以带 20 个文件，只设单文件上限就等于放任 20 倍进内存。

Nginx 的 `client_max_body_size` 管的是**整个请求体**，所以取两者的**较大值**：

```nginx
client_max_body_size 2100m;   # ≥ max(UPLOAD_MAX_FILE_SIZE_MB, UPLOAD_MAX_REQUEST_SIZE_MB)
```

超大的文件走**分片上传**（`/api/v1/upload/init` → `/upload/chunk` → `/upload/complete`），它全程落盘、不吃内存，不受这两道上限约束。

---

## 模式 B 的三条规则

模式 B 里 Nginx 自己答前端构建产物。目录假设是 `/srv/dam/dist`（Docker 部署时是容器里的 `/app/dist`）。

### 1. 外壳永不缓存

外壳是**点名哈希 chunk 的那个文件**。缓存它，浏览器就会拿着上一个构建的外壳去要已经删掉的 chunk，报「动态导入失败」。

### 2. 带哈希的 chunk 长期缓存

chunk 的名字随内容变，内容变了名字也变 ⇒ 缓存多久都安全，可以放心 `immutable`。

### 3. 兜底规则必须和应用一致

应用的兜底是「**像文件的路径不是路由**」。写成 `try_files $uri $uri/ /index.html;` 会把一个已经删掉的 chunk 变成 200 + HTML，浏览器于是报「动态导入失败」而不是诚实的 404 —— 这正是应用刚修好的那个问题。

被排除的每一段都是应用在兜底之前就自己认领了的路径：`api`（管理 API、投递 API、健康检查）、`storage`（签名文件路由）、`mcp`（AI 客户端接入）、`docs` 与 `redoc`（接口文档）。**少排除一个，Nginx 就会把它当成页面路径答成 `index.html`** —— 接口文档与 MCP 接入会一起坏掉。

`(?:/|$)` 是边界：`/mcp` 认领了 `/mcp` 与 `/mcp/…`，但没有认领 `/mcp-access` —— 那是应用自己的一个页面路由，得照常当页面答。

三条合起来，加上「其余全部转给应用」，就是这样：

```nginx
server {
    listen 443 ssl;
    http2 on;
    server_name dam.example.com;

    ssl_certificate     /etc/letsencrypt/live/dam.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/dam.example.com/privkey.pem;

    client_max_body_size 2100m;

    root /srv/dam/dist;
    index index.html;

    # --- 1. 外壳永不缓存 ---------------------------------------------------
    location = /index.html {
        add_header Cache-Control "no-cache";
    }

    # --- 2. 带哈希的 chunk 长期缓存 -----------------------------------------
    location /assets/ {
        add_header Cache-Control "public, max-age=31536000, immutable";
        try_files $uri =404;
    }

    # --- 3. 兜底规则必须和应用一致 ------------------------------------------
    location ~ ^/(?!api(?:/|$)|storage(?:/|$)|mcp(?:/|$)|docs(?:/|$)|redoc(?:/|$))(?!.*\.[a-zA-Z0-9]+$) {
        try_files $uri /index.html;
    }

    # --- 其余全部转给应用 ---------------------------------------------------
    # /api/*（管理 API、投递 API、健康检查）、/storage/*（签名文件）、
    # /mcp、/docs、/redoc、/openapi.json 都必须走应用。
    location / {
        proxy_pass http://127.0.0.1:8000;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Host  $host;
        proxy_request_buffering off;
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
        proxy_buffering off;
    }
}
```

**顺序很重要**：nginx 先匹配正则 location，再退回前缀 location。所以：

- `/assets/index-abc.js` → 正则不匹配（有扩展名）→ 落到前缀 `/assets/` ✓
- `/assets/upload`（客户端的老路由，跳 `/import`）→ 正则匹配 → `try_files` 找不到 → 回 `index.html` ✓
- `/api/v1/assets` → 正则不匹配（`api` 被排除）→ 落到 `location /` → 转给应用 ✓
- `/storage/originals/x.png` → 同上 ✓
- `/mcp`、`/docs`、`/redoc` → 被排除 → 转给应用 ✓（少了这几项，接口文档与 MCP 接入都会被答成首页）

**`/storage/` 绝不能由 Nginx 直接从磁盘读**：那是一条**签名路由**，签名与租户绑定，直接读盘等于把所有人的原图公开。

---

## Docker 部署

`docker-compose.yml` 默认把 `8000` 映射到宿主机所有网卡。挂 Nginx 时**别把端口直接暴露出去**，只让本机可达：

```yaml
services:
  dam:
    ports:
      # 只绑回环：对外只有一个 443
      - "127.0.0.1:8000:8000"
```

Nginx 就在这台机器上，用 `proxy_pass http://127.0.0.1:8000;`。

---

## 不要在 Nginx 里做的事

| 别做 | 原因 |
|---|---|
| 自己加 CORS 响应头 | 应用自己按平台设置里的白名单答。多一份就多一份冲突 |
| 把 `/storage/` 指到磁盘 | 那是签名路由，签名与租户绑定 |
| 给 `/` 开 `proxy_cache` | 缓存外壳 ⇒ 重建后老客户端拿着旧 chunk 名去要文件 |
| 把 `Host` 改成上游的地址 | ComfyUI 节点会据此推断平台地址，签入链接也会指向错的主机 |
| 在代理层做鉴权 | 应用已经按角色与租户判过一遍；代理层再判一遍只会两套规则打架 |

---

## 排查清单

| 症状 | 多半是 |
|---|---|
| 上传直接 413，页面只说「请求太大」 | `client_max_body_size` 小于应用的上限 |
| 缩略图/原图全是裂图 | 平台「设置」里的访问域名没填，或填成了 `http://` |
| 审计日志里 IP 全是 `127.0.0.1` | 没设 `TRUST_PROXY`，或设的不是 `loopback` |
| ComfyUI 节点报的平台地址是 `http://` | 没转发 `X-Forwarded-Proto` |
| 重建后浏览器报「动态导入失败」 | 外壳被缓存了：检查 `proxy_cache` 与 `index.html` 的 `Cache-Control` |
| 深链接刷新 404 | 模式 B 的兜底正则写错了，或 `/api` `/storage` 没被排除 |
| 平台「调用日志」里看不到外部请求 | 请求没走到应用，或被 Nginx 拦在前面 |

健康检查：

```bash
curl -fsS https://dam.example.com/api/health        # → {"status":"ok","service":"dam"}
curl -fsS https://dam.example.com/api/health/ready  # 会碰数据库，探针要用这个
```

---

## Caddy

Caddy 更省事 —— 它自己管证书：

```caddy
dam.example.com {
    reverse_proxy 127.0.0.1:8000 {
        header_up X-Forwarded-Proto {scheme}
        header_up X-Real-IP {remote_host}
    }
    request_body {
        max_size 2100MB
    }
}
```

Caddy 默认就转发 `X-Forwarded-For` 与 `X-Forwarded-Proto`。`request_body.max_size` 对应 Nginx 的 `client_max_body_size`。应用那边同样要设 `TRUST_PROXY=loopback`。
