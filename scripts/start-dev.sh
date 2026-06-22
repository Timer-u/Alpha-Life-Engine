#!/bin/bash
set -e
echo "================================"
echo "Alpha-Life Engine - 开发环境启动"
echo "================================"
echo ""

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

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$SCRIPT_DIR/.."

if [ ! -f .env.development.local ]; then
  echo "⚠️  未找到 .env.development.local 文件"
  echo "创建默认配置..."
  cat > .env.development.local << EOF
VITE_API_BASE_URL=http://localhost:8787
VITE_ENVIRONMENT=development
EOF
fi

echo "📝 启动配置："
echo "   - 后端服务器: http://localhost:8787"
echo "   - 前端应用: http://localhost:3000"
echo "   - 数据库: alpha-life-dev (本地 D1)"
echo ""

echo "🚀 启动后端服务器 (wrangler pages dev)..."
wrangler pages dev dist --d1 DB=a491d7ba-045d-4303-a10b-ae25591e8164 --port 8787 &
WRANGLER_PID=$!

sleep 5

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

cleanup() {
  echo ""
  echo "正在停止服务器..."
  kill $WRANGLER_PID $VITE_PID 2>/dev/null || true
  wait
  echo "所有服务器已停止"
  exit 0
}
trap cleanup SIGINT SIGTERM

wait
