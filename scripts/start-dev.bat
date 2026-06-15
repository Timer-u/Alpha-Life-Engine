@echo off
REM Alpha-Life Engine - Windows 快速启动脚本
REM 用途：在两个终端中同时启动前端和后端开发服务器

echo ================================
echo Alpha-Life Engine - 开发环境启动
echo ================================
echo.

REM 检查必要的工具
where node >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
    echo ❌ 错误: 未找到 Node.js，请先安装
    exit /b 1
)

where npm >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
    echo ❌ 错误: 未找到 npm，请先安装
    exit /b 1
)

where wrangler >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
    echo ❌ 错误: 未找到 Wrangler，请执行: npm install -g wrangler
    exit /b 1
)

echo ✅ 所有依赖已安装
echo.

REM 获取脚本所在目录
cd /d "%~dp0\.."

REM 检查 .env.development.local
if not exist ".env.development.local" (
    echo ⚠️  未找到 .env.development.local 文件
    echo 创建默认配置...
    (
        echo VITE_API_BASE_URL=http://localhost:8787/api
        echo VITE_ENVIRONMENT=development
    ) > ".env.development.local"
)

echo 📝 启动配置：
echo    - 后端服务器: http://localhost:8787
echo    - 前端应用: http://localhost:3000
echo    - 数据库: alpha-life-dev (本地^)
echo.

echo 🚀 启动后端服务器 (Wrangler)...
echo 一个新的终端窗口将打开，显示后端服务器日志
start cmd /k "wrangler dev --env development"

timeout /t 3 /nobreak

echo 🚀 启动前端开发服务器 (Vite)...
echo 一个新的终端窗口将打开，显示前端服务器日志
start cmd /k "npm run dev"

echo.
echo ✅ 两个服务器都已启动
echo.
echo 请在两个新打开的终端窗口中查看日志
echo 访问: http://localhost:3000
echo.
echo 按任意键关闭此窗口...
pause >nul
