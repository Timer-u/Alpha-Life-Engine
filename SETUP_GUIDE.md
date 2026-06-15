# Alpha-Life Engine 完整设置指南

## 目录
1. [前置条件](#前置条件)
2. [Phase 0: Cloudflare 基础设施配置](#phase-0-cloudflare-基础设施配置)
3. [Phase 1: 本地开发环境](#phase-1-本地开发环境)
4. [Phase 2-3: 并行开发开始](#phase-2-3-并行开发开始)

---

## 前置条件

- **Cloudflare 账户**：已注册并拥有有效的计费方式
- **Node.js 18+**：安装在本地机器上
- **Git**：版本控制
- **Wrangler CLI**：Cloudflare CLI 工具
- **股票账户**：用于实际交易（发展阶段后期）

---

## Phase 0: Cloudflare 基础设施配置

### Step 1: 安装并配置 Wrangler CLI

```bash
# 全局安装 Wrangler
npm install -g wrangler@latest

# 验证安装
wrangler --version

# 登录 Cloudflare 账户
wrangler login
```

**预期输出**：浏览器会打开 Cloudflare 授权页面，完成后返回终端

---

### Step 2: 创建 D1 数据库

#### 2.1 创建生产数据库

```bash
# 进入项目目录
cd "c:\Users\Timer\Documents\Alpha-Life Engine"

# 创建生产 D1 数据库
wrangler d1 create alpha-life-prod

# 命令输出类似：
# ✓ Successfully created DB "alpha-life-prod"
# Created your database using D1. 
# Binding is not yet configured. Add the binding to your wrangler.toml
```

**记录数据库 ID**（output 中的 UUID）

#### 2.2 创建开发数据库（用于本地测试）

```bash
wrangler d1 create alpha-life-dev
```

#### 2.3 更新或创建 `wrangler.toml` 配置

在项目根目录创建/更新 `wrangler.toml`：

```toml
name = "alpha-life-engine"
main = "src/index.ts"
compatibility_date = "2024-01-01"
env = "development"

# Database Bindings
[[d1_databases]]
binding = "DB"
database_name = "alpha-life-prod"
database_id = "YOUR_DB_ID_HERE"  # 替换为上面创建的 ID

# 开发环境配置
[env.development]
routes = [{pattern = "dev.example.com/*", zone_name = "example.com"}]
vars = { ENVIRONMENT = "development" }

[[env.development.d1_databases]]
binding = "DB"
database_name = "alpha-life-dev"
database_id = "YOUR_DEV_DB_ID_HERE"

[env.production]
routes = [{pattern = "example.com/*", zone_name = "example.com"}]
vars = { ENVIRONMENT = "production" }

[[env.production.d1_databases]]
binding = "DB"
database_name = "alpha-life-prod"
database_id = "YOUR_PROD_DB_ID_HERE"
```

---

### Step 3: 初始化数据库架构

#### 3.1 执行数据库迁移

```bash
# 运行迁移脚本（需要确保 database/migrate.ts 已实现）
npm run database:migrate

# 也可以直接通过 wrangler 执行 SQL
wrangler d1 execute alpha-life-prod --file=database/schema.sql
```

#### 3.2 验证数据库结构

```bash
# 列出所有表
wrangler d1 execute alpha-life-prod --command "SELECT name FROM sqlite_master WHERE type='table'"
```

**预期输出**：
```
┌──────────────────┐
│ name             │
├──────────────────┤
│ users            │
│ portfolio        │
│ transactions     │
│ market_data      │
│ strategy_reports │
└──────────────────┘
```

---

### Step 4: 配置 Cloudflare Access OTP 认证

#### 4.1 设置应用身份验证

1. **登录 Cloudflare 仪表板**：https://dash.cloudflare.com
2. **导航到 Zero Trust**：左侧菜单 > Zero Trust
3. **创建访问应用**：
   - Applications > Applications > Add an application
   - 选择 "Self-hosted" 应用
   - 名称：`Alpha-Life Engine`
   - 域名：`alpha-life.yourdomain.com`（需要在 Cloudflare 注册的域名）
   - 选择身份提供商：Email (OTP)

#### 4.2 配置电子邮件白名单

1. **设置访问策略**：
   - 选择刚创建的应用
   - 在 "Policies" 选项卡中编辑
   - 添加策略规则：
     - **Include**：Emails ending with / Emails → `@yourdomain.com`
     - **Require**：Authentication method → Email (OTP)

2. **配置 Email OTP 提供商**：
   - Settings > Authentication > Email
   - 启用电子邮件 OTP
   - 配置发件人地址（推荐使用 Resend）

#### 4.3 7 天会话管理

1. **设置会话持续时间**：
   - Applications > Your App > Additional settings
   - 设置 **Session Duration** 为 7 天（604800 秒）

#### 4.4 测试认证流程

```bash
# 本地开发时通过隧道测试
wrangler tunnel create alpha-life-engine
wrangler tunnel route dns alpha-life-engine.yourdomain.com

# 访问：https://alpha-life-engine.yourdomain.com
# 应该跳转到 OTP 验证页面
```

---

### Step 5: 配置 Resend 邮件服务

#### 5.1 获取 Resend API 密钥

1. **访问 Resend**：https://resend.com
2. **创建账户并获取 API Key**
3. **在项目中添加密钥**：

创建 `.env.local`（仅本地开发）：
```
RESEND_API_KEY=your_api_key_here
```

或在 Cloudflare Workers Secrets 中添加：
```bash
echo "your_api_key_here" | wrangler secret put RESEND_API_KEY --env production
```

#### 5.2 创建邮件模板

创建 `src/templates/strategy-evolution-reminder.ts`：

```typescript
export const strategyEvolutionTemplate = (userData: {
  username: string;
  evolutionDate: string;
  daysElapsed: number;
  pboScore: number;
}) => `
<!DOCTYPE html>
<html>
<head>
  <style>
    body { font-family: Arial, sans-serif; }
    .container { max-width: 600px; margin: 0 auto; padding: 20px; }
    .header { background: #0066cc; color: white; padding: 20px; }
    .content { padding: 20px; background: #f5f5f5; }
    .button { background: #0066cc; color: white; padding: 10px 20px; text-decoration: none; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>策略进化提醒</h1>
    </div>
    <div class="content">
      <p>亲爱的 ${userData.username},</p>
      <p>您的投资组合已经 ${userData.daysElapsed} 天没有进行策略进化更新。</p>
      <p>最后进化时间：${userData.evolutionDate}</p>
      <p>PBO 评分：${userData.pboScore.toFixed(2)}</p>
      <p><a href="https://alpha-life.yourdomain.com/strategy-evolution" class="button">查看策略进化</a></p>
    </div>
  </div>
</body>
</html>
`;
```

#### 5.3 测试邮件发送

```bash
# 创建测试脚本 scripts/test-email.ts
```

---

### Step 6: 设置 BaoStock 历史数据初始下载

#### 6.1 安装 BaoStock SDK

```bash
npm install baostock --save
```

#### 6.2 创建初始化脚本

编辑 `scripts/bao-stock-setup.ts`：

```typescript
import baostock as bs

interface HistoricalData {
  code: string;
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  amount: number;
}

async function downloadHistoricalData(): Promise<void> {
  // 初始化 BaoStock
  bs.login();

  const codes = ['sh.511360', 'sh.511880']; // ETF 代码
  const startDate = '1990-01-01';
  const endDate = new Date().toISOString().split('T')[0];

  for (const code of codes) {
    console.log(`开始下载 ${code} 从 ${startDate} 到 ${endDate}`);
    
    const rs = bs.query_history_k_data_plus(
      code,
      'date,code,open,high,low,close,volume,amount',
      start_date=startDate,
      end_date=endDate,
      frequency='d'
    );

    const data: HistoricalData[] = [];
    while (rs.error_code === '0') {
      const row = rs.next();
      if (row === null) break;
      
      data.push({
        code: row[1],
        date: row[0],
        open: parseFloat(row[2]),
        high: parseFloat(row[3]),
        low: parseFloat(row[4]),
        close: parseFloat(row[5]),
        volume: parseInt(row[6]),
        amount: parseFloat(row[7]),
      });
    }

    // 存储到数据库或本地
    console.log(`下载完成: ${data.length} 条记录`);
  }

  bs.logout();
}

downloadHistoricalData().catch(console.error);
```

#### 6.3 运行初始下载

```bash
# 首次运行（预计需要 10-30 分钟）
npm run baoStock:setup

# 验证数据
wrangler d1 execute alpha-life-prod --command "SELECT COUNT(*) FROM market_data"
```

---

## Phase 1: 本地开发环境

### Step 1: 更新项目依赖

```bash
# 更新到 React 19 和最新工具
npm install react@19 react-dom@19 --save

# 更新到 TanStack Query v5（React Query 新版本）
npm uninstall react-query
npm install @tanstack/react-query@5 --save

# 安装额外需要的依赖
npm install @hookform/resolvers react-hook-form --save
npm install clsx class-variance-authority --save

# 更新开发依赖
npm install --save-dev @types/react@19 @types/react-dom@19 vite@6
```

### Step 2: 配置本地开发服务器

#### 2.1 更新 `vite.config.ts`

```typescript
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000,
    host: true,
    proxy: {
      '/api': {
        target: 'http://localhost:8787', // Wrangler 本地服务器
        changeOrigin: true,
      },
    },
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, './src'),
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
})
```

#### 2.2 设置开发环境文件

创建 `.env.development.local`：
```
VITE_API_BASE_URL=http://localhost:8787/api
VITE_ENVIRONMENT=development
```

创建 `.env.production`：
```
VITE_API_BASE_URL=https://api.alpha-life.yourdomain.com
VITE_ENVIRONMENT=production
```

### Step 3: 启动本地开发

#### 3.1 同时启动前后端

打开两个终端窗口：

**终端 1 - 后端 (Wrangler 本地服务器)**：
```bash
wrangler dev --env development
# 输出应该显示：
# ⎔ Ready on http://localhost:8787
```

**终端 2 - 前端 (Vite 开发服务器)**：
```bash
npm run dev
# 输出应该显示：
#   VITE v6.0.0  ready in 123 ms
#   ➜  Local:   http://localhost:3000
```

#### 3.2 验证连接

访问 `http://localhost:3000`，应该能够加载应用

---

### Step 4: 配置 Mock 数据用于前端开发

#### 4.1 创建 Mock 数据提供程序

创建 `src/lib/mock-data.ts`：

```typescript
export const MOCK_PORTFOLIO_DATA = {
  portfolio: {
    user_id: 1,
    total_balance: 1200.5,
    safe_layer: {
      sh511360: 10000, // ETF 份额
      sh511880: 0,
    },
    ambition_layer: {
      shares: [],
    },
  },
  positions: [
    {
      id: 1,
      etf_code: 'sh.511360',
      etf_name: '海富通短融',
      quantity: 10000,
      current_price: 100.5,
      value: 1005000,
    },
  ],
  recent_transactions: [
    {
      id: 1,
      type: 'BUY',
      etf_code: 'sh.511360',
      amount: 1000,
      price: 100.2,
      commission: 5,
      date: new Date('2024-01-15'),
    },
  ],
  trigger_status: {
    current_balance: 1200.5,
    trigger_line: 1667,
    status: 'accumulating',
    progress_percentage: 72,
  },
};

export const MOCK_STRATEGY_EVOLUTION = {
  last_evolution: '2024-01-01',
  days_since_evolution: 45,
  pbo_score: 0.35,
  status_color: 'yellow',
  next_evolution: '2024-02-15',
};
```

#### 4.2 配置 React Query Mock Adapter

创建 `src/lib/query-client.ts`：

```typescript
import { QueryClient } from '@tanstack/react-query';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 1000 * 60 * 5, // 5 分钟
      retry: 1,
    },
  },
});

// Mock 数据模式
export const enableMockMode = () => {
  // 在开发环境中返回 mock 数据
  if (import.meta.env.DEV) {
    // MSW (Mock Service Worker) 可选配置
  }
};
```

---

## Phase 2-3: 并行开发开始

### 后端开发 (Phase 2)

#### 创建 `src/index.ts` - Hono 应用入口

```typescript
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';

const app = new Hono();

// 中间件
app.use(logger());
app.use(cors());

// 健康检查
app.get('/health', (c) => {
  return c.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// API 路由将在这里添加
// app.get('/api/portfolio/:userId', handlePortfolioRequest);
// ... 其他路由

export default app;
```

#### 创建 GitHub Actions 自动化

创建 `.github/workflows/daily-market-update.yml`：

```yaml
name: Daily Market Data Update
on:
  schedule:
    - cron: '0 16 * * 1-5'  # 周一到周五下午 4 点运行

jobs:
  update-market-data:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - name: Install Node.js
        uses: actions/setup-node@v3
        with:
          node-version: '18'
      - name: Install dependencies
        run: npm install
      - name: Fetch latest market data
        run: npm run baoStock:update
      - name: Deploy to Cloudflare
        run: npm run deploy
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
```

### 前端开发 (Phase 3)

#### 创建主应用组件

创建 `src/App.tsx`：

```typescript
import { QueryClientProvider } from '@tanstack/react-query';
import { queryClient } from '@/lib/query-client';
import { Dashboard } from '@/components/Dashboard';
import { Navigation } from '@/components/Navigation';

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <div className="min-h-screen bg-gray-50">
        <Navigation />
        <main className="container mx-auto px-4 py-8">
          <Dashboard />
        </main>
      </div>
    </QueryClientProvider>
  );
}
```

---

## 故障排除

### Wrangler 连接问题

```bash
# 重新认证
wrangler logout
wrangler login

# 验证配置
wrangler whoami
```

### D1 数据库访问问题

```bash
# 列出所有数据库
wrangler d1 list

# 检查特定数据库状态
wrangler d1 info alpha-life-prod
```

### 本地开发代理问题

- 确保 Wrangler 本地服务器运行在 8787 端口
- 确保 Vite 服务器运行在 3000 端口
- 清除浏览器缓存：`Ctrl+Shift+Delete`

---

## 检查清单

### 完成 Phase 0 之前
- [ ] Wrangler CLI 已安装并验证
- [ ] D1 生产和开发数据库已创建
- [ ] `wrangler.toml` 已配置数据库绑定
- [ ] 数据库迁移脚本已运行
- [ ] Cloudflare Access OTP 已配置
- [ ] Resend 邮件服务已配置
- [ ] BaoStock 初始数据已下载

### 完成 Phase 1 之前
- [ ] 项目依赖已更新
- [ ] 环境变量已配置
- [ ] 本地开发服务器可正常启动
- [ ] 前后端代理配置完成
- [ ] Mock 数据已准备

### 开始 Phase 2-3 之前
- [ ] GitHub Actions 工作流已配置
- [ ] 第一个 API 端点已测试
- [ ] 第一个前端组件已创建

---

## 下一步

1. **完成 Phase 0**：按照上述步骤配置所有 Cloudflare 基础设施
2. **验证数据库**：确保能通过 CLI 访问数据库
3. **启动本地开发**：同时运行后端和前端
4. **开始实现 API**：参考 `src/api/portfolio.ts` 的既有框架
5. **构建前端组件**：使用 React 19 + Tailwind 构建仪表板

如有问题，请参考 Cloudflare 官方文档：
- D1: https://developers.cloudflare.com/d1/
- Pages Functions: https://developers.cloudflare.com/pages/functions/
- Zero Trust Access: https://developers.cloudflare.com/cloudflare-one/applications/
