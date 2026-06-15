#!/bin/bash

# Alpha-Life Engine - 快速启动脚本
# 用途：同时启动前端和后端开发服务器

set -e

echo "================================"
echo "Alpha-Life Engine - 开发环境启动"
echo "================================"
echo ""

# 检查必要的工具
check_command() {
  if ! command -v $1 &> /dev/null; then
    echo "❌ 错误: 未找到 $1，请先安装"
    exit 1
  fi
}

check_command "node"
check_command "npm"
check_command "wrangler"

echo "✅ 所有依赖已安装"
echo ""

# 获取脚本所在目录
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$SCRIPT_DIR"

# 检查 .env.development.local
if [ ! -f .env.development.local ]; then
  echo "⚠️  未找到 .env.development.local 文件"
  echo "创建默认配置..."
  cat > .env.development.local << EOF
VITE_API_BASE_URL=http://localhost:8787/api
VITE_ENVIRONMENT=development
EOF
fi

echo "📝 启动配置："
echo "   - 后端服务器: http://localhost:8787"
echo "   - 前端应用: http://localhost:3000"
echo "   - 数据库: alpha-life-dev (本地)"
echo ""

# 创建后台进程
echo "🚀 启动后端服务器 (Wrangler)..."
wrangler dev --env development &
WRANGLER_PID=$!

sleep 3

echo "🚀 启动前端开发服务器 (Vite)..."
npm run dev &
VITE_PID=$!

echo ""
echo "✅ 两个服务器都已启动"
echo "   后端进程 ID: $WRANGLER_PID"
echo "   前端进程 ID: $VITE_PID"
echo ""
echo "按 Ctrl+C 停止所有服务器"
echo ""

# 等待所有进程
wait

echo "所有服务器已停止"
