# Alpha-Life Engine TODO

> 2026-08-14 状态：**P0 修复 + 真实 ETF 宇宙切换全部完成并已推送 main**（985e1c7..eabbe84，12 commits）。部署前必做项全部完成（生产迁移已执行、session 已失效、生产行情已切换为新 6 ETF 宇宙）。
>
> 验证基线：`npm run types/lint/build` 全绿，vitest 42 passed，pytest 122 passed，ruff/mypy --strict/bandit 全绿；本地与生产 D1 数据一致（6 ETF 共 16,226 行，最新 2026-08-13）。
>
> 2026-08-17 状态：P1 回测方法学 10 项全部完成（A股规则/T+1/整手/涨停/折溢价、MPT 逐折估计、WF purge/embargo、regime 死代码删除、bootstrap 修复、stability 联合扰动、MC 252日窗口+5%分位数、回测窗口延至 2013-04、执行次数饱和文档化、cpcv 除零守卫）。
>
> 2026-08-21 状态：**P2 数据管道与后端全部完成**（b0d4701..d02f56b，20 commits 合并回 main）。含外部评审修复波：request_nonce 批内判别子（迁移 005）、dividends 白名单、fetch 超时、全仓卖出回款修复（预存缺陷，node:sqlite 实证）。验证基线：types/lint/build 全绿，vitest 133 passed / 18 files。
>
> 2026-08-22 状态：**全库四线审计完成**（后端 API / 前端 / 演化器 / 管道与配置）。新增 1 个 P0（现金分红不加 total_balance）、7 个 P1、P2/P3 若干，见下方各「2026-08-22 审计」小节。关键 P1 均经实证复现：zod 拒绝 naive 时间戳（项目 zod 4.4.3 实测）、CPCV 折塌缩（seed 42 实测只存活 2 折同窗）、formatCents 负号丢失、交易批次绝对值覆写。

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

### P0 账目正确性（2026-08-22 审计）

- [ ] **现金分红只加层级余额、不加 `total_balance`**（`functions/api/dividends.ts:68-71`）：充值（三层同加）、买卖（层与总额同减）处处维持 `total = safe + ambition`，唯独 cash 分红的 UPDATE 只写 `${layer}_layer_balance = ... + ?`。后果：① 触发线判断读 `portfolio.total_balance`（`trigger.ts:54-59`），分红现金永久不可见 → 余额低估、错过触发；② `reconciliation.ts:86` 的 `systemTotal = total_balance + holdingsValue` 同样低估 → 每次分红后必然产生假差异（PENDING），诱导用户做本不需要的一键校准；③ 前端层余额之和 ≠ 总余额。修：同 delta 一并 `total_balance = total_balance + ?`

### P1 资金与展示正确性（2026-08-22 审计）

- [ ] **交易批次用批前快照的绝对值覆写 portfolio/positions → 丢失更新**（快照 `transaction.ts:128-137`，绝对值 UPDATE `:233-241`（买入）/`:319-337`（卖出）、持仓 `shares = ?` `:210-216`）：WHERE 守卫（余额充足 + BATCH_TXN_GUARD）只防**同幂等键**重复，不防**不同幂等键并发**；SELECT 与 batch 之间隔多个 await（查持仓、查幂等键、resolveActiveParams），窗口很宽。双开标签页记录两笔不同交易、或交易与充值并发时：A、B 都读到同一快照，后提交者用旧快照绝对值覆写 → 两笔交易都入账但现金只扣一次（凭空造钱），反向则钱凭空消失；若并发全仓卖出先 DELETE 了持仓行，买入的 `UPDATE positions` 匹配 0 行静默无操作（交易与扣款落库、持仓凭空消失）。deposit 端点（相对 `+ ?`）与卖出持仓（相对 `shares - ?` + 守卫）是正确范式，仅此处不一致。修：改相对增量写法，余额守卫保留在 WHERE
- [ ] **`formatCents` 丢负号：卖出亏损金额显示为正数**（根因 `src/lib/money.ts:13-14`，唯一漏传点 `RecentTransactions.tsx:74`）：`opts.sign` 未传时 prefix 恒 `''` 且 `Math.abs` 吞负号 → `formatCents(-10000)` 显示 "¥100.00"。全库唯一负值无符号渲染点（variance/cumulative_gain 均已传 `sign: true`），用户只能靠颜色分辨盈亏。修：该处传 `{ sign: true }` 或让 formatCents 默认保留负号
- [ ] **演化报告时间戳被 zod `.datetime()` 拒绝 → 推送上云必 400，整轮演化结果丢弃**（`report.py:114` `datetime.now().isoformat()` 无时区 vs `strategy.ts:53-54`）：已用项目 zod 4.4.3 实测 naive 时间戳 `safeParse(...).success === false` → 服务端 400 → `push_report_to_cloud` 返回 `{"success": false}` → `evolver.py:180` `sys.exit(1)`，而报告从不本地落盘 → 数小时演化产物丢失（意味着该链路从未成功过）。修：输出 UTC 带 `Z`，且推送前先原子写本地 JSON

### P1 演化器报告数值失真（2026-08-22 审计）

- [ ] **CPCV 折叠生成塌缩：配置 10 splits 实际只存活 2 折且测试窗完全相同**（`cpcv.py:56-67`）：非连续测试组用 `min/max` 折叠成连续区间，`embargoed_test_start` 越界被夹后 `test_start > test_end` 被 `>= 5` 条件静默丢弃。实测（seed 42、total_obs=3295、10 组、10 splits）只存活 2 折、test 均为 `[2966, 3289]`——`cpcv_splits: 10` 配置被静默忽略，OOS 统计退化为单窗口 → `max_sharpe_portfolio.cpcv_result`、`sharpe_distribution`、DSR 全部失真。修：test 取所选组并集（可非连续），train 围绕每个测试组做 purge/embargo
- [ ] **CPCV 逐折 Sharpe 用年化无风险利率直接减日频收益均值**（`mpt.py:387`，同文件 `:135` 正确用法是 `rf/252.0`）：实测日均值 2bp/日波 40bp 的组合得 Sharpe −6.12（正确 −0.01），其上 DSR 恒 0 → 报告 `max_sharpe_portfolio.sharpe_ratio`（被赋值为 cpcv.dsr）数值失真
- [ ] **`bootstrap_ci` 的 max_drawdown 在日收益率序列上算回撤而非净值曲线**（`dsr.py:252-258`）：对收益率矩阵 `np.maximum.accumulate` 量度的是"当日收益距历史最佳单日收益的距离"；实测真实最大回撤 0% 的序列报 mean "max_drawdown" −52.8% → `bootstrap_result.max_drawdown.ci_95/ci_99` 是虚构数字，尾部风险预警不可用。修：先 `np.cumprod(1+b)` 复权成净值再算 peak/trough
- [ ] **`config.dca` / `config.transaction_costs` 从未传入优化主链路**（`report.py:173-185` WF 漏 `dca_config`；`:202-222` stability 两者都漏；`:319-325` Sobol；`:381-399` drift 连 cost 也漏；仅 bootstrap 传了 `config.dca`）：全部回落 `DcaConfig()` 默认 1000 元/21 天 → 改 yaml 月供/佣金后，推荐参数的**选择过程**用旧默认、报告的 bootstrap CI 用新值，同一报告两套仿真配置。修：四处调用统一传 `config.dca`（Sobol/drift 补 `config.transaction_costs`）

### P2 后端健壮性（2026-08-22 审计）

- [ ] **首登 user 与 portfolio 两跳写入非原子**（`auth.ts:241-248`）：第二条 INSERT 瞬时失败（D1 抖动）后 user 已落库，此后每次登录走 else 分支不再补建 portfolio → `POST /transactions` 永远 400 且提示"请重新登录"误导（重登无法修复）。修：合并为一个 `db.batch` 或 portfolio 改 `INSERT OR IGNORE` 每次登录幂等补建
- [ ] **`sendEmail` 的 fetch 无超时，cron 通知可被单点挂起**（`email.ts:16-23`，对照 `market-update.ts:21-27` 已有 10s AbortController）：`notifications.ts:33-57` 按用户顺序 await，一个挂起的 Resend 连接不是异常（try/catch 接不住），会占住整个 cron 调用直到 15 分钟上限，当天后续用户通知全部丢失
- [ ] **演化 safe/ambition 比例不归一，EXECUTE 建议金额可超执行总额**（`lch-utils.ts:106-107` 各自独立 clamp 无 sum=1 约束、`trigger-engine.ts:96-98` 分别相乘）：异常报告 0.9/0.9 时建议邮件中两层合计 = 1.8×执行金额；而 `splitDepositCents` 只用 safeRatio、进取层取余数永远 sum=1——同组比例两条路径行为不一致。修：解析报告时归一化，两路径共用同一拆分函数
- [ ] OTP verify 不复核白名单 + 频控先查后插 TOCTOU（`auth.ts:204-236` verify 全程不查 email_whitelist；`:171-193` 冷却检查非原子）：移出白名单的已发码 10 分钟内仍可登录；并发请求可双双穿过 60s 冷却多发邮件。修：verify 入口查白名单；频控改条件 INSERT
- [ ] **前端幂等键每次提交重新生成 → 后端幂等守卫对用户重试失效**（`DepositForm.tsx:35`、`usePortfolio.ts:44` 每次 `crypto.randomUUID()`）：请求超时但后端已入账 → 用户再点一次 → 新 key 绕过守卫 → 重复入金/买入真实落库；后端整套 idempotency_key 机制在前端形同虚设。修：key 在表单内容不变期间稳定复用，成功后轮换
- [ ] **任意旧 PENDING 对账记录都可一键校准当前资金池**（`Reconciliation.tsx:209-211` + `reconciliation.ts:230` targetCash 用该记录创建时的券商余额）：点 3 个月前的旧 PENDING 记录会把**当前**现金改写为（旧券商总资产 − 当前持仓市值），无二次确认、无"非本月"警示。修：仅最新一条 PENDING 可校准，或弹确认框明示使用的余额与月份

### P2 演化器健壮性（2026-08-22 审计）

- [ ] **api_client 把 NULL 行情静默转 0.0**（`api_client.py:69-83`，上游 `download.py:36-39` NaN→NULL 入库）：WF 路径 `cur==0` 是有限值，以权重注入 **−100% 日收益**；MPT 路径 `compute_returns_from_prices` 遇 `arr<=0` 返回 `[]` → 所有折静默跳过 → `CpcvResult(dsr=0)` 无任何报错。当前数据恰好无 NULL，但下载脚本明确允许写 NULL。修：NULL 行丢弃或 loudly fail
- [ ] **MPT/MC/regime 仍用"尾部截断逐符号切片"对齐**（`mpt.py:61,95`、`regime.py:37-43,132-138`，即 walk_forward 已修复的 C1 失败模式残留在非 WF 路径）：已实测当前 6 个 CSV 尾部 1424 根日期 100% 重合暂无污染，但任何停牌/缺日即静默错位协方差/均值。修：统一改用日期对齐后的价格矩阵（复用 `extract_prices_for_symbols`）
- [ ] **PBO 拒绝后的 stability 报告张冠李戴**（`report.py:211-228`）：换用新推荐参数后仅置 `is_stable = True`（硬编码），`gradient/threshold/neighborhood_sharpe_ratios` 仍属旧参数，循环里算过的新参数真实 `s` 被丢弃
- [ ] **regime_probs 未按 Bull/Sideways/Bear 重映射**（`regime.py:197-204` 标签做了映射、`:243` 概率没做）：三概率按 GMM 内部分量序输出，与 regime_label 解读必然错位。修：`probs = probs[:, order]` 后再取末行
- [ ] **推送报告裸 `requests.post` 无重试**（`report.py:511-521`，GET 拉数据有重试、写回没有）：与时间戳 400 叠加 → 演化器从未成功写过报告；修好 400 后一次 502 也会丢数小时计算。修：与 P1 本地落盘项一并处理（落盘后可补推）
- [ ] **regime/synthetic 失败被 `except Exception: pass` 吞掉**（`report.py:255-256, 271-272`）：缺 scipy/sklearn 或任何运行时错都表现为"正常报告"（永远 Sideways、无压力场景）且无日志。修：至少与 sobol/drift 一致记 warning
- [ ] **`generate_walk_forward_windows` 可静默返回空列表**（`walk_forward.py:293-294` break 分支）：`num_windows=1` 且 `embargo_days>0` 时唯一窗口越界 → `[]`，下游不检查 → `pbo_score=1.0`、推荐参数回落默认，无告警。修：windows 为空时 raise（与同函数其它校验一致的 loud-fail 风格）
- [ ] **测试盲区**：`api_client.py` 零测试（NULL 毒化/非 200/行序假设全未覆盖——数据完整性第一道闸门）；`push_report_to_cloud` 零测试（一个 zod 契约测试即可抓住时间戳 400）；`test_cpcv.py:19` 只断言 `len(folds) <= 5`，折塌缩/测试窗重复无断言

### P2 管道与配置（2026-08-22 审计）

- [ ] **高水位查询失败降级为全量 refetch，与 CI 10 分钟超时冲突**（`daily-market-update.ts:88-113` WARN 后返回 `{}` → 6 标的全量下载 5-15 分钟 vs `daily-market-update.yml` `timeout-minutes: 10`）：一次瞬时 wrangler 抖动必然升级为 CI 失败 + gh issue。修：查询失败即中止（fail fast）而非降级全量
- [ ] ⚡ **`database/migrate.ts` 与 `database/seed.ts` 均为死代码**（package.json 无任何引用；前者与 `database:migrate` 脚本重复且同样只跑 schema.sql，后者若以 `CLOUDFLARE_ENV=production` 运行会向生产白名单插入 `test@example.com` 等占位邮箱）→ 删除
- [ ] ⚡ `data/backfill_realized_pnl.sql` 不在 .gitignore（只有 `data/market_data/*.sql` 被忽略），跑过回填后易误提交
- [ ] ⚡ ci-verify 的 push 触发路径不含 `.github/workflows/**`（仅 pull_request 含），workflow 自身改动直推 main 不跑 CI
- [ ] ⚡ market:update 日志 "Records inserted" 实为 INSERT **语句**数（每 500 行一批），非记录数（`daily-market-update.ts:306,318`）
- [ ] "增量更新"实际每次全量下载再过滤（`akshare-fetch.ts` 生成的 Python 不传起止日，`fund_etf_hist_sina` 全量拉取后 `df[df.date >= start]`）：INSERT OR IGNORE 保证幂等、无正确性风险，但"增量"名不符实且每次更新耗时=全量 → 文档说明或换支持区间的接口

### P3 审计小项（2026-08-22）

**后端**：
- [ ] `trigger.ts:52` POST 用 `.parse` 抛 ZodError → 500 且 message 泄露 zod 内部报文（auth 的 json 解析同病）→ 改 safeParse + 400
- [ ] cron market-update 把"无新数据"当失败抛错（`functions/api/market-update.ts:104-107`）：手动补数后/新浪延迟时每天假错 → 区分"拉取失败"与"已最新"
- [ ] `market-data /history` 与 `/api/export` 无界全表返回（`market-data.ts:16-29`、`export.ts:19-26`，audit_logs 只增不清理）→ 加分页/日期范围
- [ ] `fetchLatestPrices` 逐标的串行 N+1（`trigger.ts:27-35`）→ 复用 `portfolio.ts:49-54` 的 GROUP BY 写法
- [ ] performance 重放排序无决胜列（`performance.ts:74-75` 仅 `ORDER BY trade_date`）：同日多笔依赖 rowid；"先卖后买"时 `Math.max(prev - shares, 0)` 钳股数 → `ORDER BY trade_date, id`
- [ ] `config` 表播种后全代码无 `FROM config`（`schema.sql:204-213` vs `TRIGGER_CONSTANTS` 硬编码）：改表内触发线/佣金零效果，纯误导 → 删播种或真读取
- [ ] LCH 无生日兜底默认"20 岁"（进取 80%，`lch-utils.ts:57-60`），与演化缺参兜底 60% 互相矛盾 → 无生日退保守值

**前端**：
- [ ] TransactionForm 无 >0 校验，0 股/0 价透出英文 zod 报错（`TransactionForm.tsx:152-153`）
- [ ] LayerCharts 拉取失败被渲染成"暂无交易数据"空态（`LayerCharts.tsx:28,116-126` isError 被丢弃）
- [ ] 交易记录显示 created_at 而非 trade_date，补录时"时间"列与收益曲线对不上（`RecentTransactions.tsx:62`）
- [ ] 类型与后端不符两处：deposit 重复路径返回 `portfolio: {}` vs 类型声明 3 个必填 number；calibrate 的 `warnings: string[]` 类型缺失且 UI 全部丢弃（含关键核对提示）（`types/api.ts:188-192`、`useReconciliation.ts:27-36`）
- [ ] Settings 卸载 abort 后仍 setState + console.error（`Settings.tsx:28-48`，StrictMode 下必现 AbortError 噪声）
- [ ] Reconciliation `currentMonth()` 用 UTC ISO 月份，东八区每月 1 日 0-8 点默认月份错为上月（`Reconciliation.tsx:13-15`，与已知 Settings 时区 bug 同病但独立位置）
- [ ] 份额分布图 `Math.round(market_value/100)` 丢分精度且 tooltip 伪称精确到分（`LayerCharts.tsx:71,83`）
- [ ] 三处 `logout()` 未捕获 rejection，登出失败无反馈（`Dashboard.tsx:126`、`Reconciliation.tsx:100`、`Settings.tsx:111`）

**演化器**：
- [ ] `stability_score = abs(Sharpe(test_sharpes))` 退化：各窗口完全一致时 std=0 得 0 分，"最稳定"反而 0 分（`walk_forward.py:638-641`）
- [ ] MC `_vectorized_max_consecutive` 漏计延续到路径终点的回撤段，熊市路径 `max_dd_duration` 系统性偏低（`monte_carlo.py:141-150`）
- [ ] constants.py 大量"唯一事实源"常量已死且与实际默认矛盾：`SYNTHETIC_DEFAULT_PATHS=500`（实际 5000）、`REGIME_DEFAULT_LOOKBACK_MONTHS=6`（实际 3），另有 `BOOTSTRAP_*/SOBOL_DEFAULT_N_SAMPLES/WF_DEFAULT_*/DEFAULT_MONTHLY_CONTRIBUTION/ETF_PRICE_LIMIT/LOT_SIZE` 均无引用（`constants.py:121,138` 等）
- [ ] dca_sim 同日收盘信号 + 同日收盘成交（含用当日全天涨幅判涨停），比生产引擎"收盘后决策、次日执行"乐观；docstring 宣称 zero-lookahead 仅对 MA 成立（`dca_sim.py:253-265`）
- [ ] MC 口径混杂：路径日期用自然日（周末漂移）；`summary.max_drawdown`（1000 条 p5）与 `drawdown_analytics.max_drawdown`（2000 条 p5）同名不同值且都进报告；`MC_MIN_PATHS_FOR_CVAR` 从未被 `compute_cvar` 使用（n*level<1 时返回 0.0 冒充无尾部损失）；synthetic 全历史估矩 vs MC 252 日窗不一致（`monte_carlo.py:188,247,349`、`synthetic.py:254`）
- [ ] monitoring PSI 分箱取 expected+actual 并集且不查重复边界（大量并列值时分箱退化）；drift 报告的 `window_start/end` 是"当前时间−N×30 天"的编造日历日期而非数据窗口实际日期（`monitoring.py:39-43`、`report.py:404-405`）
- [ ] Sobol 自助置信区间只重采样 f(A) 块，`var_y_boot` 是 YA 样本方差而非全样本方差（`sensitivity.py:131-135`）；窗口门槛 `len(rets)>=5` 与主链路 `MIN_OBS_FOR_SHARPE=63` 不一致

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

- [x] **A 股交易规则未建模**：T+1 交割（`simulate_dca` 用当日余额执行）、100 股整手、涨跌停、货币基金申赎 T+1、ETF 折溢价
- [x] **MPT 均值/协方差全样本 lookahead**（`mpt.py:27-79`）：权重在已知未来的统计量上优化。改在各训练折内估计
- [x] **walk-forward 无 purge/embargo**：等分块 + train/test 紧邻。改 expanding/滚动 + 间隔；与 CPCV 收益模型统一
- [x] **regime 是摆设且有顺序 bug**（`regime.py:205-275`）：`compute_regime_blended_frontier` 死代码，`regime_probs`/`regime_covs` 语义错乱。接入优化或删除
- [x] **bootstrap 误用**（`report.py:170-183`）：对 MC 期末横截面 block bootstrap 无意义；DSR 启发式近似；PBO `num_params/2` 非标准。修正或标注局限
- [x] **stability 扰动破坏约束**：对 `safe_ratio`/`ambition_ratio` 独立扰动破坏 sum=1，测的是"加杠杆"
- [x] **GBM 漂移用全样本日均收益×252**（`monte_carlo.py:295`）；max_dd 取单条最差路径 → 用稳健分位数
- [x] **回测窗口由最短标的决定（~1,420 天）**：货币 ETF 511360 仅 2020-09 起（1,423 行），进取层 515080 仅 2019-12 起（1,605 行）——较指数代理时代（4,400+ 天）缩短。要么接受（现状）并在报告中量化，要么另找长历史源补早期数据
- [x] **执行次数受流动性上限饱和**：默认月供下 `bsm_threshold` 只改变执行时点而非次数——建模选择，需在报告中说明
- [x] ⚡ **`cpcv.py:77` 除零 RuntimeWarning**（pytest 中可见）：补齐样本不足分支

### P2 数据管道与后端（2026-08-21 全部完成，d02f56b）

- [x] **scheduled cron 不含市场数据更新**：scheduled handler 已接入 `runScheduledMarketUpdate`（逐标的隔离，单标的失败不再中断整批）
- [x] **`market:init` 名不符实**：脚本链已改为全量下载 + 迁移 + 导入 D1（`market:init` / `market:init:prod`）
- [x] **无交易日历**：新增 `src/lib/trading-calendar.ts` + `trade-calendar.json`（2013-04 起，含 2013 前下界守卫）
- [x] **无 OHLC 合法性校验**：新增 `market-validation.ts`（close>0、high≥low、6 标的全返回）
- [x] ⚡ **删除残留指数 CSV**：旧宇宙 5 个指数 CSV 已删
- [x] **无分红/除权处理**：新增 `dividends.ts` + 迁移 003（标的白名单 + 幂等批）
- [ ] **演化权重数组被丢弃**（多标的轮换）：`safe_allocation`/`ambition_allocation` 解析后从未用于选标的；`getNextSafeETF` 恒返回主 ETF（`trigger-engine.ts:32-34` stub）；`lch-utils.ts:94` 死回退仍指向已删除的 `000300`；`src/types/api.ts` `ETF_CONSTANTS` 缺 511990。一并落地轮换或删除死代码
- [x] **无分页**：交易列表/组合/对账均加 offset 分页（limit 1..200 clamp）
- [x] **无审计日志表、无备份/导出端点、交易无幂等键**：`audit_logs` 表 + 批次首语句；`/api/export` 导出端点；`idempotency_key`（004）+ `request_nonce`（005）批内判别子，重试/并发重复整批 no-op
- [ ] ⚡ **`src/types/api.ts:236` `AuthSession` 仍声明 `token`**（已无人读取）→ 清理

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
