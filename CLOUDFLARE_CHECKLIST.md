# Cloudflare 部署检查清单

本清单帮助您确保所有必要的 Cloudflare 基础设施已正确配置。

## 前置检查

- [ ] 已安装 Node.js 18+ 
  ```bash
  node --version
  ```

- [ ] 已全局安装 Wrangler CLI
  ```bash
  npm install -g wrangler@latest
  wrangler --version
  ```

- [ ] 已登录 Cloudflare 账户
  ```bash
  wrangler login
  wrangler whoami
  ```

## Step 1: D1 数据库配置

### 创建数据库
- [ ] 创建生产数据库
  ```bash
  wrangler d1 create alpha-life-prod
  # 记录数据库 ID: _______________________
  ```

- [ ] 创建开发数据库
  ```bash
  wrangler d1 create alpha-life-dev
  # 记录数据库 ID: _______________________
  ```

### 配置 wrangler.toml
- [ ] `wrangler.toml` 文件已创建
- [ ] 生产数据库 ID 已填入: `database_id = "..."`
- [ ] 开发数据库 ID 已填入: `database_id = "..."`

### 初始化数据库结构
- [ ] 运行数据库迁移
  ```bash
  wrangler d1 execute alpha-life-prod --file=database/schema.sql --env production
  ```

- [ ] 验证表已创建
  ```bash
  wrangler d1 execute alpha-life-prod --command "SELECT name FROM sqlite_master WHERE type='table'" --env production
  ```
  
  预期输出应包含以下表:
  - [ ] users
  - [ ] portfolio
  - [ ] transactions
  - [ ] market_data
  - [ ] trigger_logs
  - [ ] strategy_reports

## Step 2: Cloudflare Access (OTP 认证)

### Zero Trust 配置
- [ ] 已访问 https://dash.cloudflare.com/
- [ ] 已进入 Zero Trust 部分
- [ ] 已创建 Access 应用：`Alpha-Life Engine`

### Email OTP 设置
- [ ] 已在 Settings > Authentication > Email 启用 OTP
- [ ] 已配置发件人地址
- [ ] 已在应用策略中配置电子邮件白名单

### 会话配置
- [ ] 设置会话持续时间为 7 天 (604800 秒)
- [ ] 已测试 OTP 登录流程

### 测试认证
- [ ] 通过隧道创建访问代理
  ```bash
  wrangler tunnel create alpha-life-engine
  wrangler tunnel route dns alpha-life-engine.yourdomain.com
  ```

- [ ] 访问测试地址并验证 OTP 流程

## Step 3: Resend 邮件服务

### API 配置
- [ ] 已注册 Resend 账户 (https://resend.com)
- [ ] 已获取 API Key
- [ ] 已在 Cloudflare Secrets 中添加
  ```bash
  echo "your_api_key" | wrangler secret put RESEND_API_KEY --env production
  ```

### 邮件模板
- [ ] 策略进化提醒邮件模板已创建
- [ ] 邮件模板已测试

## Step 4: BaoStock 数据初始化

### 环境准备
- [ ] 已安装 Python 3.8+
  ```bash
  python --version
  ```

- [ ] 已安装 BaoStock 和 Pandas
  ```bash
  pip install baostock pandas
  ```

### 数据下载
- [ ] 运行初始化脚本
  ```bash
  npm run baoStock:setup
  ```
  预计运行时间：10-30 分钟

- [ ] 验证 CSV 文件已生成
  ```bash
  ls -la data/market_data/
  ```

### 数据导入到 D1
- [ ] 创建数据导入脚本 (scripts/import-market-data.ts)
- [ ] 运行导入脚本
  ```bash
  npm run database:seed
  ```

- [ ] 验证数据已导入
  ```bash
  wrangler d1 execute alpha-life-prod --command "SELECT COUNT(*) FROM market_data" --env production
  ```

## Step 5: GitHub Actions 配置

### Secrets 设置
- [ ] 已在 GitHub 仓库设置中添加 Secrets：
  - [ ] `CLOUDFLARE_API_TOKEN`
  - [ ] `CLOUDFLARE_ACCOUNT_ID`
  - [ ] `CLOUDFLARE_WORKER_ROUTE`

### 工作流文件
- [ ] `.github/workflows/daily-market-update.yml` 已创建
- [ ] 工作流触发时间已设置为 UTC 8:00 (东八区 16:00)

### 工作流测试
- [ ] 手动触发工作流进行测试
  ```
  GitHub > Actions > Daily Market Data Update > Run workflow
  ```

- [ ] 验证工作流执行成功
- [ ] 检查数据库中的新数据

## Step 6: 本地开发环境

### 依赖安装
- [ ] 已运行 `npm install`
- [ ] 已验证所有依赖版本

### 环境文件
- [ ] `.env.development.local` 已创建
- [ ] `.env.production` 已创建

### 启动脚本
- [ ] Windows: 已测试 `scripts/start-dev.bat`
- [ ] Mac/Linux: 已测试 `scripts/start-dev.sh`

### 本地测试
- [ ] 后端服务器启动: `http://localhost:8787`
- [ ] 前端应用启动: `http://localhost:3000`
- [ ] 前后端通信正常

## Step 7: 生产部署准备

### 代码准备
- [ ] 所有代码已提交到 Git
- [ ] 没有未跟踪的敏感文件 (API Keys 等)
- [ ] `.gitignore` 已配置正确

### 构建验证
- [ ] 本地构建成功
  ```bash
  npm run build
  ```

- [ ] TypeScript 类型检查通过
  ```bash
  npm run types
  ```

### 部署
- [ ] 生产部署命令测试
  ```bash
  npm run deploy
  ```

- [ ] 验证 Cloudflare Pages 中的部署状态

## Step 8: 生产验证

### 功能测试
- [ ] 访问生产环境 URL
- [ ] OTP 认证工作正常
- [ ] API 端点响应正常
- [ ] 数据库连接正常

### 监控设置
- [ ] Cloudflare Analytics 已启用
- [ ] 错误日志监控已配置
- [ ] 性能指标已配置

### 日常操作
- [ ] 每日市场数据更新正常运行
- [ ] 数据库备份已配置 (如适用)
- [ ] 定期检查错误日志

## 常见问题排查

### Wrangler 认证失败
```bash
wrangler logout
wrangler login
```

### 数据库访问被拒绝
- 确保 `wrangler.toml` 中的数据库 ID 正确
- 确保 Cloudflare 账户有权访问该数据库

### Python 脚本找不到
- 检查 Python 是否在系统 PATH 中
- 尝试使用 `python3` 而不是 `python`

### OTP 邮件未收到
- 检查 Resend API Key 是否正确
- 验证邮件地址在白名单中
- 检查垃圾邮件文件夹

## 快速参考命令

```bash
# 开发环境
npm run dev

# 本地测试
npm run types
npm run lint

# 数据库操作
npm run database:migrate
npm run baoStock:setup

# 部署
npm run build
npm run deploy

# 查询 D1 数据
wrangler d1 execute alpha-life-prod --command "SELECT * FROM users" --env production
```

## 完成标志

当所有检查项都打勾后，您的 Cloudflare 基础设施配置已完成！

您现在可以开始：
1. ✅ Phase 1: 核心后端开发
2. ✅ Phase 2-3: 并行前后端开发
3. ✅ Phase 4: 策略进化系统实现

---

**最后更新**: 2024-01-15
**维护者**: Alpha-Life Engine 团队
