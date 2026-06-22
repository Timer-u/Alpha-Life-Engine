@echo off

echo ================================
echo Alpha-Life Engine - 开发环境启动
echo ================================
echo.

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

cd /d "%~dp0\.."

if not exist ".env.development.local" (
    echo ⚠️  未找到 .env.development.local 文件
    echo 创建默认配置...
    (
        echo VITE_API_BASE_URL=http://localhost:8787
        echo VITE_ENVIRONMENT=development
    ) > ".env.development.local"
)

echo 📝 启动配置：
echo    - 后端服务器: http://localhost:8787
echo    - 前端应用: http://localhost:3000
echo    - 数据库: alpha-life-dev (本地 D1)
echo.

echo 🚀 启动后端服务器 (wrangler pages dev)...
start cmd /k "wrangler pages dev dist --d1 DB=a491d7ba-045d-4303-a10b-ae25591e8164 --port 8787"

timeout /t 5 /nobreak

echo 🚀 启动前端开发服务器 (Vite)...
start cmd /k "npm run dev"

echo.
echo ✅ 两个服务器都已启动
echo.
echo 访问: http://localhost:3000
echo.
pause >nul
