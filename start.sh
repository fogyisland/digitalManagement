#!/usr/bin/env bash
set -e

echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║          数字资产管理系统 (DAM) 一键启动脚本                    ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""

# ============================================
# Step 1: Check Python
# ============================================
echo "[1/5] 检查 Python 环境..."
if ! command -v python3 &> /dev/null; then
    echo "[ERROR] 未检测到 Python3，请先安装 Python 3.10+"
    exit 1
fi
python3 --version

# ============================================
# Step 2: Check Node
# ============================================
echo ""
echo "[2/5] 检查 Node.js 环境..."
if ! command -v node &> /dev/null; then
    echo "[ERROR] 未检测到 Node.js，请先安装 Node.js 18+"
    exit 1
fi
node --version

# ============================================
# Step 3: Backend setup
# ============================================
echo ""
echo "[3/5] 配置后端环境..."
cd "$(dirname "$0")/backend"

if [ ! -f ".env" ]; then
    echo "创建 .env 文件..."
    cp .env.example .env
fi

if [ ! -d "venv" ]; then
    echo "创建 Python 虚拟环境..."
    python3 -m venv venv
fi

echo "安装 Python 依赖..."
source venv/bin/activate
pip install --upgrade pip -q
pip install -r requirements.txt -q

# ============================================
# Step 4: Frontend setup
# ============================================
echo ""
echo "[4/5] 构建前端..."
cd "$(dirname "$0")/frontend"

if [ ! -d "node_modules" ]; then
    echo "安装前端依赖（首次可能需要几分钟）..."
    npm install
fi

echo "构建前端生产版本..."
npm run build || echo "[WARN] 前端构建失败，将只启动 API 模式"

# ============================================
# Step 5: Start backend
# ============================================
echo ""
echo "[5/5] 启动后端服务..."
cd "$(dirname "$0")/backend"
source venv/bin/activate

echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║  ✓ 系统已就绪                                                ║"
echo "║                                                              ║"
echo "║  访问地址：http://localhost:8000                              ║"
echo "║  API 文档：http://localhost:8000/docs                         ║"
echo "║                                                              ║"
echo "║  默认账号：admin                                              ║"
echo "║  默认密码：Admin@123456                                       ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""

exec python -m uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload
