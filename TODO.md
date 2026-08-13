# Alpha-Life Engine TODO

> 2026-08 全库代码评审（前端 / 后端 / 策略演化器 / 数据管道）+ P0 修复完成。
>
> **P0 已全部完成并验证**（8 项）。演化器现在真正仿真 DCA 策略、六个参数全部影响目标函数、回测样本从 ~110 天扩到 4400+ 天、OTP 走 CSPRNG 且有限流、session token 只存哈希、双入口收敛为单一 typed Worker、触发线跟随演化参数。
>
> 验证基线：`npm run types/lint/build` 全绿，vitest 38 passed，pytest 122 passed，ruff/mypy --strict/bandit 全绿。

## 已完成

### P0 修复（2026-08-13）

**策略演化器**（新增 `dca_sim.py`、`seeding.py`，重写 `walk_forward.py`）

- ~~**4/6 演化参数从未进入目标函数**~~ — 新增 `dca_sim.py` DCA 现金流仿真器，镜像 `trigger-engine.ts:43-109` 的 DEFER/SKIP/EXECUTE 分支。关键设计：**信号分类与阈值门控分离** —— `compute_signal_at` 仅凭价格结构判定 BSM 候选（`panic_ratio > 1`，无阈值），`bsm_threshold` 在 `compute_decision` 内决定 EXECUTE vs DEFER，恢复 TS 引擎语义。实测六参数全部改变目标函数（base Sharpe −0.042156）：`trigger_line` 1667→2167 Δ+0.001148（执行 26→20 次）、`ma_long_window` 60→80 Δ+0.002492、`bsm_threshold` 1.4→1.0 Δ+0.000512（执行日期改变）
- ~~**回测被截断到 ~110 个交易日**~~ — **原判断有误**：经实测 BaoStock 免费层对**所有 ETF**（511360/511880/510300/510500/515080/511010/511990）只给 2026-01-05 起 147 根 K 线，这是上游限制，不是下载失败。改用长历史**指数代理**回测：安全层 `000012` 上证国债指数（5732 根，2003 起）+ `000013` 上证企业债指数（5634 根）；`511360`/`511880` 保留为独立命名的 live-tradeable 常量仅用于执行。同时把尾部 `min()` 对齐换成显式**按日期 inner-join**
- ~~**交易成本量纲错误**~~ — 佣金改为执行时按真实成交金额收取 `max(notional × etf_bps/10000, etf_min_yuan)`（元），旧的每日摊销 `apply_transaction_costs_legacy` 已标注 legacy 且不在评分路径
- ~~**不可复现**~~ — 新增 `seeding.py` + `evolver.py --seed`（默认 42）统一 seed `random`/`numpy`/`torch`，seed 写入报告 `evolution_seed`；同 seed 两次运行结果逐字节一致
- ~~**优化器从未模拟真实策略**~~ — 月度定投入金、资金池在安全层生息、触发线判定、信号派生（MA 严格用 `[..t-1]`，长窗口不满则中性 NORMAL，零 lookahead）、TWR 单位化（入金日按当日净值发份额，消除资金加权污染）全部落地
- ~~**最小样本门槛过低**~~ — `MIN_OBS_FOR_*` 提到 63；`check_data_sufficiency` / `resolve_backtest_symbols` 数据不足时**报错并指名标的与 K 线数**，不再静默返回垃圾分数

**认证安全**（`functions/api/auth.ts`）

- ~~**OTP 用 `Math.random()`**~~ — 改 `crypto.getRandomValues`（Uint32 + 拒绝采样消除取模偏差）
- ~~**OTP 无频率限制**~~ — 每邮箱 60s 冷却 + 每小时 10 次上限（429）；验证失败 5 次后该码作废且不泄露区别。实测：REQ1 200 → REQ2 429；连错 5 次后正确码也返回 401
- ~~**OTP 单次使用竞态**~~ — `UPDATE otps SET used=1 WHERE id=? AND used=0` + 校验 `changes === 1`
- ~~**session token 明文入库且回传**~~ — 只存 SHA-256 hex（实测库内 `len=64`），响应体移除 `token`（实测 `HAS-TOKEN-IN-BODY: False`），`sessionMiddleware` 先哈希再查；`src/hooks/useAuth.ts` 类型守卫同步更新

**触发线一致性**

- ~~**`portfolio.ts:191` 硬编码 1667**~~ — 改走 `resolveActiveParams`（与 trigger engine 同源，含 PBO>0.5 拒绝、45 天过期、JSON 解析失败三级回退到 LCH，最终 fallback 1667）。实测：注入 `trigger_line=2222` 的演化报告后 `/api/portfolio` 返回 `trigger_line: 2222`；`TriggerProgress.tsx` 标题改渲染实际 prop、除零已守卫

**入口收敛**

- ~~**双 Hono 入口漂移**~~ — 删除 `_worker.js`，保留 typed `functions/api/[[route]].ts` 作为唯一入口（`export default { fetch, scheduled }`，路由挂 `/api/*`），`wrangler.toml` `main` 指向它；`package.json` 的 `pages:deploy`→`deploy`、删除 `pages:dev`；`start-dev.bat` 改用 `wrangler dev`。实测 `/api/health` 200、`/api/auth/me` 401（已挂载非 404）

**数据管道**（`scripts/symbols.ts` 新增为单一事实源）

- ~~**行情更新静默失败**~~ — 逐标的成功/失败追踪，任一失败→非零退出；空结果按 Asia/Shanghai 工作日区分：周末→exit 0（休市正常），工作日→报错 exit 1。workflow 通知改用 `gh issue create`（默认 `GITHUB_TOKEN`，未编造 secret）。实测：注入查询错误 EXIT_CODE=1、工作日空结果 EXIT_CODE=1、未知 flag `--bogus` EXIT_CODE=1
- ~~**无补数机制**~~ — 改按 D1 `SELECT symbol, MAX(date) GROUP BY symbol` 取每标的水位线，起点 = 最后日期 − 5 天重叠；无记录标的回落到 `1990-01-01` 全量。实测首跑 7 标的全量 26584 行（000012 5732 / 000013 5634 / 000300 5248 / 000905 5248 / 000922 4428 / 511360 147 / 511880 147），二次跑仅取 4 行且行数不变（幂等）
- ~~**时区**~~ — 生成的 Python 与 TS 日期逻辑全部走 `ZoneInfo("Asia/Shanghai")` / `asiaShanghaiToday()`
- ~~**标的清单三处重复**~~ — `scripts/symbols.ts` 统一 TS 侧（`bao-stock-setup.ts` + `daily-market-update.ts` 共用），含 BaoStock 历史限制注释防止后人"修复"短 ETF 序列
- ~~**`.dev.vars` 未忽略 / `.env.example` 缺变量 / workflow `--local` 不识别**~~ — 全部修好；`download.py` 硬编码绝对路径改相对

**测试与 CI**

- ~~**CI 不跑任何测试**~~ — `ci-verify.yml` 加入 `npm run test`（vitest）与 `pytest -q`，触发 paths 从「只有依赖文件」扩到 `src/**`、`functions/**`、`database/**`、`scripts/**`
- ~~**认证零测试覆盖**~~ — 新增 `functions/api/__tests__/auth.test.ts`（7 例：CSPRNG 路径、冷却 429、小时上限、尝试上限、已消费码拒绝、token 哈希存储 + 响应无 token、middleware 哈希匹配/裸 token 拒绝）
- ~~**`baostock` 不在依赖中**~~ — 加入 `pyproject.toml` 与 `requirements.txt`
- 新增迁移目录：`database/migrations/001_otp_attempts.sql`（`schema.sql` 是整体幂等重放，无法 ALTER 已有表；本地 dev D1 已执行）

### 更早完成

- ~~**卖出摩擦弹窗**：输入 `CONFIRM_SELL` 随机字符串确认机制~~ — `SellConfirmModal` + `TransactionForm` 集成
- ~~**月度对账页**：券商数据 vs 系统数据比对，差异 >1% 一键校准~~ — `/reconciliation` 页面 + `/api/reconciliation` API
- ~~**邮件通知系统**：策略演化器过期、执行建议通知邮件~~ — cron 定时检查（45 天过期，7 天去重）+ EXECUTE 决策异步邮件
- ~~**双层账户仪表盘**：安全层累计收益、抱负层份额可视化~~ — `LayerCharts`（ECharts 累计收益曲线 + 进取层份额环图）+ `/api/portfolio/layer-performance`
- ~~**资金池 LCH 切分**：每月充值资金池后的自动切分逻辑~~ — `/api/portfolio/deposit` + `DepositForm`（按演化参数/LCH 比例切分）
- ~~ErrorBoundary、Toast、骨架加载~~ — `ErrorBoundary` / `ToastProvider` / `DashboardSkeleton`
- ~~优化前端 UI 交互（更多动画、过渡效果）~~ — Motion 页面转场、卡片/列表交互、表单反馈、弹窗与 Toast 动画，支持 reduced motion

## 部署前必做（P0 修复引入的破坏性变更）

- [ ] **生产 D1 执行迁移**：`npx wrangler d1 execute alpha-life-prod --remote --env production --file=./database/migrations/001_otp_attempts.sql`。**不执行则 `/otp/verify` 因缺列 500**
- [ ] **所有现有 session 失效**：token 改存哈希，旧的明文 token 无法匹配 → 用户需重新登录（预期行为）
- [ ] **重新导入行情**：安全层新增 `000012`/`000013`，需跑一次 `market:update` 让生产 D1 拿到（本地 dev D1 已有）
- [ ] `scripts/local_evolver/api_client.py` 的 `TRACKED_SYMBOLS` 已含 000012/000013，但与 `scripts/symbols.ts` 仍是两份手写清单 —— 后续考虑从 API 或生成文件统一

## P1 重要改进

### 资金正确性

- [ ] **金额统一整数分存储与计算**：全库浮点 `round2` 累加产生误差（`portfolio.ts`、`transaction.ts`、`performance.ts`）；佣金 `Math.max(amount*0.0003, 5)` 尤其危险。展示层再除 100
- [ ] **佣金口径不一致**：`avg_price` 不含佣金（`transaction.ts:137-140`）但 `invested` 含佣金（`performance.ts:47`）→ 持仓成本与累计投入对不上。统一口径
- [ ] **买入补偿是第二笔非原子 batch**（`transaction.ts:216-244`）：两次 batch 之间崩溃会留"幽灵交易"。守卫条件写进同一 batch 或引入显式幂等/重试
- [ ] **充值无幂等/lost-update 竞态**（`portfolio.ts:241-262`）：先 SELECT 再 UPDATE 旧值+amount，并发/双击重复入账。加乐观锁或幂等键
- [ ] **`PUT /portfolio` 无校验**（`portfolio.ts:288-322`）：可设负余额、`total != safe + ambition`，且无审计日志。加校验 + 审计
- [ ] **trigger 接口信任客户端余额**（`trigger.ts:42-46`）：伪造 `current_balance` 可强制 EXECUTE 决策。服务端用 `portfolio.total_balance` 覆盖
- [ ] **交易日期按 UTC 分组**（`created_at` 为 UTC，北京 0-8 点交易落前一天）：与 `market_data.date`（北京交易日）错位。落库/分组改用 Asia/Shanghai

### 数据管道（P0 已修主要缺陷，剩余）

- [ ] **scheduled cron 不含市场数据更新**（`[[route]].ts` 的 scheduled 只调 notifications）→ 行情仍需手动 `market:update`。把数据更新接入 scheduled
- [ ] **`market:init` 名不符实**：`package.json` 只下载 CSV + 建表，不导入 D1（导入是独立的 `database:import-market`）；README 声称"下载全量历史 + 导入"错误
- [ ] **无交易日历**：当前用 Asia/Shanghai 工作日近似判断休市，中国法定节假日（春节等）会误报失败；无缺失日检测
- [ ] **无 OHLC 合法性校验**（close>0、high≥low、7 标的全返回）
- [ ] 删除残留 CSV（sh_510300/510500/515080，不在当前清单）

### 演化器方法论（P0 已修致命项，剩余）

- [ ] **代理指数假设需评估**：回测安全层用债券**指数** 000012/000013，无基金费用/跟踪误差/买卖价差；进取层同样用指数而非可交易 ETF。BaoStock 免费层拿不到 ETF 长历史 → 要么接受偏差并量化、要么换数据源
- [ ] **A 股交易规则未建模**：T+1 交割（`simulate_dca` 用当日余额执行）、100 股整手、涨跌停、货币基金申赎 T+1 到账、ETF 折溢价
- [ ] **MPT 均值/协方差全样本 lookahead**（`mpt.py:27-79`）：权重在已知未来的统计量上优化。改在各训练折内估计
- [ ] **walk-forward 无 purge/embargo**：等分块 + train/test 紧邻。改 expanding/滚动 + 间隔；与 CPCV 的收益模型统一（价格加权 vs 收益加权不等价）
- [ ] **regime 是摆设且有顺序 bug**：`compute_regime_blended_frontier` 为死代码，`regime_probs`（未映射）与 `regime_covs`（映射+平滑）语义错乱（`regime.py:205-275`）。要么接入优化，要么删除
- [ ] **bootstrap 误用**：对 MC 期末横截面做 block bootstrap 无意义（`report.py:170-183`）；DSR 是启发式近似；PBO 用 `num_params/2` 非标准。修正或标注局限
- [ ] **stability 扰动破坏约束**：对 `safe_ratio`/`ambition_ratio` 独立扰动破坏 sum=1，测的是"加杠杆"
- [ ] **GBM 漂移用全样本日均收益×252**（`monte_carlo.py:295`）；max_dd 取单条最差路径 → 用稳健分位数
- [ ] **执行次数受流动性上限饱和**：默认月供下执行次数触顶，`bsm_threshold` 只改变执行**时点**而非次数 —— 是建模选择，但需在报告中说明
- [ ] `cpcv.py:77` 除零 RuntimeWarning（pytest 中可见）

### 后端功能空白

- [ ] **无分红/除权处理**：positions 不随除权调整、BaoStock 不复权 → 长期收益失真。加股息记录 + 复权
- [ ] **无已实现盈亏落库**：卖出时不计 realized P&L，无法对账审计
- [ ] **演化权重数组被丢弃**：`safe_allocation`/`ambition_allocation` 已解析（`lch-utils.ts:93-94`）但从未用于选标的；`getNextSafeETF` 恒返回主 ETF（`trigger-engine.ts:32-34` 是 stub）→ 落地多标的轮换或删除
- [ ] **无分页**：交易列表只有 limit 无 offset、组合页硬编码 `LIMIT 10`、对账 `LIMIT 24`、行情无过滤
- [ ] **无审计日志表**、无备份/导出端点、交易无幂等键
- [ ] `src/types/api.ts` 的 `AuthSession` 仍声明 `token`（已无人读取）→ 清理

### 测试覆盖（P0 已把测试接入 CI，剩余）

- [ ] **FakeD1 只按 `sql.includes` 返回预设值**：不校验 SQL 语义，测试通过 ≠ SQL 正确。补真实 D1 集成测试
- [ ] 无并发/时区/浮点守恒/IDOR 测试；`strategy.ts`、`market-data.ts`、notifications cron 无测试

## P2 改进与体验

### 前端

- [ ] **修复 `useActiveAllocation` 重复请求 + 竞态**：`StrategyEvolutionBar.tsx:36` 与 `DepositForm.tsx:19` 各自裸 fetch 同一接口；abort 后 `finally` 仍置 loading false（`useActiveAllocation.ts:46`）。改用 React Query 共享缓存
- [ ] **持仓列表补盈亏**：`Position` 类型已有 `current_price`/`market_value`，`PositionsList` 只显示 shares/avg_price
- [ ] **组合净值曲线**：补"总资产/累计入金/累计盈亏"历史趋势（定投复利核心可视化缺失）
- [ ] **Settings 死代码 + 时区 bug**：`Settings.tsx:60` 日期校验恒 false（`month-1` 恒等抵消）；`new Date('YYYY-MM-DD')` UTC 解析配本地读取差一天；`getTodayString`/`currentMonth` 用 `toISOString()`（UTC）
- [ ] **统一 401 处理**：`usePortfolio` 识别 401 停 retry，但 `useReconciliation`/`useActiveAllocation`/`Settings` 不识别
- [ ] **佣金/常量统一引用 `TRIGGER_CONSTANTS`**：`TransactionForm.tsx:64/71` 等硬编码 `Math.max(amount*0.0003, 5)`，多处漂移
- [ ] **无障碍**：Toast 无 `role="status"`/`aria-live`；SellConfirmModal 无焦点陷阱/Escape/焦点还原；tab 无 aria-controls/键盘导航；Login 倒计时 interval、Toast timeout 未清理
- [ ] **数字格式化统一**：`Intl.NumberFormat` 千分位；`TriggerProgress.tsx:26` 整数/两位小数混用；`DepositForm` 预览未 `round2` 与后端拆分差 1 分
- [ ] **交易历史管理**：分页/筛选/纠错/CSV 导出缺失；`daysSince === 999` 哨兵前后端魔法数耦合（`StrategyEvolutionBar.tsx:133`）
- [ ] **打包瘦身**：ECharts 全量引入（改 `echarts/core` 按需）、无路由级代码分割（`React.lazy`）、`date-fns` 声明未用
- [ ] **移动端适配**：表格 `overflow-x-auto`、图表固定高度 256px（`LayerCharts.tsx:119/141`）、`notMerge` 每次重渲染重建图表

### 工程与运维

- [ ] **生产配置全是占位符**：`wrangler.toml`（yourdomain.com）、CORS、`email.ts:4` `no-reply@alpha-life.yourdomain.com`（Resend 未验证域名发信必失败）→ 真实域名 + 环境变量
- [ ] **版本化迁移**：`schema.sql` 仍是整体幂等重放；已开出 `database/migrations/`，但缺迁移记录表与自动执行器（当前靠人手跑编号文件）
- [ ] **D1 无备份**：加定时 `wrangler d1 export` 到对象存储 + 行数/容量监控；sessions/otps 表只增不清理
- [ ] **文档漂移**：README/ARCHITECTURE 写 `local-evolver`（实际 `local_evolver`）；EVOLVER.md 依赖版本（torch 2.5.1 vs 2.13）、`data.py` 不存在、`PATCH /api/strategy/report` 与实现（`POST /api/strategy/reports`）不符；`baoStock:update` 实为全量与 setup 相同；README 仍写 `npm run pages:deploy`（已改名 `deploy`）；`requirements.txt` 与 `pyproject.toml` 双源并存
- [ ] **evolver 工程债**：`config.yaml` 与 `EvolverConfig` 双事实源（CLI 默认值恒覆盖 yaml，`--gbm-paths` 10000 vs yaml 5000）；NaN→null、±inf→±1e308 序列化掩盖异常

## 产品路线图（评审后的未来方向）

1. ~~**真实策略仿真引擎（最高优先）**~~ — **P0 已完成**：`dca_sim.py` 落地余额/月度入金/触发线/信号/安全层生息，与 `trigger-engine.ts` 分支语义对齐。下一步是在此之上做纸面交易（paper trading）对照
2. **已实现盈亏 + 分红/除权 + T+1/100 股整手等 A 股规则**，月度对账才能真正闭环（仿真器目前仍无 T+1 与整手约束）
3. **组合净值历史页面**：总资产/入金/盈亏曲线 + 每笔触发决策的时间线标注
4. **交易历史管理**：分页、筛选、纠错、CSV 导出（报税/留档）
5. **设置页扩展**：触发线查看/配置入口、通知偏好、行情新鲜度提示与手动刷新
6. **多标的轮换落地**：safe/ambition 权重数组实际驱动选基（当前是 stub）
7. **通知闭环**：成交确认、对账异常、余额不足提醒；EXECUTE 建议 → 一键确认执行链路
8. **数据安全保障**：D1 定期备份、审计日志、会话管理（查看/撤销设备）
9. **交易日历 + 缺失检测**：假日跳过（当前仅按工作日近似）、断更自动告警；多数据源冗余（BaoStock 免费层拿不到 ETF 长历史，是当前最大数据瓶颈）
10. **参数不确定性可视化**：walk-forward 参数漂移图、触发线敏感性区间（P0 已让参数真正生效且可复现，此项现在有意义了；但需先修 P1 的 purge/embargo 与 MPT lookahead）
11. **移动端适配与离线缓存**：React Query 持久化，低网速可用
12. **季度策略报告生成**：把 evolver 报告渲染成前端可读的季度回顾页（替代邮件里的 raw JSON）