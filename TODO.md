# Alpha-Life Engine TODO

## P0 (Critical)
- **策略演化器 (本地端)**
  - MPT 有效前沿计算（CPCV + Purge/Embargo）
  - 蒙特卡洛压力测试（大量GBM 路径）
  - Walk-Forward 优化（DSR 排序，PBO 过滤）
  - CPCV 产生多条独立路径的夏普分布
  - PBO > 50% 自动拒绝参数集
  - 参数稳定性检查（最优点邻域梯度 < 阈值）
  - 策略报告生成与 PATCH 推送至云端

## P1 (High)
- **卖出摩擦弹窗**：输入 `CONFIRM_SELL` 随机字符串确认机制
- **月度对账页**：券商数据 vs 系统数据比对，差异 >1% 一键校准
- **触发记录持久化**：`src/lib/trigger-engine.ts` 的 `logTriggerDecision` 写入 D1 数据库

## P2 (Medium)
- **邮件通知系统**：策略演化器过期、执行建议通知邮件（Resend 集成）
- **双层账户仪表盘**：安全层累计收益、抱负层份额深度可视化
- **资金池 LCH 切分**：每月充值资金池后的自动切分逻辑

## P3 (Low)
- 优化前端 UI 交互（动画、加载状态）
- 完善错误提示与用户引导
- 文档补充（架构图、API 文档）