@echo off
chcp 65001 > nul
setlocal enabledelayedexpansion

echo.
echo ╔══════════════════════════════════════════════════════════════╗
echo ║          数字资产管理系统 (DAM) 一键启动脚本                    ║
echo ║                    单端口模式：前端 + API 都在 8000              ║
echo ╚══════════════════════════════════════════════════════════════╝
echo.

REM ============================================
REM Step 1: Check Node
REM ============================================
echo [1/4] 检查 Node.js 环境...
where node >nul 2>&1
if errorlevel 1 (
    echo [ERROR] 未检测到 Node.js，请先安装 Node.js 18+
    echo 下载地址：https://nodejs.org/
    pause
    exit /b 1
)
node --version

REM ============================================
REM Step 2: Dependencies
REM ============================================
echo.
echo [2/4] 安装依赖...
cd /d "%~dp0"

if not exist "node_modules" (
    echo 首次运行，正在安装依赖...
    call npm install
    if errorlevel 1 (
        echo [ERROR] 依赖安装失败
        pause
        exit /b 1
    )
)

REM ============================================
REM Step 3: Build the frontend
REM ============================================
echo.
echo [3/4] 构建前端...
call npm run build
if errorlevel 1 (
    echo [ERROR] 前端构建失败
    pause
    exit /b 1
)

REM ============================================
REM Step 4: Start the server — it serves the API and the built frontend
REM ============================================
echo.
echo [4/4] 启动服务...

echo.
echo ╔══════════════════════════════════════════════════════════════╗
echo ║  ✓ 系统已就绪                                                ║
echo ║                                                              ║
echo ║  访问地址：http://localhost:8000                              ║
echo ║  API 前缀：http://localhost:8000/api/v1                       ║
echo ║  交付接口：http://localhost:8000/api/public/v1                 ║
echo ║                                                              ║
echo ║  默认账号：admin                                              ║
echo ║  默认密码：Admin@123456                                       ║
echo ║                                                              ║
echo ║  按 Ctrl+C 退出                                               ║
echo ╚══════════════════════════════════════════════════════════════╝
echo.

call npm start

pause
