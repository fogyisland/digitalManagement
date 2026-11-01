#!/usr/bin/env bash
set -e

echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║          数字资产管理系统 (DAM) 一键启动脚本                    ║"
echo "║                    单端口模式：前端 + API 都在 8000              ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"

# ============================================
# Step 1: Check Node
# ============================================
echo "[1/4] 检查 Node.js 环境..."
if ! command -v node &> /dev/null; then
    echo "[ERROR] 未检测到 Node.js，请先安装 Node.js 18+"
    exit 1
fi
node --version

# ============================================
# Step 2: Backend dependencies
# ============================================
echo ""
echo "[2/4] 检查后端依赖..."
cd "$ROOT_DIR/backend"

if [ ! -d "node_modules" ]; then
    echo "首次运行，正在安装后端依赖..."
    npm install
fi

# ============================================
# Step 3: Frontend dependencies + build
# ============================================
echo ""
echo "[3/4] 构建前端..."
cd "$ROOT_DIR/frontend"

if [ ! -d "node_modules" ]; then
    echo "安装前端依赖（首次可能需要几分钟）..."
    npm install
fi

echo "构建前端生产版本..."
npm run build

# ============================================
# Step 4: Start backend — it serves the API and the built frontend
# ============================================
echo ""
echo "[4/4] 启动服务..."
cd "$ROOT_DIR/backend"

echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║  ✓ 系统已就绪                                                ║"
echo "║                                                              ║"
echo "║  访问地址：http://localhost:8000                              ║"
echo "║  API 前缀：http://localhost:8000/api/v1                       ║"
echo "║  交付接口：http://localhost:8000/api/public/v1                 ║"
echo "║                                                              ║"
echo "║  默认账号：admin                                              ║"
echo "║  默认密码：Admin@123456                                       ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""

exec npm start
