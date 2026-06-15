# 🚀 Alpha-Life Engine 快速开始指南

这是一个完整的个人量化定投系统。本指南将帮助您快速上手开发和部署。

## 📋 系统要求

- **Node.js**: 18.0.0 或更高版本
- **npm**: 9.0.0 或更高版本  
- **Python**: 3.8+ (用于 BaoStock 数据下载)
- **Cloudflare 账户**: 免费或付费账户

## 🎯 5 分钟快速开始

### 1. 安装依赖

```bash
# 安装项目依赖
npm install

# 全局安装 Wrangler (Cloudflare CLI)
npm install -g wrangler@latest

# 登录 Cloudflare
wrangler login
```

### 2. 配置 Cloudflare D1 数据库

```bash
# 创建开发数据库
wrangler d1 create alpha-life-dev

# 创建生产数据库  
wrangler d1 create alpha-life-prod

# 复制上面命令输出的数据库 ID 到 wrangler.toml
# 编辑 wrangler.toml 并在相应位置填入 database_id
```

### 3. 初始化数据库

```bash
# 运行迁移创建表
npm run database:migrate

# 验证表已创建
wrangler d1 execute alpha-life-dev --command "SELECT name FROM sqlite_master WHERE type='table'"
```

### 4. 启动开发服务器

```bash
# 方法 1: 使用启动脚本 (Windows)
scripts/start-dev.bat

# 方法 2: 使用启动脚本 (Mac/Linux)
bash scripts/start-dev.sh

# 方法 3: 手动启动两个终端

# 终端 1 - 后端
wrangler dev --env development

# 终端 2 - 前端  
npm run dev
```

### 5. 访问应用

打开浏览器访问：**http://localhost:3000**

## 📂 项目结构

```
.
├── src/                    # 源代码
│   ├── api/               # API 端点
│   ├── components/        # React 组件
│   ├── lib/              # 工具库
│   └── types/            # TypeScript 类型定义
├── database/             # 数据库文件
│   ├── schema.sql        # 数据库架构
│   ├── migrate.ts        # 迁移脚本
│   └── seed.ts          # 种子数据
├── scripts/              # 工具脚本
│   ├── bao-stock-setup.ts
│   ├── start-dev.sh
│   └── start-dev.bat
├── .github/workflows/    # GitHub Actions
├── wrangler.toml        # Cloudflare 配置
├── vite.config.ts       # Vite 配置
└── package.json         # 项目依赖
```

## 🛠️ 常用命令

### 开发命令

```bash
# 启动开发服务器
npm run dev

# 类型检查
npm run types

# 代码检查和修复
npm run lint
npm run lint:fix
```

### 数据库命令

```bash
# 运行迁移
npm run database:migrate

# 导入种子数据
npm run database:seed

# BaoStock 初始化（下载所有历史数据）
npm run baoStock:setup
```

### 部署命令

```bash
# 构建生产版本
npm run build

# 预览构建结果
npm run preview

# 部署到 Cloudflare
npm run deploy
```

### 数据库查询

```bash
# 直接通过 Wrangler 查询数据库
wrangler d1 execute alpha-life-dev --command "SELECT * FROM users"

# 使用文件执行 SQL
wrangler d1 execute alpha-life-dev --file=database/schema.sql
```

## 🔑 关键配置文件

### `wrangler.toml` - Cloudflare 配置
```toml
name = "alpha-life-engine"
main = "src/index.ts"

[[d1_databases]]
binding = "DB"
database_id = "YOUR_DB_ID_HERE"
```

### `.env.development.local` - 开发环境变量
```
VITE_API_BASE_URL=http://localhost:8787/api
VITE_ENVIRONMENT=development
```

## 📊 数据库表说明

| 表名 | 用途 |
|-----|------|
| `users` | 用户账户信息 |
| `portfolio` | 投资组合概览 |
| `positions` | 持仓详情 |
| `transactions` | 买卖交易记录 |
| `market_data` | 股票价格历史 |
| `trigger_logs` | 触发器决策日志 |
| `strategy_reports` | 策略进化报告 |
| `reconciliations` | 月度对账记录 |

## 🔐 环境变量

### 必需变量
```bash
# Cloudflare API
CLOUDFLARE_API_TOKEN=your_token_here
CLOUDFLARE_ACCOUNT_ID=your_account_id

# 邮件服务
RESEND_API_KEY=your_resend_key

# BaoStock (可选)
BAOSTOCK_API_KEY=your_baostock_key
```

### 可选变量
```bash
# 日志级别
LOG_LEVEL=debug

# API 超时
API_TIMEOUT=30000

# 触发线
TRIGGER_LINE=1667
```

## 🚨 常见问题

### Q: "找不到 Wrangler 命令"
A: 确保全局安装了 Wrangler：`npm install -g wrangler@latest`

### Q: "数据库连接失败"
A: 检查 `wrangler.toml` 中的 `database_id` 是否正确

### Q: "OTP 邮件未收到"
A: 检查 Resend API Key 是否正确配置，以及邮箱是否在白名单中

### Q: "BaoStock 下载很慢"
A: 首次下载所有历史数据需要 10-30 分钟，这是正常的。之后可通过 GitHub Actions 每日更新

### Q: "前端访问 API 返回 404"
A: 确保后端已启动在 `localhost:8787`，检查 `vite.config.ts` 中的代理配置

## 📚 进阶指南

详细的分步指南请参考：
- [完整设置指南](./SETUP_GUIDE.md)
- [Cloudflare 检查清单](./CLOUDFLARE_CHECKLIST.md)
- [API 文档](./docs/API.md) (待创建)
- [架构设计](./docs/ARCHITECTURE.md) (待创建)

## 🔄 开发流程

1. **本地开发**: 使用 `npm run dev` 启动开发服务器
2. **数据库更改**: 编辑 `database/schema.sql` 并运行迁移
3. **API 开发**: 在 `src/api/` 中创建新的 API 端点
4. **前端开发**: 在 `src/components/` 中创建 React 组件
5. **测试**: 运行 `npm run types` 和 `npm run lint`
6. **构建**: 运行 `npm run build` 检查构建是否成功
7. **提交**: 提交代码到 Git，GitHub Actions 自动测试

## 🌐 部署流程

1. 推送代码到 GitHub
2. GitHub Actions 自动运行测试
3. 通过测试后自动部署到 Cloudflare Pages
4. 每天 UTC 8:00 自动更新市场数据

## 📈 项目阶段

- ✅ **Phase 0**: 基础设施配置 (完成)
- 🔄 **Phase 1**: 核心后端开发 (进行中)
- ⏳ **Phase 2-3**: 并行前后端开发 (待开始)
- ⏳ **Phase 4**: 策略进化系统 (待开始)
- ⏳ **Phase 5**: 集成部署 (待开始)

## 💡 提示

- 第一次设置可能需要 30 分钟到 1 小时
- BaoStock 初始下载可能需要 10-30 分钟
- 在开发期间使用 Mock 数据加快开发速度
- 定期检查 GitHub Actions 日志以确保自动化工作流运行正常

## 📞 获取帮助

- 查看 [Cloudflare 文档](https://developers.cloudflare.com)
- 查看 [Vite 文档](https://vitejs.dev)
- 查看 [React 文档](https://react.dev)
- 查看 [BaoStock 文档](https://baostock.com)

## 📄 许可证

MIT License

---

**祝您开发愉快！** 🎉
