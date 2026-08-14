# Alpha-Life Engine TODO

> 2026-08-14 状态：**P0 修复 + 真实 ETF 宇宙切换全部完成并已推送 main**（985e1c7..eabbe84，12 commits）。部署前必做项全部完成（生产迁移已执行、session 已失效、生产行情已切换为新 6 ETF 宇宙）。
>
> 验证基线：`npm run types/lint/build` 全绿，vitest 42 passed，pytest 122 passed，ruff/mypy --strict/bandit 全绿；本地与生产 D1 数据一致（6 ETF 共 16,226 行，最新 2026-08-13）。

## 已完成

### P0 修复（2026-08-13）

**策略演化器**（新增 `dca_sim.py`、`seeding.py`，重写 `walk_forward.py`）

- ~~**4/6 演化参数从未进入目标函数**~~ — 新增 `dca_sim.py` DCA 现金流仿真器，镜像 `trigger-engine.ts:43-109` 的 DEFER/SKIP/EXECUTE 分支。信号分类与阈值门控分离（`compute_signal_at` 仅凭价格结构判定 BSM 候选，`bsm_threshold` 在 `compute_decision` 内决定 EXECUTE vs DEFER）。实测六参数全部改变目标函数（base Sharpe −0.042156）：`trigger_line` 1667→2167 Δ+0.001148、`ma_long_window` 60→80 Δ+0.002492、`bsm_threshold` 1.4→1.0 Δ+0.000512
- ~~**回测被截断到 ~110 个交易日**~~ — 原用长历史**指数代理**（000012/000013 等）解决 BaoStock 免费层仅给 147 根 K 线的限制；**该方案已被 2026-08-14 宇宙切换取代**（见下节），历史注记保留
- ~~**交易成本量纲错误**~~ — 佣金改为执行时按真实成交金额收取 `max(notional × etf_bps/10000, etf_min_yuan)`（元）
- ~~**不可复现**~~ — 新增 `seeding.py` + `evolver.py --seed`（默认 42）统一 seed，同 seed 两次运行逐字节一致
- ~~**优化器从未模拟真实策略**~~ — 月度定投入金、资金池安全层生息、触发线判定、MA 严格 `[..t-1]` 零 lookahead、TWR 单位化全部落地
- ~~**最小样本门槛过低**~~ — `MIN_OBS_FOR_*` 提到 63；数据不足时报错并指名标的与 K 线数

**认证安全**（`functions/api/auth.ts`）

- ~~**OTP 用 `Math.random()`**~~ — 改 `crypto.getRandomValues`（Uint32 + 拒绝采样）
- ~~**OTP 无频率限制**~~ — 60s 冷却 + 每小时 10 次上限（429）；连错 5 次后码作废。实测 REQ1 200 → REQ2 429；连错 5 次后正确码 401
- ~~**OTP 单次使用竞态**~~ — `UPDATE otps SET used=1 WHERE id=? AND used=0` + `changes===1`
- ~~**session token 明文入库且回传**~~ — 只存 SHA-256 hex（库内 len=64），响应移除 token，middleware 先哈希再查

**触发线一致性**

- ~~**`portfolio.ts:191` 硬编码 1667**~~ — 走 `resolveActiveParams`（PBO>0.5 拒绝、45 天过期、三级回退 LCH→1667）。实测注入 `trigger_line=2222` 后 `/api/portfolio` 返回 2222

**入口收敛**

- ~~**双 Hono 入口漂移**~~ — 删除 `_worker.js`，唯一入口 `functions/api/[[route]].ts`（路由挂 `/api/*`）；实测 `/api/health` 200、`/api/auth/me` 401

**数据管道与测试/CI**

- ~~**行情更新静默失败 / 无补数机制 / 时区 / 标的清单三处重复 / `.dev.vars` 未忽略**~~ — `scripts/symbols.ts` 成为 TS 侧单一事实源；高水位 + 5 天重叠补数；Asia/Shanghai 统一；`ci-verify.yml` 接入 vitest + pytest；新增 `auth.test.ts`（7 例）与迁移目录 `database/migrations/001_otp_attempts.sql`
- ~~**`baostock` 不在依赖中**~~ — 已加后又于 2026-08-14 随宇宙切换移除，改入 `akshare`（见下节）

### 真实 ETF 宇宙切换（2026-08-13/14，方向 A 用户裁决）

- ~~**代理指数假设（000012/000013 等）与真实可交易标的的偏差**~~ — 回测宇宙整体切换为 6 只真实 ETF：safe `511360 海富通短融 / 511880 银华日利 / 511990 华宝添益`，ambition `510300 沪深300ETF / 510500 中证500ETF / 515080 中证红利ETF`；数据源 BaoStock → AKShare 新浪（`fund_etf_hist_sina`；东财源本网络 1/4 成功率已弃用）
- ~~**管道三处重复实现**~~ — 新增共享抓取模板 `scripts/akshare-fetch.ts`（CSV 列序 `date,code,open,high,low,close,volume,amount`），`daily-market-update.ts`（增量）与 `market-setup.ts`（全量，原 `bao-stock-setup.ts` 更名）共用
- ~~**evolver/API/前端未同步宇宙**~~ — `walk_forward.py`/`api_client.py`/`models.py`/`config.yaml`/`conftest.py`、`functions/api/symbols.ts`、`TransactionForm.tsx` 全部同步 6 ETF；修复 evolver base URL 真 bug（缺 `/api` 前缀，生产演化会 404）；前端 ambition 下拉不再指向已删除的指数
- ~~**依赖与 CI 未跟进**~~ — `pyproject.toml`（`akshare>=1.17,<2` + mypy ignore_missing_imports override）、`requirements.txt`（`akshare==1.17.5`）、CI workflow 同步
- ~~**数据迁移**~~ — 本地与生产 D1 均已重建为 6 ETF 全历史（16,226 行，与 spec 预测逐日吻合）；生产旧指数行 26,290 条已删；生产货币 ETF 部分历史（148 行）已用 `market:setup` + `database:import-market:prod` 回补完整；幂等验证通过
- 已知权衡（已记录于 spec）：新浪源**不复权**（分红缺失，长持有收益偏低）；货币 ETF 历史短于指数代理（511360 仅 2020-09 起，回测窗口由最短标的决定）

### 部署前必做（2026-08-13/14 全部完成）

- ~~**生产 D1 执行迁移 001_otp_attempts.sql**~~ — 已执行，`otps.attempts` 列确认存在
- ~~**所有现有 session 失效**~~ — `DELETE FROM sessions` → 0 行，用户需重新登录
- ~~**重新导入行情**~~ — 生产已切换为新 6 ETF 宇宙（16,226 行），非原计划的 000012/000013 增补
- ~~**api_client.TRACKED_SYMBOLS 与 scripts/symbols.ts 对齐**~~ — T4 已同步并核验一致（仍为两份手写清单，见 P2 工程债）

### 更早完成

- ~~卖出摩擦弹窗 / 月度对账页 / 邮件通知 / 双层账户仪表盘 / 资金池 LCH 切分 / ErrorBoundary·Toast·骨架 / 前端动效优化~~

### P1 资金与安全正确性（2026-08-14，整数分重构 0e39ee4..全套落地）

- ~~**金额统一整数分存储与计算**~~ — 全链路改整数分：`Transaction.commission`/`amount`、`Portfolio` 各余额均为整数分；展示层再除 100。佣金 `COMMISSION_MIN_CENTS=500` 整数计算
- ~~**佣金口径不一致**~~ — `avg_price` 与 `invested` 均改为含佣口径（integer cents），持仓成本与累计投入对齐
- ~~**买入补偿是第二笔非原子 batch**~~ — 守卫条件并入同一 batch，消除两 batch 间崩溃的"幽灵交易"
- ~~**充值无幂等/lost-update 竞态**~~ — 充值改为原子幂等入账，消除并发/双击重复入账
- ~~**`PUT /portfolio` 无校验**~~ — 移除无校验的 `PUT /api/portfolio`（无调用方，破坏性变更已记录）
- ~~**trigger 接口信任客户端余额**~~ — 服务端用 `portfolio.total_balance` 覆盖客户端 `current_balance`，trigger 引擎改整数分运算
- ~~**交易日期按 UTC 分组**~~ — 落库/分组改用 Asia/Shanghai 交易日（`tradeDateShanghai`），performance/reconciliation 统一
- ~~**无已实现盈亏落库**~~ — 卖出计入 `realized_pnl`（整数分），新增 backfill 脚本 `backfill-realized-pnl`

## 待办（按优先级分级）

> 分级口径：**P1** = 账目正确性或决策质量直接受损（钱错了 / 回测结论不可信）；**P2** = 工程与运维缺口（含 ⚡ 单点小改动，可随时顺手修）；**P3** = 体验与长期债。路线图见文末。

### P1 资金与安全正确性

- ~~**金额统一整数分存储与计算**~~：全库浮点 `round2` 累加误差（`portfolio.ts`、`transaction.ts`、`performance.ts`）；佣金 `Math.max(amount*0.0003, 5)` 尤险。展示层再除 100
- ~~**佣金口径不一致**~~：`avg_price` 不含佣金（`transaction.ts:137-140`）但 `invested` 含佣金（`performance.ts:47`）→ 持仓成本与累计投入对不上
- ~~**买入补偿是第二笔非原子 batch**~~（`transaction.ts:216-244`）：两 batch 之间崩溃留"幽灵交易"。守卫条件并入同一 batch 或加幂等/重试
- ~~**充值无幂等/lost-update 竞态**~~（`portfolio.ts:241-262`）：先 SELECT 再 UPDATE，并发/双击重复入账。加乐观锁或幂等键
- ~~**`PUT /portfolio` 无校验**~~（`portfolio.ts:288-322`）：可设负余额、`total != safe + ambition`，无审计日志
- ~~**trigger 接口信任客户端余额**~~（`trigger.ts:42-46`）：伪造 `current_balance` 可强制 EXECUTE。服务端用 `portfolio.total_balance` 覆盖
- ~~**交易日期按 UTC 分组**~~（`created_at` UTC vs `market_data.date` 北京交易日错位）：落库/分组改用 Asia/Shanghai
- ~~**无已实现盈亏落库**~~：卖出不计 realized P&L，无法对账审计

### P1 回测方法学（决策质量）

- [ ] **A 股交易规则未建模**：T+1 交割（`simulate_dca` 用当日余额执行）、100 股整手、涨跌停、货币基金申赎 T+1、ETF 折溢价
- [ ] **MPT 均值/协方差全样本 lookahead**（`mpt.py:27-79`）：权重在已知未来的统计量上优化。改在各训练折内估计
- [ ] **walk-forward 无 purge/embargo**：等分块 + train/test 紧邻。改 expanding/滚动 + 间隔；与 CPCV 收益模型统一
- [ ] **regime 是摆设且有顺序 bug**（`regime.py:205-275`）：`compute_regime_blended_frontier` 死代码，`regime_probs`/`regime_covs` 语义错乱。接入优化或删除
- [ ] **bootstrap 误用**（`report.py:170-183`）：对 MC 期末横截面 block bootstrap 无意义；DSR 启发式近似；PBO `num_params/2` 非标准。修正或标注局限
- [ ] **stability 扰动破坏约束**：对 `safe_ratio`/`ambition_ratio` 独立扰动破坏 sum=1，测的是"加杠杆"
- [ ] **GBM 漂移用全样本日均收益×252**（`monte_carlo.py:295`）；max_dd 取单条最差路径 → 用稳健分位数
- [ ] **回测窗口由最短标的决定（~1,420 天）**：货币 ETF 511360 仅 2020-09 起（1,423 行），进取层 515080 仅 2019-12 起（1,605 行）——较指数代理时代（4,400+ 天）缩短。要么接受（现状）并在报告中量化，要么另找长历史源补早期数据
- [ ] **执行次数受流动性上限饱和**：默认月供下 `bsm_threshold` 只改变执行时点而非次数——建模选择，需在报告中说明
- [ ] ⚡ **`cpcv.py:77` 除零 RuntimeWarning**（pytest 中可见）：补齐样本不足分支

### P2 数据管道与后端

- [ ] **scheduled cron 不含市场数据更新**：`[[route]].ts` 的 scheduled 只调 notifications → 行情需手动 `market:update`。把数据更新接入 scheduled
- [ ] **`market:init` 名不符实**：`package.json:18` 只跑 `market:setup && database:migrate`，不导入 D1；README.md:117/205 声称"下载全量历史 + 导入"错误。改脚本链或改文案
- [ ] **无交易日历**：当前按 Asia/Shanghai 工作日近似，法定节假日（春节等）误报失败；无缺失日检测
- [ ] **无 OHLC 合法性校验**（close>0、high≥low、6 标的全返回）
- [ ] ⚡ **删除残留指数 CSV**：`data/market_data/sh_000012.csv`、`sh_000013.csv`、`sh_000300.csv`、`sh_000905.csv`、`sh_000922.csv`（旧宇宙残留，不在当前清单；原 TODO 项里的 sh_510300/510500/515080 现已在新宇宙中，属正常文件）
- [ ] **无分红/除权处理**：新浪源不复权（已接受并记录局限），positions 也不随除权调整 → 长期收益失真。加股息记录 + 复权
- [ ] **演化权重数组被丢弃**（多标的轮换）：`safe_allocation`/`ambition_allocation` 解析后从未用于选标的；`getNextSafeETF` 恒返回主 ETF（`trigger-engine.ts:32-34` stub）；`lch-utils.ts:94` 死回退仍指向已删除的 `000300`；`src/types/api.ts` `ETF_CONSTANTS` 缺 511990。一并落地轮换或删除死代码
- [ ] **无分页**：交易列表只有 limit 无 offset、组合页硬编码 `LIMIT 10`、对账 `LIMIT 24`
- [ ] **无审计日志表、无备份/导出端点、交易无幂等键**
- [ ] ⚡ **`src/types/api.ts` `AuthSession` 仍声明 `token`**（已无人读取）→ 清理

### P2 测试与工程

- [ ] **FakeD1 只按 `sql.includes` 返回预设值**：不校验 SQL 语义，测试通过 ≠ SQL 正确。补真实 D1 集成测试
- [ ] 无并发/时区/浮点守恒/IDOR 测试；`strategy.ts`、`market-data.ts`、notifications cron 无测试
- [ ] **evolver 工程债**：`config.yaml` 与 `EvolverConfig` 双事实源（CLI 默认值恒覆盖 yaml）；NaN→null、±inf→±1e308 序列化掩盖异常
- [ ] **TS/Python 符号清单双事实源**：`scripts/symbols.ts` 与 `api_client.TRACKED_SYMBOLS` 已人工对齐，仍是两份手写清单。统一为生成文件或从 API 读取
- [ ] ⚡ **`docs/DATABASE.md:99` 仍写 "data from BaoStock"** → 改 AKShare Sina
- [ ] **CI 环境依赖漂移**：`daily-market-update.yml` 用裸 `pip install akshare pandas`（非 `-e ".[dev]"`），与 pyproject 版本约束可能不一致
- [ ] **文档漂移剩余**：EVOLVER.md 依赖版本与 `data.py` 不存在、`PATCH /api/strategy/report` vs 实现 `POST /api/strategy/reports`、`requirements.txt` 与 `pyproject.toml` 双源并存
- [ ] ⚡ **演化 efficient-frontier 两个 numpy RuntimeWarning**（"Degrees of freedom <= 0"、"invalid value in scalar divide"，预存问题）：数据不足时显式报错而非警告后算垃圾值

### P3 前端体验与运维

- [ ] **`useActiveAllocation` 重复请求 + 竞态**（`StrategyEvolutionBar.tsx:36`、`DepositForm.tsx:19` 各自裸 fetch；abort 后 `finally` 仍置 loading）：改 React Query 共享缓存
- [ ] **持仓列表补盈亏**：`PositionsList` 只显示 shares/avg_price
- [ ] **组合净值曲线**：总资产/累计入金/累计盈亏历史趋势（定投复利核心可视化缺失）
- [ ] **Settings 死代码 + 时区 bug**（`Settings.tsx:60` 校验恒 false；UTC 解析差一天；`getTodayString` 用 `toISOString`）
- [ ] **统一 401 处理**：`usePortfolio` 识别 401，`useReconciliation`/`useActiveAllocation`/`Settings` 不识别
- [ ] **佣金/常量统一引用 `TRIGGER_CONSTANTS`**（`TransactionForm.tsx:64/71` 硬编码 `Math.max(amount*0.0003, 5)`）
- [ ] **无障碍**：Toast 无 `aria-live`；SellConfirmModal 无焦点陷阱/Escape；tab 无键盘导航；interval/timeout 未清理
- [ ] **数字格式化统一**：`Intl.NumberFormat` 千分位；`TriggerProgress.tsx:26` 混用；`DepositForm` 预览与后端拆分差 1 分
- [ ] **交易历史管理**：分页/筛选/纠错/CSV 导出；`daysSince === 999` 哨兵魔法数耦合
- [ ] **打包瘦身**：ECharts 按需（`echarts/core`）、路由级代码分割、`date-fns` 声明未用
- [ ] **移动端适配**：表格横向滚动、图表固定高度 256px、`notMerge` 每次重渲染重建
- [ ] **生产配置占位符**：`wrangler.toml`（yourdomain.com）、CORS、`email.ts:4` `no-reply@alpha-life.yourdomain.com`（Resend 未验证域名必失败）→ 真实域名 + 环境变量
- [ ] **版本化迁移**：缺迁移记录表与自动执行器（当前人手跑编号文件）
- [ ] **D1 无备份**：定时 `wrangler d1 export` + 行数监控；sessions/otps 只增不清理

## 产品路线图（长期）

1. **纸面交易对照**：真实策略仿真引擎已落地（P0），下一步纸面交易（paper trading）与演化预测对照
2. **月度对账闭环**：已实现盈亏 + 分红/除权 + T+1/整手（后两者在 P1 待办）落地后，对账才能真正闭环
3. **组合净值历史页面**：总资产/入金/盈亏曲线 + 每笔触发决策时间线标注
4. **交易历史管理**：分页、筛选、纠错、CSV 导出（报税/留档）
5. **设置页扩展**：触发线查看/配置入口、通知偏好、行情新鲜度提示与手动刷新
6. **多标的轮换落地**：safe/ambition 权重数组实际驱动选基（当前 stub，见 P2）
7. **通知闭环**：成交确认、对账异常、余额不足；EXECUTE 建议 → 一键确认执行
8. **数据安全保障**：D1 定期备份、审计日志、会话管理（查看/撤销设备）
9. **交易日历 + 缺失检测 + 数据冗余**：假日跳过（当前仅工作日近似）、断更告警；数据源为 AKShare 新浪**单点**（东财源本网络 1/4 成功率已弃用）——多源冗余是最大数据风险
10. **参数不确定性可视化**：walk-forward 参数漂移图、触发线敏感性区间（需先修 P1 的 purge/embargo 与 MPT lookahead）
11. **移动端适配与离线缓存**：React Query 持久化
12. **季度策略报告生成**：evolver 报告渲染为前端季度回顾页（替代邮件 raw JSON）
