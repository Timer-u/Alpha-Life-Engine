# Alpha-Life Engine

**个人量化定投系统** — 基于 1667 元触发线的双账户策略引擎。

## 系统架构

```
┌─────────────────────────────────────────────────┐
│  Frontend (Vite + React 19 + React Router 7)    │
│  http://localhost:3000                           │
└──────────────┬──────────────────────────────────┘
               │  Vite Proxy (/api → :8787)
               │  Cookie (HttpOnly session_token)
┌──────────────▼──────────────────────────────────┐
│  Backend (Hono on Cloudflare Workers)            │
│  http://localhost:8787                           │
│                                                  │
│  /api/auth/*          — OTP 认证                 │
│  /api/portfolio       — 投资组合与仓位           │
│  /api/trigger         — 触发决策引擎             │
│  /api/trigger/market-prices — 实时 ETF 行情      │
│  /api/transactions    — 交易记录                 │
└──────────────┬──────────────────────────────────┘
               │  D1 Binding
┌──────────────▼──────────────────────────────────┐
│  Cloudflare D1 (SQLite)                          │
│  • users / sessions / otps                       │
│  • portfolio / positions / transactions          │
│  • market_data (ETF 日线行情)                    │
│  • trigger_log / strategy_reports                │
└─────────────────────────────────────────────────┘
```

## 跟踪的 ETF

| 代码   | 名称            | 层     | 说明             |
| ------ | --------------- | ------ | ---------------- |
| 511360 | 海富通短融ETF   | 安全层 | 主配，类货币基金 |
| 511880 | 银华日利        | 安全层 | 备选轮动         |
| 510300 | 沪深300ETF      | 进取层 | 大盘蓝筹         |
| 510500 | 中证500ETF      | 进取层 | 中盘成长         |
| 515080 | 招商中证红利ETF | 进取层 | 长期定投标的     |

## 快速开始

### 前置要求

| 工具     | 版本  | 用途                     |
| -------- | ----- | ------------------------ |
| Node.js  | ≥ 20  | 前端 + 脚本              |
| Python   | ≥ 3.8 | BaoStock 行情获取        |
| npm      | ≥ 10  | 依赖管理                 |
| wrangler | ≥ 4   | D1 数据库 + Workers 部署 |

### 1. 安装依赖

```bash
pip install baostock pandas
npm install
```

### 2. 数据库初始化

```bash
# 本地开发 D1（需先确保 wrangler 已登录）
npm run database:migrate
```

### 3. 首次市场数据初始化

```bash
npm run market:init   # 下载全量历史 + 导入 D1
```

BaoStock 是**免费开源 API**，无需 API Key。首次下载 5 个 ETF 的全量历史数据（1990 年至今）约需 5-15 分钟。

### 4. 启动本地开发

```bash
# 终端 1: 启动后端 Workers
npm run backend:dev

# 终端 2: 启动前端 Vite
npm run dev

# 浏览器打开 http://localhost:3000
```

### 5. 白名单邮箱

首次登录需要将邮箱加入白名单（否则会提示"邮箱未在白名单中"）：

```bash
wrangler d1 execute alpha-life-dev --command="INSERT OR IGNORE INTO email_whitelist (email, notes) VALUES ('your@email.com', '自己的邮箱');" --local
```

## 认证流程

```
1. 输入邮箱 → POST /api/auth/otp/request
2. 控制台查看验证码（开发模式，未配 Resend 时）
3. 输入 6 位验证码 → POST /api/auth/otp/verify
4. 自动跳转仪表盘
5. F5 刷新：Cookie 持久化会话（7 天）
```

**开发模式**下验证码会打印在 `wrangler dev` 的控制台（`[DEV] OTP: XXXXXX`）。

可选：配置 Resend API Key 发送真实邮件：

```bash
# .dev.vars
RESEND_API_KEY=re_xxxxx
```

## 市场数据管理

### 首次下载全量历史

```bash
npm run market:init          # 本地
npm run market:init:prod     # 生产
```

### 每日增量更新

```bash
npm run market:update          # 本地
npm run market:update:prod     # 生产环境 D1
```

### GitHub Actions 自动更新

已配置 `.github/workflows/daily-market-update.yml`，交易日 08:00 CST 自动：

1. Setup Python + Node
2. 安装 baostock / pandas
3. 运行 `daily-market-update.ts` 获取最新 5 个交易日数据
4. 通过 wrangler 写入 D1

**无需 API Key**，BaoStock 完全免费。

## 可用脚本

| 命令                            | 说明                           |
| ------------------------------- | ------------------------------ |
| `npm run dev`                   | 启动 Vite 前端（:3000）        |
| `npm run backend:dev`           | 启动 wrangler Workers（:8787） |
| `npm run build`                 | TypeScript 检查 + Vite 构建    |
| `npm run types`                 | 仅 TypeScript 类型检查         |
| `npm run database:migrate`      | 本地 D1 建表                   |
| `npm run database:migrate:prod` | 生产 D1 建表                   |
| `npm run baoStock:setup`        | 下载全量 BaoStock 历史数据     |
| `npm run market:init`           | 初始化市场数据（下载 + 导入）  |
| `npm run market:update`         | 每日增量更新市场数据           |
| `npm run market:update:prod`    | 生产环境每日更新               |

## 部署

```bash
npm run build
npm run pages:deploy
```

生产环境需要：

- `CLOUDFLARE_ACCOUNT_ID` 和 `CLOUDFLARE_API_TOKEN`
- 配置 `RESEND_API_KEY`（可选，用于邮件发送验证码）
- 白名单邮箱（通过 D1 SQL 或管理界面配置）

---

**Alpha-Life Engine v1.0** — 个人量化定投，数据驱动，自动化执行。
