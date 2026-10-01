@echo off
chcp 65001 > nul
setlocal enabledelayedexpansion

echo.
echo ╔══════════════════════════════════════════════════════════════╗
echo ║          数字资产管理系统 (DAM) 一键启动脚本                    ║
echo ╚══════════════════════════════════════════════════════════════╝
echo.

REM ============================================
REM Step 1: Check Python
REM ============================================
echo [1/5] 检查 Python 环境...
where python >nul 2>&1
if errorlevel 1 (
    echo [ERROR] 未检测到 Python，请先安装 Python 3.10+
    echo 下载地址：https://www.python.org/downloads/
    pause
    exit /b 1
)
python --version

REM ============================================
REM Step 2: Check Node
REM ============================================
echo.
echo [2/5] 检查 Node.js 环境...
where node >nul 2>&1
if errorlevel 1 (
    echo [ERROR] 未检测到 Node.js，请先安装 Node.js 18+
    echo 下载地址：https://nodejs.org/
    pause
    exit /b 1
)
node --version

REM ============================================
REM Step 3: Backend setup
REM ============================================
echo.
echo [3/5] 配置后端环境...
cd /d "%~dp0backend"

if not exist ".env" (
    echo 创建 .env 文件...
    copy .env.example .env > nul
    echo [INFO] 已创建 backend\.env，请根据实际情况修改数据库配置
)

if not exist "venv" (
    echo 创建 Python 虚拟环境...
    python -m venv venv
)

echo 安装 Python 依赖...
call venv\Scripts\activate.bat
python -m pip install --upgrade pip -q
pip install -r requirements.txt -q
if errorlevel 1 (
    echo [ERROR] Python 依赖安装失败
    pause
    exit /b 1
)

REM ============================================
REM Step 4: Frontend setup
REM ============================================
echo.
echo [4/5] 构建前端...
cd /d "%~dp0frontend"

if not exist "node_modules" (
    echo 安装前端依赖（首次可能需要几分钟）...
    call npm install
    if errorlevel 1 (
        echo [ERROR] 前端依赖安装失败
        pause
        exit /b 1
    )
)

echo 构建前端生产版本...
call npm run build
if errorlevel 1 (
    echo [WARN] 前端构建失败，将只启动 API 模式
)

REM ============================================
REM Step 5: Start backend
REM ============================================
echo.
echo [5/5] 启动后端服务...
cd /d "%~dp0backend"
call venv\Scripts\activate.bat

echo.
echo ╔══════════════════════════════════════════════════════════════╗
echo ║  ✓ 系统已就绪                                                ║
echo ║                                                              ║
echo ║  访问地址：http://localhost:8000                              ║
echo ║  API 文档：http://localhost:8000/docs                         ║
echo ║                                                              ║
echo ║  默认账号：admin                                              ║
echo ║  默认密码：Admin@123456                                       ║
echo ║                                                              ║
echo ║  按 Ctrl+C 退出                                               ║
echo ╚══════════════════════════════════════════════════════════════╝
echo.

python -m uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload

pause
