# Alpha-Life Engine

[![CI](https://github.com/Timer-u/Alpha-Life-Engine/actions/workflows/ci-verify.yml/badge.svg)](https://github.com/Timer-u/Alpha-Life-Engine/actions/workflows/ci-verify.yml)
[![Daily Market Update](https://github.com/Timer-u/Alpha-Life-Engine/actions/workflows/daily-market-update.yml/badge.svg)](https://github.com/Timer-u/Alpha-Life-Engine/actions/workflows/daily-market-update.yml)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org)
[![Python](https://img.shields.io/badge/python-%3E%3D3.8-blue)](https://python.org)
[![License](https://img.shields.io/badge/license-GPL%20v3-blue)](LICENSE)

**个人量化定投系统** — 基于 1667 元触发线的双账户策略引擎。

自动跟踪 A 股 ETF 行情，结合策略演化器（MPT / Walk-Forward / CPCV），实现数据驱动的定投决策。

---

## 特性

- **双账户结构** — 安全层（货币基金） + 进取层（权益 ETF），自动平衡
- **1667 元触发线** — 余额达标自动执行买入，信号类型支持 BSM / DOUBLE / NORMAL / SKIP
- **策略演化引擎** — MPT 有效前沿、蒙特卡洛压力测试、Walk-Forward 优化、DSR 排序、PBO 过滤（Python）
- **自动行情更新** — GitHub Actions 每日 08:00 CST 自动拉取 BaoStock 数据
- **OTP 邮箱认证** — 一次性验证码登录，7 天持久化会话
- **实时仪表盘** — 投资组合概览、仓位详情、交易记录、触发进度

## 架构

```
┌─────────────────────────────────────────────────┐
│  Frontend (Vite + React 19 + React Router 7)    │
│  http://localhost:3000                           │
│  TanStack React Query · ECharts 6 · Tailwind 4  │
└──────────────┬──────────────────────────────────┘
               │  Vite Proxy (/api → :8787)
               │  Cookie (HttpOnly session_token)
┌──────────────▼──────────────────────────────────┐
│  Backend (Hono on Cloudflare Workers)            │
│  http://localhost:8787                           │
│  ┌────────────────────────────────────────────┐ │
│  │  /api/auth/*          — OTP 认证           │ │
│  │  /api/portfolio       — 投资组合与仓位     │ │
│  │  /api/trigger         — 触发决策引擎       │ │
│  │  /api/market-data     — ETF 行情历史       │ │
│  │  /api/transactions    — 交易记录           │ │
│  │  /api/strategy        — 策略报告           │ │
│  └────────────────────────────────────────────┘ │
└──────────────┬──────────────────────────────────┘
               │  D1 Binding
┌──────────────▼──────────────────────────────────┐
│  Cloudflare D1 (SQLite)                          │
│  users · sessions · otps · email_whitelist      │
│  portfolio · positions · transactions            │
│  market_data · trigger_log · strategy_reports    │
│  reconciliations · config                        │
└─────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────┐
│  Data Pipeline (scripts/)                        │
│  BaoStock (免费 A 股数据源)                      │
│  → Python 下载 → CSV → SQL INSERT → D1          │
└─────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────┐
│  Strategy Evolver (scripts/local-evolver/)       │
│  Python (PyTorch · NumPy · Pandas · scikit-learn)│
│  MPT · CPCV · Walk-Forward · DSR · PBO · MC     │
└─────────────────────────────────────────────────┘
```

### 技术栈

| 层 | 技术 |
| --- | --- |
| 前端 | React 19, React Router 7, Vite 8, TanStack React Query, ECharts 6, Tailwind CSS 4 |
| 后端 | Hono, Cloudflare Workers, TypeScript |
| 数据库 | Cloudflare D1 (SQLite) |
| 数据源 | BaoStock（免费开源 A 股 API） |
| 策略演化 | Python（PyTorch, scikit-learn, NumPy, Pandas） |
| CI/CD | GitHub Actions |

### 跟踪的 ETF

| 代码 | 名称 | 层 | 说明 |
| --- | --- | --- | --- |
| 511360 | 海富通短融ETF | 安全层 | 主配，类货币基金 |
| 511880 | 银华日利 | 安全层 | 备选轮动 |
| 000300 | 沪深300（指数） | 进取层 | 2005年至今历史数据 |
| 000905 | 中证500（指数） | 进取层 | 2005年至今历史数据 |
| 000922 | 中证红利（指数） | 进取层 | 2008年至今历史数据 |

## 快速开始

### 前置要求

| 工具 | 版本 | 用途 |
| --- | --- | --- |
| Node.js | ≥ 20 | 前端 + 脚本 |
| Python | ≥ 3.8 | BaoStock 行情获取 |
| npm | ≥ 10 | 依赖管理 |
| wrangler | ≥ 4 | D1 数据库 + Workers 部署 |

### 1. 安装依赖

```bash
pip install baostock pandas
npm install
```

### 2. 数据库初始化

```bash
npm run database:migrate   # 本地 D1 建表
```

### 3. 首次市场数据初始化

```bash
npm run market:init   # 下载全量历史 + 导入 D1
```

BaoStock 是免费开源 API，无需 API Key。首次下载约需 5-15 分钟。

### 4. 启动本地开发

```bash
# 终端 1: 后端 Workers
npm run backend:dev

# 终端 2: 前端 Vite
npm run dev

# 浏览器打开 http://localhost:3000
```

### 5. 白名单邮箱

首次登录需将邮箱加入白名单：

```bash
wrangler d1 execute alpha-life-dev --command="INSERT OR IGNORE INTO email_whitelist (email, notes) VALUES ('your@email.com', 'notes');" --local
```

### 认证流程

```
1. 输入邮箱 → POST /api/auth/otp/request
2. 控制台查看验证码（开发模式，未配 Resend 时）
3. 输入 6 位验证码 → POST /api/auth/otp/verify
4. 自动跳转仪表盘（7 天 Cookie 会话持久化）
```

开发模式下验证码打印在 `wrangler dev` 控制台（`[DEV] OTP: XXXXXX`）。

可选：配置 Resend API Key 发送真实邮件：

```bash
# .dev.vars
RESEND_API_KEY=re_xxxxx
```

## API 参考

### 认证

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/auth/otp/request` | 请求验证码 |
| POST | `/api/auth/otp/verify` | 验证并登录 |
| POST | `/api/auth/logout` | 退出登录 |
| GET | `/api/auth/me` | 当前用户信息 |

### 投资组合

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/portfolio` | 获取仪表盘数据（组合 + 仓位 + 交易 + 触发状态） |
| PUT | `/api/portfolio` | 更新余额 |

### 触发

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/trigger` | 执行触发决策 |
| GET | `/api/trigger/market-prices` | 获取当前 ETF 行情 |

### 交易

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/transactions` | 获取交易记录 |
| POST | `/api/transactions` | 创建交易 |
| POST | `/api/transactions/calculate-commission` | 计算佣金 |

### 策略与行情

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/market-data/history` | ETF 历史行情 |
| PATCH | `/api/strategy/report` | 推送策略报告 |

完整 API 文档见 [docs/API.md](docs/API.md)。

## 市场数据管理

```bash
npm run market:init             # 本地全量初始化（下载 + 建表）
npm run market:init:prod         # 生产环境全量初始化
npm run market:update            # 本地增量更新
npm run market:update:prod       # 生产环境增量更新
```

GitHub Actions 自动更新：`.github/workflows/daily-market-update.yml`，交易日 08:00 CST。

## 策略演化引擎（Python）

策略演化器位于 `scripts/local-evolver/`，基于 Python 实现：

| 模块 | 功能 |
| --- | --- |
| `mpt.py` | 有效前沿计算（CPCV + Purge/Embargo） |
| `monte_carlo.py` | 蒙特卡洛压力测试（GBM 路径） |
| `walk_forward.py` | Walk-Forward 优化 |
| `dsr.py` | Deflated Sharpe Ratio 排序 |
| `stability.py` | PBO 过滤，参数稳定性检查 |
| `sensitivity.py` | 最优点邻域梯度检查 |
| `report.py` | 策略报告生成 |

```bash
npm run evolve   # 启动策略演化
```

完整文档见 [docs/EVOLVER.md](docs/EVOLVER.md)。

## 验证流程

每次提交前请按以下顺序验证：

```bash
npm run types   # TypeScript 类型检查
npm run lint    # ESLint（零警告策略）
npm run build   # Vite 构建
```

## 部署

```bash
npm run build
npm run pages:deploy
```

生产环境需要：
- `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_API_TOKEN`
- `RESEND_API_KEY`（可选，用于邮件验证码）
- 邮箱白名单配置

完整部署指南见 [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)。

## 配置文件

| 文件 | 用途 |
| --- | --- |
| `wrangler.toml` | Cloudflare Workers 配置（D1 绑定、路由、环境变量） |
| `vite.config.ts` | Vite 构建配置 |
| `eslint.config.js` | ESLint 规则（TypeScript strict + type-aware） |
| `tsconfig.json` | TypeScript 编译配置（strict 模式） |
| `.env.example` | 环境变量模板 |

## 可用脚本

| 命令 | 说明 |
| --- | --- |
| `npm run dev` | 启动 Vite 前端（:3000） |
| `npm run backend:dev` | 启动 wrangler Workers（:8787） |
| `npm run build` | TypeScript 检查 + Vite 构建 |
| `npm run types` | TypeScript 类型检查（`tsc --noEmit`） |
| `npm run lint` | ESLint 检查（`--max-warnings 0`） |
| `npm run lint:fix` | ESLint 自动修复 |
| `npm run database:migrate` | 本地 D1 建表 |
| `npm run database:migrate:prod` | 生产 D1 建表 |
| `npm run market:init` | 初始化市场数据 |
| `npm run market:update` | 每日增量更新 |
| `npm run evolve` | 启动策略演化 |

## 项目结构

```
├── src/                    # 前端（React + Vite）
│   ├── components/         # UI 组件
│   ├── hooks/              # React Hooks（useAuth, usePortfolio）
│   ├── lib/                # 核心逻辑（auth, trigger-engine）
│   ├── pages/              # 页面（Login, Dashboard）
│   └── types/              # TypeScript 类型定义
├── functions/api/          # 后端（Hono Workers 路由）
├── scripts/                # 数据管道 + 策略演化
│   ├── bao-stock-setup.ts  # 全量数据下载
│   ├── daily-market-update.ts  # 每日更新
│   └── local-evolver/      # Python 策略演化器
├── database/               # Schema + 迁移脚本
├── docs/                   # 文档
└── .github/workflows/      # CI/CD
```

## 贡献指南

1. Fork 本仓库
2. 创建功能分支（`git checkout -b feature/amazing-feature`）
3. 确保代码通过类型检查和 lint：
   ```bash
   npm run types && npm run lint
   ```
4. 提交变更（`git commit -m 'feat: add amazing feature'`）
5. 推送分支并创建 Pull Request

### 代码规范

- ESLint 10 严格模式（type-aware rules），零警告策略
- TypeScript strict 模式，禁止 `any`
- 遵循已有代码风格（命名、导入排序、组件结构）

## 路线图

参见 [TODO.md](TODO.md) 了解当前开发优先级。

---

**Alpha-Life Engine v1.0** — 个人量化定投，数据驱动，自动化执行。
