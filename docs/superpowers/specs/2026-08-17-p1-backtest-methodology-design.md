# P1 回测方法学修正 Design Spec

> 日期：2026-08-17
> 状态：已获用户批准（2026-08-17，第 8 项用户裁决方案 A）

## 背景

TODO.md 中 P1 回测方法学（决策质量）10 项待办全部完成设计。这些缺陷导致回测结论不可信：lookahead 污染统计量、A 股交易规则缺失、无意义的 bootstrap、死代码与语义错乱的 regime 模块、约束破坏的稳定性扰动等。

验证基线（不得回归）：`pytest` 122 passed、`ruff check`/`ruff format --check`/`mypy --strict`/`bandit` 全绿（`npm run lint:python:all`）。

## 架构总览

全部改动在 `scripts/local_evolver/` Python 侧。核心思路：**消除 lookahead、建模真实交易规则、删除死代码、修正统计误用**。不改 TS/前端/数据库。

## 逐项设计

### 1. A 股交易规则建模（`dca_sim.py` + `models.py` + `constants.py`）

`simulate_dca` 落地五项规则，全部通过 `DcaConfig`/`TransactionCostConfig` 可配置：

- **ETF 买入 T+1 交割**：EXECUTE 当日从 safe_cash 扣除 `ambition_amount + commission`（现金当日离账），新增 `pending_ambition`；次日循环开始处 `ambition_value += pending_ambition` 后再应用当日收益率（次日起参与涨跌）。
- **100 股整手**：`shares = floor(ambition_amount / execution_price / 100) * 100`；`actual_amount = shares * execution_price`；零股现金留在 safe_cash；佣金按 `actual_amount` 计。
- **涨跌停**：`ambition_returns[t] >= limit_up`（默认 +0.10，可配置 `price_limit`）当日 EXECUTE 跳过（涨停排队无法成交）。
- **货币基金申赎 T+1**：定投入金当日计入 `pending_safe`（不计息），次日并入 safe_cash 开始计息。
- **ETF 折溢价**：`execution_price = close[t] * (1 + etf_spread/2)`，`etf_spread` 默认 0.002（20bps 近似）；用 execution_price 计算整手与成交额；**买入份额按公平价值 `shares * close` 计入 `pending_ambition`**（价差 `shares * close * etf_spread/2` 从现金扣减，为已实现成本，不补贴进取层净值）。（2026-08-18 最终评审修正：原设计按 execution_price 计入份额使价差成为对进取层的补贴而非成本。）

信号计算不变（仍用收盘价、零 lookahead）。`compute_decision` 不变。新增/变更的单元测试：整手取整、T+1 冻结、涨停跳过、pending 计息、折溢价定价。

### 2. MPT 均值/协方差全样本 lookahead（`mpt.py`）

`compute_efficient_frontier_with_cpcv` 改为逐折估计：

- 新增 `compute_efficient_frontier_on_window(data, symbols, start, end, config, risk_free_rate)`：统计量只在 `[start, end]` 窗口内估计（`compute_mean_returns`/`compute_covariance_matrix` 增加 `start`/`end` 可选参数），生成前沿。
- 循环每个 CPCV fold：train 窗口（`[fold.train_start, fold.train_end]`）估计 → 生成前沿 → 取 max-sharpe 权重 → 在 test 窗口评估（复用现有 `compute_cpcv_result` 逻辑，得到 fold 级 Sharpe/DSR 分布）。
- 返回的 `EfficientFrontier`：用**测试段最靠近当前（`test_end` 最大）的 fold 的 train 窗口**（即"截至当前可用数据"）生成前沿供报告展示；`max_sharpe_portfolio` 的 `cpcv_result` 携带逐折评估分布。
- `compute_regime_blended_frontier` 删除（见第 4 项）。
- **实现注（Task 6 简化，2026-08-18 已撤销）**：实现阶段曾简化为"仅用 `test_end` 最大 fold 的 train 窗口生成一次前沿，取其 max-sharpe 权重在**全部** fold 上经 `compute_cpcv_result` 样本外评估"，声称输出与原设计一致；最终评审发现早期折 test 窗口落在估计窗口内（样本内混合），**用户裁决恢复逐折估计**（即上方设计：每折自身 train 窗口估计 → 自身 test 窗口评估 → fold 级 OOS 分布）。
- 测试：构造"未来已知"的数据（如 train 段与 test 段统计量显著不同），断言权重选择只依赖 train 数据。

### 3. walk-forward purge/embargo（`walk_forward.py` + `models.py`）

`generate_walk_forward_windows(total_obs, num_windows, train_ratio, purge_days=0, embargo_days=0)`：

- train 有效区间尾部去掉 `purge_days`（`train_end_purged = train_end - purge_days`）
- test 起点与 train 尾部间隔 `embargo_days`（`test_start = train_end + embargo_days + 1`）
- `run_walk_forward` 与 `report.py` 传入 `config.purge_days`/`config.embargo_days`（默认 5/5，与 CPCV 一致）
- 不足最小观察数时照旧报错
- 测试：断言窗口间隔正确、间隔不足时报错

### 4. regime 死代码删除（`mpt.py` + `regime.py`）——用户裁决：删除

- 删除 `mpt.py:compute_regime_blended_frontier`（mpt.py:249-328）与 `regime.py:blended_covariance`（regime.py:256-275）
- `detect_regimes` 保留（报告/演化输出仍展示当前状态），`RegimeResult.regime_probs` 字段语义保持"当前状态概率"，不再有误用方
- `mpt.py` 移除 `from regime import ...` 导入
- 测试：删除相关死代码测试（如有）；`detect_regimes` 测试保留

### 5. bootstrap 误用修复（`report.py` + `dsr.py`）——用户裁决：WF 样本外收益

- `report.py:173-188` 改为：对**推荐参数在样本外测试窗口的 DCA 日收益率**做 block bootstrap。数据源：walk-forward 最优结果（`best_results[0]`）的 `compute_portfolio_returns_for_params` 测试段收益（与 drift 检测已用的逻辑一致）。
- 样本不足（< `MIN_OBS_FOR_BOOTSTRAP`）时跳过，返回空 dict。
- **DSR haircut**（`dsr.py:compute_haircut_sharpe`）：标准 Bailey 2014 近似（E[max] 解析近似 × 经验惩罚项）——补 docstring 标注局限，不改算法。
- **PBO 中位数排名**（`walk_forward.py:_compute_pbo`）：`num_params/2` 是 Bailey 定义的标准做法——补 docstring 标注，不改算法。
- 测试：bootstrap 输入为真实时间序列（断言输出结构）；样本不足返回空。

### 6. stability 扰动破坏约束（`stability.py`）

- `safe_ratio`/`ambition_ratio` 不再经 `_scalar_neighborhood_scores` 独立扰动。
- 改为联合扰动：扰动比例 `rho = safe_ratio / (safe_ratio + ambition_ratio)`，`new_rho = clamp(rho ± perturb)`，反解 `safe' = new_rho * (safe+ambition)`、`ambition' = (1-new_rho) * (safe+ambition)`。
- 其余标量参数（trigger_line/bsm_threshold/MA 窗口）与权重（`_perturb_weights` 已归一化）不变。
- 测试：扰动后 `safe_ratio + ambition_ratio ≈ 1`；新增"联合扰动"用例。

### 7. MC 漂移窗口与 max_dd 稳健分位数（`monte_carlo.py`）——用户裁决：252 日窗口

- `run_monte_carlo` 增加 `estimate_window_days: int = 252`：均值/波动/协方差只取最近 `estimate_window_days` 个交易日估计（`compute_mean_returns`/`compute_covariance_matrix` 的窗口参数复用第 2 项新增的 `start`/`end` 能力）。
- `compute_monte_carlo_summary` 与 `compute_drawdown_analytics` 的 `max_dd` 从"单条最差路径"改为**逐路径最大回撤的 5% 分位数**（95% 的路径回撤不超过该值），`calmar_ratio` 同步使用该分位数。
- 测试：分位数断言；窗口截断断言。

### 8. 回测窗口按上市日可用性回填——用户裁决：方案 A

数据可行性实测结论（2026-08-17）：
- 中证短融AAA指数（511360 基准）新浪/腾讯均无数据，东财本网络不可靠 → **511360 无法用指数拼接回填**（方案 B 不可行）。
- 中证红利指数（515080 基准）新浪截断至 2019-01-30，腾讯源 2008-07 起完整 → 仅 515080 可拼接，但窗口仍被 511360 绑定，几乎无收益。
- 方案 A（采纳）：**各标的从自身首个交易日参与组合**，早期安全层 = 511880/511990 权重归一化，早期进取层 = 510300/510500 归一化（as-if 回测，全部真实价格，零代理假设）。窗口从 2020-09（~1,423 天）延长至 2013-04（~3,300 天）。

实现：

- `walk_forward.py:extract_prices_for_symbols` 从全标的 inner join 改为 **union-join（outer join）**：日期主索引 = 所有标的交易日并集，起点截断到**两层均有数据的首日**（max(安全层最早日期, 进取层最早日期) = 2013-04）；缺失标的的早期日期填 NaN。
- `_weighted_composite` **收益加权链式合成**（2026-08-18 用户裁决，替代原"价格水平归一化"）：每日合成收益 = 当日可用（t-1 与 t 均有有限价格且 prev > 0）标的收益按权重再归一化加权平均；净值从 1.0 链式累乘。晚上市标的上市首日无 t-1 价格被剔除 → 构造性无价格水平跳变（原价格归一化在 515080 上市时产生 ~15% 虚假单日跌幅，污染 WF train 窗口与 bootstrap）；当日无可用收益 → NaN（响亮，绝不静默 0）。
- **CPCV fold 退化（已知限制）**：`generate_cpcv_folds` 以 `max(train_indices)` 锚定 embargo，生产默认 `num_splits=10` 下仅 2 个 fold 通过过滤、`num_splits=5` 下 0 个。为既有问题（非本 spec 引入）；逐折 CPCV 路径对 0/2 折无样本内泄漏（最新折前沿兜底、无 OOS 声明）。后续建议：embargo 锚定各折自身 train/test 边界并断言 >= 1 折。
- `check_data_sufficiency` 改为：每标的须 ≥ `MIN_OBS_FOR_SHARPE` 根 K 线（不再要求同长）；`simulate_dca` 的返回序列从复合价格推导，天然对齐。
- `dca_sim.py` 的 `simulate_dca` 签名不变（输入已是逐日标量序列）。
- `report.py`/`cpcv.py`/`mpt.py` 中基于 `min(len(...))` 的尾部对齐逻辑（前沿估计用）不受影响（第 2 项已改为窗口内估计）。
- 测试：构造"晚上市"标的，断言早期复合 = 可用标的归一化、窗口延长、无 NaN 泄漏。

### 9. 执行次数饱和——文档说明（无代码改动）

在 `dca_sim.py` 模块 docstring 与 `docs/EVOLVER.md` 注明：

> 建模选择：默认月供（1000 元/21 日）下资金池积累速度低于触发线，`bsm_threshold` 只改变执行时点、不改变执行次数（流动性上限饱和）。提高月供或降低触发线可观察次数差异。

### 10. `cpcv.py:77` 除零守卫

`compute_returns_from_prices`：价格含 0/负/非有限值 → 返回空数组（调用方已处理空序列），消除 RuntimeWarning。用 `np.errstate` 包裹除法并显式过滤非有限结果。

## 边界与不变量

- 信号计算（`compute_signal_at`）保持零 lookahead，只改执行/结算规则。
- 所有新增参数有默认值，`config.yaml` 可覆盖；`constants.py` 集中魔法数。
- 报告序列化结构不变（`StrategyReportData` 字段不变）。
- 不引入新依赖（numpy/torch/sklearn 已有）。

## 验证

- `pytest`（新增/变更测试见各节；全量 122+ 通过）
- `npm run lint:python:all`（ruff/mypy/bandit 全绿）
- 回归：`test_walk_forward.py::test_all_six_params_affect_score`、`test_seeding.py` 复现性测试必须仍绿