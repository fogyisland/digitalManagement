#!/usr/bin/env bash
#
# 启动数字资产管理系统（单端口：API 与前端都由这一个进程发出）。
#
# 这个脚本面向**服务器**：发布包里已经带了构建好的前端，所以这里不跑
# `npm run build`（那需要开发依赖，而服务器上只装生产依赖）。本地开发请用
# 仓库根目录的 `start.sh`。
#
# 用法：
#   ./start.sh              前台启动（Ctrl-C 停）
#   ./start.sh --check      只检查环境，不启动

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT_DIR"

echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║          数字资产管理系统 (DAM)                                ║"
echo "║          发布包启动脚本                                       ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""

# --- 1/4 Node ----------------------------------------------------------------
echo "[1/4] 检查 Node.js ..."
if ! command -v node >/dev/null 2>&1; then
  echo "[错误] 没有找到 node，请先安装 Node.js 18 或更高版本。"
  exit 1
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "[错误] Node.js 版本过低（当前 $(node --version)），需要 18 或更高。"
  exit 1
fi
node --version

# --- 2/4 依赖 ----------------------------------------------------------------
echo ""
echo "[2/4] 检查依赖 ..."
if [ ! -d "node_modules" ]; then
  echo "首次运行，正在安装生产依赖（npm ci --omit=dev）..."
  npm ci --omit=dev
  echo "依赖安装完成。"
else
  echo "node_modules 已存在，跳过安装。"
  echo "提示：换机器或改了 package.json 时，删掉 node_modules 重新执行 npm ci --omit=dev。"
fi

# --- 3/4 可写目录 ------------------------------------------------------------
echo ""
echo "[3/4] 检查可写目录 ..."
mkdir -p storage/originals storage/thumbnails storage/previews storage/temp \
         storage/manifests storage/placeholders
if [ ! -w "storage" ]; then
  echo "[错误] storage 目录不可写。上传会失败。"
  echo "       修法：chown -R \$(whoami) \"$ROOT_DIR/storage\""
  exit 1
fi
echo "storage/ 就绪。"

# --- 4/4 配置自检 ------------------------------------------------------------
echo ""
echo "[4/4] 检查配置 ..."
if [ ! -f ".env" ]; then
  echo "[注意] 没有 .env 文件，将使用内置默认值。"
  echo "       强烈建议：cp .env.example .env 并至少填上 JWT_SECRET 与数据库密码。"
  echo "       或者直接访问 http://<服务器地址>/init 走初始化向导。"
else
  # 只检查，不打印密钥本身。
  if grep -qE '^JWT_SECRET=.*[^=[:space:]]' .env; then
    echo "JWT_SECRET 已设置。"
  else
    echo "[警告] .env 里的 JWT_SECRET 是空的。"
    echo "       空值意味着任何人都能伪造登录令牌。发布到公网前必须填。"
  fi
fi

if [ ! -f "dist/index.html" ]; then
  echo "[错误] 找不到 dist/index.html —— 前端构建产物缺失。"
  echo "       这个发布包应当自带 dist/，请确认上传完整。"
  exit 1
fi

if [ "${1:-}" = "--check" ]; then
  echo ""
  echo "环境检查通过。加 ./start.sh 启动。"
  exit 0
fi

echo ""
echo "启动中……"
echo "  本机访问：http://127.0.0.1:$(grep -E '^PORT=' .env 2>/dev/null | cut -d= -f2 || echo 8000)"
echo ""
exec node src/server/server.js
