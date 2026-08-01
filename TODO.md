# Alpha-Life Engine TODO

## 已完成

- ~~**卖出摩擦弹窗**：输入 `CONFIRM_SELL` 随机字符串确认机制~~ — `SellConfirmModal` + `TransactionForm` 集成
- ~~**月度对账页**：券商数据 vs 系统数据比对，差异 >1% 一键校准~~ — `/reconciliation` 页面 + `/api/reconciliation` API
- ~~**邮件通知系统**：策略演化器过期、执行建议通知邮件~~ — cron 定时检查（45 天过期，7 天去重）+ EXECUTE 决策异步邮件
- ~~**双层账户仪表盘**：安全层累计收益、抱负层份额可视化~~ — `LayerCharts`（ECharts 累计收益曲线 + 进取层份额环图）+ `/api/portfolio/layer-performance`
- ~~**资金池 LCH 切分**：每月充值资金池后的自动切分逻辑~~ — `/api/portfolio/deposit` + `DepositForm`（按演化参数/LCH 比例切分）
- ~~ErrorBoundary、Toast、骨架加载~~ — `ErrorBoundary` / `ToastProvider` / `DashboardSkeleton`

## P3 (Low)

- ~~优化前端 UI 交互（更多动画、过渡效果）~~ — Motion 页面转场、卡片/列表交互、表单反馈、弹窗与 Toast 动画，支持 reduced motion
