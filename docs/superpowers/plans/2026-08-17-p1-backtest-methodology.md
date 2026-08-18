# P1 回测方法学修正 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复 TODO.md P1 回测方法学 10 项：A 股交易规则建模、MPT lookahead、walk-forward purge/embargo、regime 死代码删除、bootstrap 修复、stability 约束、MC 漂移窗口与稳健 max_dd、回测窗口按上市日可用性回填（方案 A）、执行次数饱和文档化、cpcv 除零守卫。

**Architecture:** 全部改动在 `scripts/local_evolver/` Python 侧。核心思路：**消除 lookahead（MPT 逐折估计、MC 近期窗口）、建模真实交易规则（T+1/整手/涨停/折溢价）、删除死代码（regime blend）、修正统计误用（bootstrap 改 WF 样本外收益）、延长回测窗口（union-join + 按层可用性归一化合成）**。不改 TS/前端/数据库，不引入新依赖。

**Tech Stack:** Python 3.12+（本机用 `py -3.14` 执行 pytest，因 3.12 未装 pytest）、numpy、torch、sklearn、pytest。

**Spec:** `docs/superpowers/specs/2026-08-17-p1-backtest-methodology-design.md`

## Global Constraints

- 验证基线不得回归：`pytest` 122 passed（最终 122+ 新增）、`ruff check`/`ruff format --check`/`mypy --strict`/`bandit` 全绿（`npm run lint:python:all`）
- 本机 pytest 命令：`py -3.14 -m pytest scripts/local_evolver/tests/...`
- 信号计算（`compute_signal_at`）保持零 lookahead，只改执行/结算规则
- 所有新增参数有默认值（`models.py` dataclass 默认值 + `config.yaml` 可覆盖）；魔法数集中 `constants.py`
- 报告序列化结构不变（`StrategyReportData` 字段不变）
- 不引入新依赖
- 每个任务独立可测、可提交

---

### Task 1: cpcv 除零守卫

**Files:**
- Modify: `scripts/local_evolver/cpcv.py:75-77`
- Test: `scripts/local_evolver/tests/test_cpcv.py`

**Interfaces:**
- Consumes: 无
- Produces: `compute_returns_from_prices(prices: list[float]) -> np.ndarray` — 价格含 0/负/非有限值时返回空数组（不再触发 RuntimeWarning）

- [ ] **Step 1: 写失败测试**

在 `scripts/local_evolver/tests/test_cpcv.py` 末尾追加：

```python
def test_compute_returns_from_prices_invalid_prices():
    assert len(compute_returns_from_prices([100.0, 0.0, 110.0])) == 0
    assert len(compute_returns_from_prices([100.0, -5.0, 110.0])) == 0
    assert len(compute_returns_from_prices([100.0, float("nan"), 110.0])) == 0
    assert len(compute_returns_from_prices([100.0, float("inf"), 110.0])) == 0
```

- [ ] **Step 2: 运行测试确认失败**

```bash
py -3.14 -m pytest scripts/local_evolver/tests/test_cpcv.py::test_compute_returns_from_prices_invalid_prices -v
```
Expected: FAIL（当前实现返回 NaN/inf 数组，长度非 0）。

- [ ] **Step 3: 实现守卫**

修改 `cpcv.py` 的 `compute_returns_from_prices`：

```python
def compute_returns_from_prices(prices: list[float]) -> np.ndarray:
    arr = np.array(prices, dtype=np.float64)
    if len(arr) < 2:
        return np.array([])
    if not np.all(np.isfinite(arr)) or np.any(arr <= 0):
        return np.array([])
    with np.errstate(divide="ignore", invalid="ignore"):
        returns = arr[1:] / arr[:-1] - 1.0
    if not np.all(np.isfinite(returns)):
        return np.array([])
    return returns
```

- [ ] **Step 4: 运行测试确认通过**

```bash
py -3.14 -m pytest scripts/local_evolver/tests/test_cpcv.py -v
```
Expected: 全部 PASS（含原有 8 例 + 新 1 例）。

- [ ] **Step 5: 提交**

```bash
git add scripts/local_evolver/cpcv.py scripts/local_evolver/tests/test_cpcv.py
git commit -m "fix(evolver): guard zero/non-finite prices in compute_returns_from_prices"
```

---

### Task 2: models/constants/config 参数扩展

**Files:**
- Modify: `scripts/local_evolver/models.py`（`DcaConfig`、`TransactionCostConfig`、`EvolverConfig`）
- Modify: `scripts/local_evolver/constants.py`
- Modify: `scripts/local_evolver/config.py:41-69`
- Modify: `scripts/local_evolver/config.yaml`
- Test: `scripts/local_evolver/tests/test_config.py`

**Interfaces:**
- Consumes: 无
- Produces（后续任务依赖）:
  - `DcaConfig(monthly_contribution=1000.0, contribution_freq_days=21, price_limit=0.10, lot_size=100)`
  - `TransactionCostConfig(etf_bps=3.0, etf_min_yuan=5.0, mmf_bps=0.0, etf_spread=0.002)`
  - `EvolverConfig(..., mc_estimate_window_days=252)`
  - `constants.py` 新增：`ETF_PRICE_LIMIT=0.10`、`ETF_SPREAD=0.002`、`LOT_SIZE=100`、`MC_DEFAULT_ESTIMATE_WINDOW_DAYS=252`

- [ ] **Step 1: 写失败测试**

在 `test_config.py` 追加/修改：

```python
def test_load_config_new_rules_defaults():
    config = load_config(path="nonexistent.yaml")
    assert config.transaction_costs.etf_spread == 0.002
    assert config.dca.price_limit == 0.10
    assert config.dca.lot_size == 100
    assert config.mc_estimate_window_days == 252


def test_load_config_new_rules_custom():
    cfg = {
        "transaction_costs": {"etf_spread": 0.001},
        "dca": {"price_limit": 0.05, "lot_size": 200},
        "mc": {"estimate_window_days": 126},
    }
    with tempfile.NamedTemporaryFile(mode="w", suffix=".yaml", delete=False) as f:
        yaml.dump(cfg, f)
        tmp_path = Path(f.name)
    try:
        config = load_config(path=str(tmp_path))
        assert config.transaction_costs.etf_spread == 0.001
        assert config.dca.price_limit == 0.05
        assert config.dca.lot_size == 200
        assert config.mc_estimate_window_days == 126
    finally:
        tmp_path.unlink()
```

- [ ] **Step 2: 运行测试确认失败**

```bash
py -3.14 -m pytest scripts/local_evolver/tests/test_config.py -v
```
Expected: FAIL（`etf_spread` 等属性不存在）。

- [ ] **Step 3: 扩展 models.py**

`models.py`：

```python
@dataclass
class TransactionCostConfig:
    etf_bps: float = 3.0
    etf_min_yuan: float = 5.0
    mmf_bps: float = 0.0
    etf_spread: float = 0.002  # ETF 折溢价近似：买入价 = close * (1 + spread/2)
```

```python
@dataclass
class DcaConfig:
    monthly_contribution: float = 1000.0
    contribution_freq_days: int = 21
    price_limit: float = 0.10   # 涨停幅度：当日涨幅 >= 此值无法买入
    lot_size: int = 100         # 整手股数（100 股一手）
```

`EvolverConfig` 追加字段：

```python
    mc_estimate_window_days: int = 252  # MC 均值/波动/协方差估计窗口（交易日）
```

- [ ] **Step 4: 扩展 constants.py**

`constants.py` 追加：

```python
# ============================================================================
# A-Share Trading Rules (P1)
# ============================================================================
ETF_PRICE_LIMIT: float = 0.10  # 涨停幅度（当日涨幅 >= 此值无法买入）
ETF_SPREAD: float = 0.002  # ETF 折溢价近似（双边价差，买入价上浮一半）
LOT_SIZE: int = 100  # ETF 整手（股）

# ============================================================================
# Monte Carlo Estimation Window
# ============================================================================
MC_DEFAULT_ESTIMATE_WINDOW_DAYS: int = 252  # 漂移/波动估计窗口（交易日）
```

- [ ] **Step 5: 扩展 config.py 与 config.yaml**

`config.py` 的 `load_config` 中，`TransactionCostConfig(...)` 增加 `etf_spread=float(tc.get("etf_spread", 0.002))`；`DcaConfig(...)` 增加 `price_limit=float(dca_cfg.get("price_limit", 0.10))`、`lot_size=int(dca_cfg.get("lot_size", 100))`；`config.gbm_paths` 赋值后追加 `config.mc_estimate_window_days = int(cfg.get("mc", {}).get("estimate_window_days", 252))`。

`config.yaml`：

```yaml
transaction_costs:
  etf_bps: 3
  etf_min_yuan: 5
  mmf_bps: 0
  etf_spread: 0.002          # ETF 折溢价近似：买入价 = close × (1 + spread/2)

dca:
  monthly_contribution: 1000
  contribution_freq_days: 21
  price_limit: 0.10          # 涨停幅度：当日涨幅 ≥ 此值无法买入
  lot_size: 100              # 整手（股）

mc:
  estimate_window_days: 252  # MC 均值/波动/协方差估计窗口（交易日）
```

- [ ] **Step 6: 运行测试确认通过**

```bash
py -3.14 -m pytest scripts/local_evolver/tests/test_config.py -v
```
Expected: 全部 PASS（原 3 例 + 新 2 例）。

- [ ] **Step 7: 提交**

```bash
git add scripts/local_evolver/models.py scripts/local_evolver/constants.py scripts/local_evolver/config.py scripts/local_evolver/config.yaml scripts/local_evolver/tests/test_config.py
git commit -m "feat(evolver): add A-share rule and MC window config fields"
```

---

### Task 3: A 股交易规则建模（dca_sim.py）

**Files:**
- Modify: `scripts/local_evolver/dca_sim.py:178-245`（`simulate_dca`）
- Test: `scripts/local_evolver/tests/test_dca_sim.py`

**Interfaces:**
- Consumes: Task 2 的 `DcaConfig.price_limit`/`lot_size`、`TransactionCostConfig.etf_spread`
- Produces: `simulate_dca(safe_returns, ambition_returns, ambition_prices, params, cost_config, dca_config, start, end) -> DcaOutcome` — 签名不变；新增结算语义：
  - 定投贡献当日计入 `pending_safe`（不计息、不可用于当日执行），次日并入 `safe_cash`
  - EXECUTE 当日扣现金、份额记 `pending_ambition`，次日并入 `ambition_value`（次日起参与收益）
  - 涨停日（`ambition_returns[t] >= price_limit`）跳过执行
  - 执行价 `close[t] * (1 + etf_spread/2)`，整手取整 `floor(amount / price / lot) * lot`，佣金按实际成交额
  - 买入份额按公平价值 `shares * close` 计入 `pending_ambition`（价差 `shares * close * etf_spread/2` 为已实现成本，从现金中扣减，不补贴进取层净值）
  - 不足 1 手（shares == 0）不执行

- [ ] **Step 1: 写失败测试**

`test_dca_sim.py` 的 `_cost` 助手增加 `spread` 参数，TWR 无成本测试显式关闭 spread：

```python
def _cost(*, bps: float = 3.0, min_yuan: float = 5.0, spread: float = 0.002) -> TransactionCostConfig:
    return TransactionCostConfig(etf_bps=bps, etf_min_yuan=min_yuan, etf_spread=spread)
```

修改 `test_simulate_dca_twr_flat_market_no_cost` 的调用为 `_cost(bps=0.0, min_yuan=0.0, spread=0.0)`。

追加新测试（4 例，均含确定性判别逻辑——旧实现会在断言上失败）：

```python
def test_execution_uses_lot_rounding_and_spread_price():
    length = 120
    flat = np.zeros(length)
    prices = np.ones(length) * 4.05
    p = _params()
    dca = _dca(monthly=2000.0)
    out = simulate_dca(flat, flat, prices, p, _cost(bps=300.0), dca, 0, length - 1)
    assert out.num_executions > 0
    # 执行价 = 4.05 * (1 + 0.002/2) = 4.05405
    # 整手: floor(666.8 / 4.05405 / 100) * 100 = 100 股 → actual = 405.405
    # 佣金 = max(405.405 * 3%, 5) = 12.16215/笔（3% 佣金使整手差异被放大）
    per_exec = 4.05 * 1.001 * 100 * 0.03
    assert out.total_commission == pytest.approx(per_exec * out.num_executions, rel=1e-9)


def test_execution_skipped_on_limit_up():
    length = 60
    flat = np.zeros(length)
    limit_returns = np.zeros(length)
    limit_returns[30] = 0.10  # 涨停日
    flat_prices = np.ones(length)
    limit_prices = np.cumprod(1 + limit_returns)
    p = _params()
    dca = _dca(monthly=10000.0)  # 大月供保证第 30 天余额 >= 触发线（非涨停日会执行）
    out_ctrl = simulate_dca(flat, flat, flat_prices, p, _cost(), dca, 0, length - 1)
    out_lim = simulate_dca(flat, limit_returns, limit_prices, p, _cost(), dca, 0, length - 1)
    # 两条路径现金流完全一致，唯一差异是第 30 天涨停 → 恰好少 1 次执行
    assert out_lim.num_executions == out_ctrl.num_executions - 1


def test_execution_settles_t_plus_1_not_same_day():
    length = 30
    flat = np.zeros(length)
    amb_returns = np.zeros(length)
    amb_returns[1] = 0.05  # 次日尖峰：当日结算（旧行为）会吃到，T+1 结算错过
    amb_prices = np.cumprod(1 + amb_returns)
    p = _params(trigger_line=1000)
    dca = DcaConfig(monthly_contribution=5000.0, contribution_freq_days=1)
    out = simulate_dca(
        flat, amb_returns, amb_prices, p,
        _cost(bps=0.0, min_yuan=0.0, spread=0.0), dca, 0, length - 1,
    )
    assert out.num_executions >= 1
    # 零成本 + 平直市场 + T+1：nav 恒为 1.0 → 全零收益序列。
    # 旧实现第 0 天定投当日可执行（买入后持有过第 1 天尖峰）→ returns[1] ≈ +0.6% ≠ 0
    assert float(np.max(np.abs(out.returns))) < 1e-12
```

- [ ] **Step 2: 运行测试确认失败**

```bash
py -3.14 -m pytest scripts/local_evolver/tests/test_dca_sim.py -v
```
Expected: 新 3 例 FAIL（旧实现当日结算、无整手/涨停/折溢价逻辑）。

- [ ] **Step 3: 重写 `simulate_dca` 结算逻辑**

替换 `dca_sim.py:205-240` 的循环体：

```python
    freq = max(1, dca_config.contribution_freq_days)
    length = end - start + 1

    safe_cash = 0.0
    pending_safe = 0.0
    ambition_value = 0.0
    pending_ambition = 0.0
    units = 0.0
    nav_prev = 1.0
    num_executions = 0
    total_commission = 0.0

    returns = np.empty(length)
    for idx, t in enumerate(range(start, end + 1)):
        # T+1 结算：昨日定投/买入今日到账，并开始参与收益
        safe_cash += pending_safe
        pending_safe = 0.0
        ambition_value += pending_ambition
        pending_ambition = 0.0

        safe_cash *= 1.0 + float(safe_returns[t])
        ambition_value *= 1.0 + float(ambition_returns[t])

        if (t - start) % freq == 0:
            nav_now = (
                (safe_cash + pending_safe + ambition_value + pending_ambition) / units
                if units > 0
                else 1.0
            )
            new_units = dca_config.monthly_contribution / nav_now
            pending_safe += dca_config.monthly_contribution
            units += new_units

        sig_type, sig_value, _ = compute_signal_at(ambition_prices, params, t)
        decision = compute_decision(
            safe_cash + ambition_value, sig_type, sig_value, params
        )

        if decision.decision == "EXECUTE":
            if float(ambition_returns[t]) >= dca_config.price_limit:
                pass  # 涨停无法成交，跳过
            else:
                exec_price = float(ambition_prices[t]) * (
                    1.0 + cost_config.etf_spread / 2.0
                )
                lot = dca_config.lot_size
                shares = int(decision.ambition_amount // exec_price // lot) * lot
                actual = shares * exec_price
                commission = compute_commission(actual, cost_config) if shares > 0 else 0.0
                if shares > 0 and safe_cash >= actual + commission:
                    safe_cash -= actual + commission
                    pending_ambition += actual
                    num_executions += 1
                    total_commission += commission

        nav = (
            (safe_cash + pending_safe + ambition_value + pending_ambition) / units
            if units > 0
            else nav_prev
        )
        returns[idx] = nav / nav_prev - 1.0 if nav_prev > 0 else 0.0
        nav_prev = nav

    return DcaOutcome(
        returns=returns,
        num_executions=num_executions,
        total_commission=total_commission,
        final_nav=float(nav_prev),
    )
```

同时在模块 docstring 的决策分支说明后追加一段：

```
A-share trading rules (P1, all configurable):
  - Contributions settle T+1: day-t contribution is pending (not earning,
    not spendable) until day t+1.
  - ETF buys settle T+1: cash leaves on the trade day, shares are credited
    and start earning on the next day.
  - 100-share lot rounding at execution price close*(1+spread/2); leftover
    cash stays in the safe layer; commission charged on actual notional.
  - Limit-up days (return >= price_limit) skip execution (cannot fill).
```

- [ ] **Step 4: 运行测试确认通过**

```bash
py -3.14 -m pytest scripts/local_evolver/tests/test_dca_sim.py -v
```
Expected: 全部 PASS（原 19 例按上述微调 + 新 3 例）。

- [ ] **Step 5: 提交**

```bash
git add scripts/local_evolver/dca_sim.py scripts/local_evolver/tests/test_dca_sim.py
git commit -m "feat(evolver): model A-share trading rules in DCA simulator"
```

**⚠️ User-approved deviations (2026-08-17, applied in Task 3 execution):**

1. `test_execution_skipped_on_limit_up` uses `length = 31` (plan text said 60). The +10% limit-day price persists after day 30, and lot rounding at the elevated price drains cash faster on BOTH paths — at length=60 the two paths diverge by 10 executions (ctrl=49, lim=39), so the plan's own assertion `lim == ctrl - 1` could not hold against the plan's own implementation. length=31 ends the window on the limit-up day: ctrl=25, lim=24 (still discriminates: old impl gives 24/24).
2. `test_all_six_params_affect_score` (test_walk_forward.py, pre-existing) regressed under lot rounding: its safe_ratio 0.55/0.45 variant lands in the same 100-share lot bucket as baseline at fixture prices → bit-identical score. Fix committed separately: variant changed to safe_ratio=0.49/ambition_ratio=0.51 (crosses a lot boundary; verified score changes). Committed as `test(evolver): widen safe/ambition split variant to cross lot boundary`.

---

### Task 4: walk-forward purge/embargo

**Files:**
- Modify: `scripts/local_evolver/walk_forward.py:167-202`（`generate_walk_forward_windows`）、`walk_forward.py:418-435`（`run_walk_forward` 签名与传参）
- Modify: `scripts/local_evolver/report.py:118-128`（`run_walk_forward` 调用）
- Test: `scripts/local_evolver/tests/test_walk_forward.py`

**Interfaces:**
- Consumes: 无
- Produces:
  - `generate_walk_forward_windows(total_obs, num_windows=6, train_ratio=0.7, purge_days=0, embargo_days=0) -> list[WalkForwardWindow]` — train 有效区尾部去 `purge_days`，test 起点距 train 尾部 `embargo_days` 间隔；总跨度超限时按 `(total_obs - (purge+embargo)*(num_windows-1)) // num_windows` 缩小每折跨度，保持窗口数不变
  - `run_walk_forward(..., purge_days=0, embargo_days=0)` 透传

- [ ] **Step 1: 写失败测试**

`test_walk_forward.py` 追加：

```python
def test_generate_walk_forward_windows_purge_embargo():
    windows = generate_walk_forward_windows(
        total_obs=1320, num_windows=6, train_ratio=0.7, purge_days=5, embargo_days=5
    )
    assert len(windows) == 6
    w0 = windows[0]
    # gap_span = (5+5)*5 = 50; (1320-50)//6 = 211/折 → train 147, test 64
    # w0: train_end = 146, purge 后 141; test_start = 146+1+5 = 152; test_end = 215
    assert w0.train_start == 0
    assert w0.train_end == 141
    assert w0.test_start == 152
    assert w0.test_end == 215
    for w in windows:
        assert w.test_end - w.test_start + 1 >= MIN_OBS_FOR_SHARPE
        # purge/embargo: test 与 train 尾部有间隔
        assert w.test_start > w.train_end + 1


def test_generate_walk_forward_windows_resizes_when_gaps_overflow():
    # 500 obs、2 窗口、gap 各 5：原始跨度 250*2+10=510 > 500 → 缩为 (500-10)//2=245
    windows = generate_walk_forward_windows(
        total_obs=500, num_windows=2, train_ratio=0.7, purge_days=5, embargo_days=5
    )
    assert len(windows) == 2
    # w0: test_start = 170+1+5 = 176, test_end = 249
    # w1: ws = 245, train_end = 415, purge 后 410; test_start = 421, test_end = 494
    assert windows[0].test_end == 249
    assert windows[1].test_end == 494


def test_generate_walk_forward_windows_gap_too_large_raises():
    with pytest.raises(ValueError):
        generate_walk_forward_windows(
            total_obs=500, num_windows=2, train_ratio=0.7, purge_days=80, embargo_days=80
        )
```

- [ ] **Step 2: 运行测试确认失败**

```bash
py -3.14 -m pytest scripts/local_evolver/tests/test_walk_forward.py -v
```
Expected: 新 3 例 FAIL（当前签名无 purge/embargo 参数）。

- [ ] **Step 3: 实现窗口生成**

替换 `generate_walk_forward_windows`：

```python
def generate_walk_forward_windows(
    total_obs: int,
    num_windows: int = 6,
    train_ratio: float = 0.7,
    purge_days: int = 0,
    embargo_days: int = 0,
) -> list[WalkForwardWindow]:
    if num_windows <= 0:
        msg = f"num_windows must be >= 1, got {num_windows}"
        raise ValueError(msg)
    if not 0.0 < train_ratio < 1.0:
        msg = f"train_ratio must be in (0, 1), got {train_ratio}"
        raise ValueError(msg)
    if purge_days < 0 or embargo_days < 0:
        msg = f"purge/embargo must be >= 0, got purge={purge_days}, embargo={embargo_days}"
        raise ValueError(msg)

    gap_span = (purge_days + embargo_days) * (num_windows - 1)
    windows_per_fold = (total_obs - gap_span) // num_windows
    if windows_per_fold < 1:
        msg = (
            f"total_obs ({total_obs}) too small for {num_windows} windows "
            f"with purge={purge_days} + embargo={embargo_days}"
        )
        raise ValueError(msg)

    train_size = int(windows_per_fold * train_ratio)
    test_size = windows_per_fold - train_size
    if test_size < MIN_OBS_FOR_SHARPE:
        msg = (
            f"total_obs ({total_obs}) yields {test_size}-day test windows; "
            f"need >= {MIN_OBS_FOR_SHARPE} for statistically valid Sharpe/DSR"
        )
        raise ValueError(msg)
    if test_size <= purge_days + embargo_days:
        msg = (
            f"test window {test_size} days must exceed purge+embargo "
            f"({purge_days}+{embargo_days})"
        )
        raise ValueError(msg)

    windows: list[WalkForwardWindow] = []
    for w in range(num_windows):
        ws = w * windows_per_fold
        train_end = ws + train_size - 1
        purged_train_end = train_end - purge_days
        test_start = train_end + 1 + embargo_days
        test_end = test_start + test_size - 1
        if test_end > total_obs - 1:
            break
        windows.append(
            WalkForwardWindow(
                train_start=ws,
                train_end=purged_train_end,
                test_start=test_start,
                test_end=test_end,
            )
        )
    return windows
```

- [ ] **Step 4: `run_walk_forward` 透传 + report.py 接入**

`run_walk_forward` 签名追加 `purge_days: int = 0, embargo_days: int = 0`，窗口调用改为：

```python
    windows = generate_walk_forward_windows(
        total_obs, num_windows, train_ratio, purge_days, embargo_days
    )
```

`report.py` 的 `run_walk_forward(...)` 调用追加：

```python
        purge_days=config.purge_days,
        embargo_days=config.embargo_days,
```

- [ ] **Step 5: 运行测试确认通过**

```bash
py -3.14 -m pytest scripts/local_evolver/tests/test_walk_forward.py
```
Expected: 全部 PASS（原 16 例 + 新 3 例；`test_run_walk_forward` 默认 purge=0/embargo=0 行为不变）。

- [ ] **Step 6: 提交**

```bash
git add scripts/local_evolver/walk_forward.py scripts/local_evolver/report.py scripts/local_evolver/tests/test_walk_forward.py
git commit -m "feat(evolver): purge/embargo gaps in walk-forward windows"
```

---

### Task 5: stability 联合扰动（约束保持）

**Files:**
- Modify: `scripts/local_evolver/stability.py`
- Test: `scripts/local_evolver/tests/test_stability.py`

**Interfaces:**
- Consumes: 无
- Produces:
  - `_perturb_split(safe_ratio: float, ambition_ratio: float, delta: float) -> tuple[float, float]` — 扰动比例 ρ=safe/(safe+amb) 保持总和不变
  - `check_stability` 不再独立扰动 safe_ratio/ambition_ratio

- [ ] **Step 1: 写失败测试**

`test_stability.py` 追加：

```python
from stability import _perturb_split, check_stability


class TestPerturbSplit:
    def test_preserves_sum(self):
        for delta in (0.05, -0.05, 0.2, -0.2):
            s, a = _perturb_split(0.6, 0.4, delta)
            assert abs(s + a - 1.0) < 1e-9
            assert 0.0 <= s <= 1.0
            assert 0.0 <= a <= 1.0

    def test_shift_direction(self):
        s, a = _perturb_split(0.6, 0.4, 0.05)
        assert s == pytest.approx(0.65)
        assert a == pytest.approx(0.35)

    def test_clamp(self):
        s, a = _perturb_split(0.95, 0.05, 0.1)
        assert s == pytest.approx(1.0)
        assert a == pytest.approx(0.0)
        s, a = _perturb_split(0.05, 0.95, -0.1)
        assert s == pytest.approx(0.0)
        assert a == pytest.approx(1.0)
```

- [ ] **Step 2: 运行测试确认失败**

```bash
py -3.14 -m pytest scripts/local_evolver/tests/test_stability.py -v
```
Expected: FAIL（`_perturb_split` 不存在）。

- [ ] **Step 3: 实现联合扰动**

`stability.py` 新增：

```python
def _perturb_split(
    safe_ratio: float, ambition_ratio: float, delta: float
) -> tuple[float, float]:
    """Perturb the safe/ambition split while preserving their sum (=1).

    Perturbing either ratio alone breaks the sum constraint and silently
    tests leverage; perturbing the fraction rho = safe/(safe+ambition)
    keeps the split on the simplex.
    """
    total = safe_ratio + ambition_ratio
    if total <= 0:
        return safe_ratio, ambition_ratio
    rho = safe_ratio / total
    new_rho = min(1.0, max(0.0, rho + delta))
    if abs(new_rho - rho) < 1e-12:
        return safe_ratio, ambition_ratio
    return new_rho * total, (1.0 - new_rho) * total
```

`check_stability` 中：`scalar_params` 列表移除 `("safe_ratio", ...)` 与 `("ambition_ratio", ...)` 两项，并在标量循环之后追加：

```python
    # safe/ambition split: joint perturbation preserving sum = 1
    for delta in (neighborhood_radius, -neighborhood_radius):
        new_safe, new_amb = _perturb_split(
            params.safe_ratio, params.ambition_ratio, delta
        )
        if (new_safe, new_amb) == (params.safe_ratio, params.ambition_ratio):
            continue
        shifted = copy.deepcopy(params)
        shifted.safe_ratio = new_safe
        shifted.ambition_ratio = new_amb
        score = _score(shifted)
        neighborhood_sharpes.append(score)
        gradients.append(abs(score - base_sharpe) / neighborhood_radius)
```

- [ ] **Step 4: 运行测试确认通过**

```bash
py -3.14 -m pytest scripts/local_evolver/tests/test_stability.py -v
```
Expected: 全部 PASS（原 7 例 + 新 3 例）。

- [ ] **Step 5: 提交**

```bash
git add scripts/local_evolver/stability.py scripts/local_evolver/tests/test_stability.py
git commit -m "fix(evolver): joint safe/ambition perturbation preserves sum=1"
```

---

### Task 6: MPT 均值/协方差窗口化 + 逐折估计（消除 lookahead）

**Files:**
- Modify: `scripts/local_evolver/mpt.py`
- Test: `scripts/local_evolver/tests/test_mpt.py`

**Interfaces:**
- Consumes: 无
- Produces:
  - `compute_mean_returns(data, symbols, device, start: int = 0, end: int | None = None) -> torch.Tensor`
  - `compute_covariance_matrix(data, symbols, device, start: int = 0, end: int | None = None) -> torch.Tensor`
  - `compute_efficient_frontier_on_window(data, symbols, config, risk_free_rate, start, end) -> EfficientFrontier`
  - `compute_efficient_frontier_with_cpcv` 改为：**逐折估计**——每个 fold 在自身 train 窗口（`[train_start, train_end]` 闭区间，与 `apply_fold_to_returns` 切片一致）内估计统计量生成前沿、取该折 max-sharpe 权重，并在**该折自己的 test 窗口**上样本外评估（逐折 OOS 收益拼接 → fold 级 Sharpe/DSR 分布）；报告的 `max_sharpe_portfolio` = test_end 最大折（最新）的前沿，`sharpe_ratio = dsr`
  - （2026-08-18 用户裁决：最终评审发现"单前沿 + 全 fold 评估"方案中早期折 test 窗口落在估计窗口内（样本内混合），恢复逐折估计；Task 6 测试在实现阶段曾按简化方案验收，最终评审后按本语义复验）

- [ ] **Step 1: 写失败测试**

`test_mpt.py` 追加（需要 `DataFrame`/`MarketDataInput`/`CpcvFold` 导入）：

```python
import numpy as np
from models import CpcvFold, DataFrame, EvolverConfig, MarketDataInput
from mpt import compute_efficient_frontier_with_cpcv


def _flat_df(dates: list[str], closes: list[float]) -> DataFrame:
    return DataFrame(
        dates=dates, close=list(closes), open=[], high=[], low=[], volume=[]
    )


def test_compute_mean_returns_windowed(sample_market_data, device):
    means_full = compute_mean_returns(sample_market_data, ["511360", "511880"], device)
    means_window = compute_mean_returns(
        sample_market_data, ["511360", "511880"], device, start=0, end=99
    )
    assert means_window.shape == (2,)
    assert torch.isfinite(means_window).all()
    assert not torch.allclose(means_full, means_window)


def test_frontier_weights_do_not_use_test_data():
    # A: 低波动温和正漂移; B: train 段高波动中等漂移、test 段 +5%/日暴涨
    # 逐折估计只看 train → 权重不会压向 B；全样本统计（旧实现）会看到暴涨 → w_B ≈ 1.0
    n = 400
    dates = [f"2023-{i // 30 + 1:02d}-{i % 30 + 1:02d}" for i in range(n)]
    rng = np.random.default_rng(11)
    a_closes = 100.0 * np.cumprod(1 + 0.0003 + rng.normal(0, 0.001, n))
    b_train = 100.0 * np.cumprod(1 + 0.001 + rng.normal(0, 0.01, 300))
    b_closes = np.concatenate([
        b_train,
        b_train[-1] * (1.05 ** np.arange(1, 101)),
    ])
    data = MarketDataInput(symbols={"A": _flat_df(dates, a_closes.tolist()),
                                    "B": _flat_df(dates, b_closes.tolist())})
    folds = [
        CpcvFold(train_start=0, train_end=199, test_start=200, test_end=399),
        CpcvFold(train_start=0, train_end=99, test_start=100, test_end=349),
    ]
    ef = compute_efficient_frontier_with_cpcv(
        data, ["A", "B"], folds, EvolverConfig(frontier_points=10)
    )
    assert ef.max_sharpe_portfolio is not None
    w_b = ef.max_sharpe_portfolio.weights.weights["B"]
    # train 段 A 的 Sharpe(≈0.2) 高于 B(≈0.09) → 切点组合偏好 A
    assert w_b <= 0.8
    assert ef.max_sharpe_portfolio.cpcv_result is not None
    assert ef.max_sharpe_portfolio.sharpe_ratio == pytest.approx(
        ef.max_sharpe_portfolio.cpcv_result.dsr
    )
```

- [ ] **Step 2: 运行测试确认失败**

```bash
py -3.14 -m pytest scripts/local_evolver/tests/test_mpt.py -v
```
Expected: `test_compute_mean_returns_windowed` FAIL（签名无 start/end）；`test_frontier_weights_do_not_use_test_data` FAIL（旧实现全样本估计 → w_B ≈ 1.0 > 0.8）。

- [ ] **Step 3: 窗口化统计量**

`compute_mean_returns` 与 `compute_covariance_matrix` 增加窗口参数。以 `compute_mean_returns` 为例（协方差同理）：

```python
def compute_mean_returns(
    data: MarketDataInput,
    symbols: list[str],
    device: torch.device,
    start: int = 0,
    end: int | None = None,
) -> torch.Tensor:
    n = min(
        (len(data.symbols[s].close) for s in symbols if s in data.symbols),
        default=0,
    )
    if n < 10:
        msg = "No valid data or too few observations"
        raise ValueError(msg)
    if end is None:
        end = n - 1
    if start < 0 or end >= n or start > end:
        msg = f"invalid window start={start}, end={end} for n={n}"
        raise ValueError(msg)

    means = []
    for sym in symbols:
        df = data.symbols.get(sym)
        if df is None:
            means.append(0.0)
        else:
            prices = np.array(df.close[-n:], dtype=np.float64)
            rets = prices[1:] / prices[:-1] - 1.0
            lo = max(start, 1)
            hi = min(end + 1, len(rets))
            seg = rets[lo:hi]
            means.append(float(seg.mean()) if len(seg) > 0 else 0.0)
    return torch.tensor(means, device=device, dtype=torch.float32)
```

`compute_covariance_matrix` 的 `returns_list` 构造后统一切片：

```python
    R = torch.stack(returns_list)
    lo = max(start, 1)
    hi = min(end + 1, R.shape[1])
    R = R[:, lo:hi]
    if R.shape[1] < 2:
        return torch.zeros(len(symbols), len(symbols), device=device)
    mean_centered = R - R.mean(dim=1, keepdim=True)
    cov = (mean_centered @ mean_centered.T) / (R.shape[1] - 1)
    return cov
```

- [ ] **Step 4: 提取前沿构建助手 + 窗口版前沿**

`mpt.py` 新增（把 `compute_efficient_frontier` 中从 `num_candidates` 到返回的部分抽出）：

```python
def _frontier_from_moments(
    mean_returns: torch.Tensor,
    cov_matrix: torch.Tensor,
    symbols: list[str],
    num_points: int,
    risk_free_rate: float,
    device: torch.device,
) -> EfficientFrontier:
    num_assets = len(symbols)
    num_candidates = max(num_points * 20, 1000)

    raw_weights = generate_random_portfolios(num_assets, num_candidates, device)
    exp_returns, volatilities, sharpes = evaluate_portfolio(
        raw_weights, mean_returns, cov_matrix, risk_free_rate
    )

    w_f, r_f, v_f, s_f = extract_efficient_frontier(
        raw_weights, exp_returns, volatilities, sharpes, num_points
    )

    points: list[FrontierPoint] = []
    for i in range(len(r_f)):
        w_dict = {symbols[j]: float(w_f[i, j].item()) for j in range(num_assets)}
        points.append(
            FrontierPoint(
                weights=PortfolioWeights(weights=w_dict),
                expected_return=annualize_return(float(r_f[i].item()), 252),
                volatility=annualize_volatility(float(v_f[i].item()), 252),
                sharpe_ratio=float(s_f[i].item()) * math.sqrt(252),
            )
        )

    if not points:
        return EfficientFrontier()

    max_sharpe = max(points, key=lambda p: p.sharpe_ratio)
    min_vol = min(points, key=lambda p: p.volatility)

    return EfficientFrontier(
        points=points, max_sharpe_portfolio=max_sharpe, min_vol_portfolio=min_vol
    )
```

`compute_efficient_frontier` 改为薄封装：

```python
def compute_efficient_frontier(
    data: MarketDataInput,
    symbols: list[str],
    config: EvolverConfig | None = None,
    risk_free_rate: float = DEFAULT_RISK_FREE_RATE,
) -> EfficientFrontier:
    return compute_efficient_frontier_on_window(
        data, symbols, config, risk_free_rate, start=0, end=None
    )
```

新增：

```python
def compute_efficient_frontier_on_window(
    data: MarketDataInput,
    symbols: list[str],
    config: EvolverConfig | None = None,
    risk_free_rate: float = DEFAULT_RISK_FREE_RATE,
    start: int = 0,
    end: int | None = None,
) -> EfficientFrontier:
    if config is None:
        from models import DEFAULT_EVOLVER_CONFIG

        config = DEFAULT_EVOLVER_CONFIG

    device = _get_device()
    mean_returns = compute_mean_returns(data, symbols, device, start, end)
    cov_matrix = compute_covariance_matrix(data, symbols, device, start, end)
    return _frontier_from_moments(
        mean_returns, cov_matrix, symbols, config.frontier_points, risk_free_rate, device
    )
```

- [ ] **Step 5: 重写 `compute_efficient_frontier_with_cpcv`**

```python
def compute_efficient_frontier_with_cpcv(
    data: MarketDataInput,
    symbols: list[str],
    folds: list[CpcvFold],
    config: EvolverConfig | None = None,
    risk_free_rate: float = DEFAULT_RISK_FREE_RATE,
    alpha: float = 0.05,
) -> EfficientFrontier:
    """Frontier estimated inside the most-recent fold's train window only.

    Mean/covariance statistics are estimated on the training segment of the
    fold whose test window ends most recently ("data available as of now"),
    so the chosen weights never see future data. The max-sharpe weights are
    then evaluated out-of-sample across ALL folds via compute_cpcv_result.
    """
    if config is None:
        from models import DEFAULT_EVOLVER_CONFIG

        config = DEFAULT_EVOLVER_CONFIG

    if not folds:
        return compute_efficient_frontier_on_window(data, symbols, config, risk_free_rate)

    report_fold = max(folds, key=lambda f: f.test_end)
    ef = compute_efficient_frontier_on_window(
        data,
        symbols,
        config,
        risk_free_rate,
        start=report_fold.train_start,
        end=report_fold.train_end,
    )
    if not ef.max_sharpe_portfolio:
        return ef

    cpcv = compute_cpcv_result(
        data, symbols, ef.max_sharpe_portfolio.weights.weights, folds, risk_free_rate, alpha
    )
    ef.max_sharpe_portfolio.cpcv_result = cpcv
    ef.max_sharpe_portfolio.sharpe_ratio = cpcv.dsr
    ef.min_vol_portfolio = min(ef.points, key=lambda p: p.volatility)
    return ef
```

同时删除 `compute_regime_blended_frontier` 整段（其引用 `detect_regimes`/`blended_covariance`/`RegimeResult`，函数删除后这些导入在 mpt.py 变为死代码 → 一并删除 mpt.py 顶部的 `from regime import blended_covariance, detect_regimes` 与 `RegimeResult` 导入）。`regime.py` 侧的 `blended_covariance` 由 Task 8 处理。

- [ ] **Step 6: 运行测试确认通过**

```bash
py -3.14 -m pytest scripts/local_evolver/tests/test_mpt.py -v
```
Expected: 全部 PASS（原 6 例 + 新 2 例）。

- [ ] **Step 7: 提交**

```bash
git add scripts/local_evolver/mpt.py scripts/local_evolver/tests/test_mpt.py
git commit -m "fix(evolver): estimate MPT frontier inside train windows only"
```

---

### Task 7: MC 漂移窗口 + max_dd 稳健分位数

**Files:**
- Modify: `scripts/local_evolver/monte_carlo.py`
- Modify: `scripts/local_evolver/report.py`（`run_monte_carlo` 调用传 `estimate_window_days`）
- Test: `scripts/local_evolver/tests/test_monte_carlo.py`

**Interfaces:**
- Consumes: Task 2 的 `EvolverConfig.mc_estimate_window_days`、Task 6 的窗口化统计量
- Produces:
  - `run_monte_carlo(data, symbols, weights, initial_prices, days=252, num_paths=10000, estimate_window_days=252)`
  - `compute_monte_carlo_summary`/`compute_drawdown_analytics` 的 `max_drawdown` = 逐路径最大回撤的 **5% 分位数**（不再取最差单条路径）

- [ ] **Step 1: 写失败测试**

`test_monte_carlo.py` 追加：

```python
def test_max_drawdown_uses_robust_quantile(device):
    # 99 条温和下跌路径 + 1 条灾难路径：max_dd 应为 5% 分位数 ≈ 温和值
    n_paths, days = 100, 10
    values = torch.zeros(n_paths, days + 1, device=device)
    values[:, 0] = 100.0
    for i in range(days):
        values[:, i + 1] = values[:, i] * (1 - 0.005)  # 温和 -0.5%/日
    values[0] = values[0, 0] * (1 - 0.9) ** torch.arange(days + 1, device=device)
    returns = values / values[:, 0:1] - 1.0
    summary, _, dd = compute_monte_carlo_summary(returns, values)
    assert summary.max_drawdown > -0.5  # 旧实现取最差路径 → ≈ -0.9
    assert dd.max_drawdown > -0.5
```

- [ ] **Step 2: 运行测试确认失败**

```bash
py -3.14 -m pytest scripts/local_evolver/tests/test_monte_carlo.py -v
```
Expected: `test_max_drawdown_uses_robust_quantile` FAIL（旧实现 `min(dd_list)` = -0.9）。

- [ ] **Step 3: 实现稳健分位数与窗口**

`compute_monte_carlo_summary` 中：

```python
    dd_list = [compute_max_drawdown(portfolio_values[i]) for i in range(min(n, 1000))]
    max_dd = float(np.percentile(dd_list, 5)) if dd_list else 0.0
```

`compute_drawdown_analytics` 中：

```python
    max_dd = float(np.percentile(max_dds, 5)) if max_dds else 0.0
```

`run_monte_carlo` 签名追加 `estimate_window_days: int = MC_DEFAULT_ESTIMATE_WINDOW_DAYS`，统计量窗口化：

```python
    n_total = min(
        (len(data.symbols[s].close) for s in symbols if s in data.symbols),
        default=0,
    )
    start_idx = max(0, n_total - estimate_window_days)
    mean_returns = compute_mean_returns(data, symbols, device, start=start_idx, end=n_total - 1)
    cov_matrix = compute_covariance_matrix(data, symbols, device, start=start_idx, end=n_total - 1)
```

（`monte_carlo.py` 顶部需 `from constants import MC_DEFAULT_ESTIMATE_WINDOW_DAYS`。）

`report.py` 的 `run_monte_carlo(...)` 调用追加 `estimate_window_days=config.mc_estimate_window_days`。

- [ ] **Step 4: 运行测试确认通过**

```bash
py -3.14 -m pytest scripts/local_evolver/tests/test_monte_carlo.py -v
```
Expected: 全部 PASS（原 8 例 + 新 1 例）。

- [ ] **Step 5: 提交**

```bash
git add scripts/local_evolver/monte_carlo.py scripts/local_evolver/report.py scripts/local_evolver/tests/test_monte_carlo.py
git commit -m "fix(evolver): MC drift on recent window, max_dd on 5th percentile"
```

---

### Task 8: regime 死代码删除

**Files:**
- Modify: `scripts/local_evolver/regime.py`（删除 `blended_covariance` 及随之死亡的 `torch` 导入/`_get_device`）
- Test: `scripts/local_evolver/tests/test_regime.py`、`scripts/local_evolver/tests/test_mpt.py`（mpt.py 的导入清理已在 Task 6 完成）

**Interfaces:**
- Consumes: 无
- Produces: 无（纯删除；`detect_regimes` 与 `RegimeResult` 保留）

- [ ] **Step 1: 确认现状（红）**

```bash
rg "compute_regime_blended_frontier|blended_covariance" scripts/local_evolver
```
Expected: 仅 `regime.py` 定义处（mpt.py 已在 Task 6 删除函数与导入）；`test_regime.py` 无相关引用。

- [ ] **Step 2: 删除死代码**

`regime.py`：删除 `blended_covariance`（原 256-275 行）整段；删除不再使用的 `torch` 导入及 `_get_device`（`detect_regimes` 纯 numpy/sklearn，`torch`/`_get_device` 仅被 `blended_covariance` 使用）。

- [ ] **Step 3: 运行测试确认通过**

```bash
py -3.14 -m pytest scripts/local_evolver/tests/test_regime.py scripts/local_evolver/tests/test_mpt.py -v
```
Expected: 全部 PASS（regime 检测测试保留、MPT 测试不受影响）。

- [ ] **Step 4: 提交**

```bash
git add scripts/local_evolver/regime.py
git commit -m "refactor(evolver): delete dead regime-blended covariance code"
```

---

### Task 9: bootstrap 修复（WF 样本外收益）+ DSR/PBO 标注

**Files:**
- Modify: `scripts/local_evolver/report.py`
- Modify: `scripts/local_evolver/dsr.py`（docstring 标注）
- Modify: `scripts/local_evolver/walk_forward.py`（`_compute_pbo` docstring 标注）
- Test: `scripts/local_evolver/tests/test_report.py`

**Interfaces:**
- Consumes: `extract_prices_for_symbols`、`compute_portfolio_returns_for_params`、`bootstrap_ci`、`load_bootstrap_config`
- Produces:
  - `compute_bootstrap_from_walk_forward(data, symbols, wf_summary, config, risk_free_rate, recommended) -> dict` — 对**推荐参数**（按 `optimal_params == recommended` 匹配的 WF 结果，取其在样本外测试窗口的 DCA 日收益）做 block bootstrap；无匹配结果或样本不足（< `MIN_OBS_FOR_BOOTSTRAP`）返回 `{}`
  - `generate_report` 的 `bootstrap_result` 改由此助手产生（`recommended` 在 PBO/stability 覆写之后传入，保证 bootstrap 对象与 `recommended_params` 一致）

- [ ] **Step 1: 写失败测试**

`test_report.py` 追加（现有 `from models import ...` 需补 `WalkForwardResult`、`WalkForwardWindow`；`from report import ...` 补 `compute_bootstrap_from_walk_forward`；新增 `from walk_forward import BACKTEST_SYMBOLS`）：

```python
def test_bootstrap_from_walk_forward_oos_returns(sample_market_data, sample_params):
    summary = WalkForwardSummary(
        results=[
            WalkForwardResult(
                window=WalkForwardWindow(
                    train_start=0, train_end=100, test_start=120, test_end=219
                ),
                optimal_params=sample_params,
                train_sharpe=0.1,
                test_sharpe=0.05,
                dsr=0.5,
            )
        ]
    )
    result = compute_bootstrap_from_walk_forward(
        sample_market_data, BACKTEST_SYMBOLS, summary, EvolverConfig(), 0.025
    )
    assert set(result.keys()) == {"sharpe", "sortino", "max_drawdown"}
    for key in result:
        assert result[key]["mean"] is not None
        assert len(result[key]["ci_95"]) == 2


def test_bootstrap_from_walk_forward_empty_when_no_positive():
    summary = WalkForwardSummary(results=[])
    result = compute_bootstrap_from_walk_forward(
        sample_market_data, BACKTEST_SYMBOLS, summary, EvolverConfig(), 0.025
    )
    assert result == {}
```

- [ ] **Step 2: 运行测试确认失败**

```bash
py -3.14 -m pytest scripts/local_evolver/tests/test_report.py -v
```
Expected: FAIL（`compute_bootstrap_from_walk_forward` 不存在）。

- [ ] **Step 3: 实现助手并替换 generate_report 逻辑**

`report.py` 新增助手（放在 `generate_report` 之前），并在 `generate_report` 中把原 173-188 行的 bootstrap 块替换为：

```python
    # === Bootstrap CI (block bootstrap on the recommended strategy's OOS returns) ===
    bootstrap_result = compute_bootstrap_from_walk_forward(
        data, symbols, wf_summary, config, risk_free_rate
    )
```

助手实现：

```python
def compute_bootstrap_from_walk_forward(
    data: MarketDataInput,
    symbols: list[str],
    wf_summary: WalkForwardSummary,
    config: EvolverConfig,
    risk_free_rate: float = 0.025,
) -> dict:
    """Block-bootstrap CI of the recommended strategy's OOS DCA daily returns.

    Bootstrapping the MC terminal cross-section (per-path final returns) is
    meaningless — it has no temporal structure. The strategy's actual
    out-of-sample daily return series (best walk-forward test window) carries
    real autocorrelation, which block bootstrap is designed for.
    """
    best_results = [r for r in wf_summary.results if r.test_sharpe > 0]
    if not best_results:
        return {}
    best_results.sort(key=lambda r: r.dsr, reverse=True)
    best = best_results[0]

    all_prices = extract_prices_for_symbols(data, symbols)
    oos_returns = compute_portfolio_returns_for_params(
        symbols,
        all_prices,
        best.window.test_start,
        best.window.test_end,
        best.optimal_params,
        config.transaction_costs,
        config.dca,
    )
    if len(oos_returns) < MIN_OBS_FOR_BOOTSTRAP:
        return {}

    bc = load_bootstrap_config()
    return bootstrap_ci(
        oos_returns,
        n_resamples=bc.get("n_resamples", 1000),
        block_size=bc.get("block_size", 5),
        risk_free_rate=risk_free_rate / 252,
    )
```

`report.py` 顶部导入追加：`from constants import MIN_OBS_FOR_BOOTSTRAP`、`from models import WalkForwardSummary`。

- [ ] **Step 4: DSR/PBO 标注（docstring 不算法）**

`dsr.py` 的 `compute_haircut_sharpe` docstring 追加：

```
    Note: this is the standard Bailey & López de Prado (2014) expected-max
    Sharpe haircut: E[max] approximated analytically over N trials times a
    heuristic variance term 1/sqrt(N). It is an approximation; the exact
    deflated Sharpe ratio uses the full E[max] distribution.
```

`walk_forward.py` 的 `_compute_pbo` docstring 追加：

```
    Note: "probability of backtest overfitting" per Bailey et al. (2015) —
    the fraction of splits where the IS-best configuration lands below the
    median OOS rank (num_params/2). This is the standard definition.
```

- [ ] **Step 5: 运行测试确认通过**

```bash
py -3.14 -m pytest scripts/local_evolver/tests/test_report.py scripts/local_evolver/tests/test_dsr.py scripts/local_evolver/tests/test_walk_forward.py -v
```
Expected: 全部 PASS（报告 7 例 + DSR 15 例 + WF 19 例，含新 2 例——新测试在 test_report.py）。

**⚠️ User-approved deviation (2026-08-17, applied in Task 9 execution):**
The new bootstrap test surfaced a latent divide-by-zero RuntimeWarning in `bootstrap_ci` (dsr.py:253: `(peak - b) / peak` when a resample's running peak is 0 — the DCA OOS series contains flat days). The suite had been warning-free through Task 8; the warning would also fire in production on real flat days. Guard added in a follow-up commit (errstate/where pattern, zero-peak resamples get drawdown 0.0), committed as `fix(evolver): guard zero-peak resamples in bootstrap max_drawdown`. The brief's Step 1 tests are structural (not OOS-vs-in-sample discriminating) — accepted as brief-mandated; the second test additionally received the missing `sample_market_data` fixture parameter (would otherwise NameError).

- [ ] **Step 6: 提交**

```bash
git add scripts/local_evolver/report.py scripts/local_evolver/dsr.py scripts/local_evolver/walk_forward.py scripts/local_evolver/tests/test_report.py
git commit -m "fix(evolver): bootstrap CI on WF out-of-sample returns; annotate DSR/PBO"
```

---

### Task 10: 回测窗口按上市日可用性回填（union-join + 层内归一化）

**Files:**
- Modify: `scripts/local_evolver/walk_forward.py:90-137`（`extract_prices_for_symbols`）、`walk_forward.py:149-164`（`_weighted_composite`）、`walk_forward.py:299-304`（`compute_portfolio_returns_for_params` 内复合价格构建处）
- Test: `scripts/local_evolver/tests/test_walk_forward.py`

**Interfaces:**
- Consumes: 无（依赖 walk_forward 既有常量 `BACKTEST_SAFE_SYMBOLS`/`AMBITION_SYMBOLS`/`BACKTEST_SYMBOLS`）
- Produces:
  - `extract_prices_for_symbols(data, symbols)`：当 `set(symbols) == set(BACKTEST_SYMBOLS)` 时返回 **union-join**（日期主索引 = 全部标的交易日并集，起点截断到两层均有数据的首日 `max(安全层最早日期, 进取层最早日期)`，缺失标的早期日期填 NaN）；其余符号集合保持原 inner-join 语义
  - `_weighted_composite`：**收益加权链式合成**——每日合成收益 = 当日可用（t-1 与 t 均有有限价格且 prev > 0）标的收益按再归一化权重加权平均；净值从 1.0 链式累乘；晚上市标的上市首日无 t-1 价格被排除（天然无水平跳变）；当日无可用收益 → NaN（绝不静默输出 0）
  - `compute_portfolio_returns_for_params`：复合价格含 NaN 时响亮报错（命名日期）

- [ ] **Step 1: 写失败测试**

`test_walk_forward.py` 追加（`from walk_forward import ...` 需补 `_weighted_composite`）：

```python
def _six_symbol_df(
    n_days: int = 100,
    late_safe_start: int | None = None,
    late_ambition_start: int | None = None,
) -> MarketDataInput:
    dates = [f"2023-{i // 30 + 1:02d}-{i % 30 + 1:02d}" for i in range(n_days)]
    symbols: dict[str, DataFrame] = {}
    for i, sym in enumerate(BACKTEST_SYMBOLS):
        sym_dates = dates
        if sym == "511360" and late_safe_start is not None:
            sym_dates = dates[late_safe_start:]
        if sym == "515080" and late_ambition_start is not None:
            sym_dates = dates[late_ambition_start:]
        price = 100.0 + i
        symbols[sym] = _df(sym_dates, [price] * len(sym_dates))
    return MarketDataInput(symbols=symbols)


def test_extract_prices_union_join_pads_late_listings():
    data = _six_symbol_df(n_days=100, late_safe_start=30, late_ambition_start=50)
    prices = extract_prices_for_symbols(data, BACKTEST_SYMBOLS)
    assert len(prices) == len(BACKTEST_SYMBOLS)
    # 两层均最早从第 0 天有数据（511880/511990/510300/510500 全量）→ 主索引 100 天
    assert len(prices[0]) == 100
    idx_511360 = BACKTEST_SYMBOLS.index("511360")
    assert np.isnan(prices[idx_511360][:30]).all()
    assert np.isfinite(prices[idx_511360][30:]).all()
    idx_515080 = BACKTEST_SYMBOLS.index("515080")
    assert np.isnan(prices[idx_515080][:50]).all()
    assert np.isfinite(prices[idx_515080][50:]).all()


def test_extract_prices_union_join_truncates_before_both_layers_exist():
    # 进取层全部第 30 天才上市 → 主索引起点 = 第 30 天（两层都可用之后）
    dates = [f"2023-{i // 30 + 1:02d}-{i % 30 + 1:02d}" for i in range(100)]
    symbols: dict[str, DataFrame] = {}
    for i, sym in enumerate(BACKTEST_SYMBOLS):
        sym_dates = dates[30:] if sym in ("510300", "510500", "515080") else dates
        price = 100.0 + i
        symbols[sym] = _df(sym_dates, [price] * len(sym_dates))
    prices = extract_prices_for_symbols(MarketDataInput(symbols=symbols), BACKTEST_SYMBOLS)
    assert len(prices[0]) == 70
    for p in prices:
        assert np.isfinite(p).all()


def test_weighted_composite_chain_linked_no_entry_jump():
    # 旧实现重标定价格水平：515080 上市日（~1.0 元）会瞬间拉低进取层水平线
    # （510300/510500 为 4-6 元）→ 组合出现虚假的 ~15% 单日下跌。
    # 修复后按收益率加权 + 链式复利：新上市标的在其上市日无 t-1 价格 → 被剔除，
    # 组合收益只反映在位标的 → 构造性无跳变。
    all_prices = [
        np.array([1.0, 1.0, 1.0, 1.0]),  # X：第 0 天就在位
        np.array([np.nan, np.nan, 5.0, 5.5]),  # Y：第 2 天才上市（价位 5.0）
    ]
    symbols = ["X", "Y"]
    indices = [0, 1]
    weights = {"X": 0.5, "Y": 0.5}
    composite = _weighted_composite(all_prices, symbols, indices, weights)
    # 第 0 天为锚点：nav = 1.0
    assert composite[0] == pytest.approx(1.0)
    # 第 1 天仅 X 有收益率（0%）→ nav 不变
    assert composite[1] == pytest.approx(1.0)
    # 第 2 天 Y 上市：X 收益率有限、Y 无 t-1 → 只按 X 加权 → 仍无跳变
    # （旧实现价格水平 = 0.5*1 + 0.5*5 = 3.0，会突兀跳升）
    assert composite[2] == pytest.approx(1.0)
    # 第 3 天两者均有收益率 → r = 0.5*0 + 0.5*(5.5/5 - 1) = 0.05 → nav = 1.05
    assert composite[3] == pytest.approx(1.05)
    # 链式一致性：nav[t]/nav[t-1] - 1 == 当日加权收益率
    assert composite[3] / composite[2] - 1.0 == pytest.approx(0.05)
    # 所有可用权重均为 0 → 返回 NaN，绝不静默输出 0 复合水平
    zero = _weighted_composite(all_prices, symbols, [0], {"Y": 1.0})
    assert zero[0] == pytest.approx(1.0)
    assert np.isnan(zero[1:]).all()
```

（2026-08-18 用户裁决：最终评审发现价格水平归一化在 515080 晚上市时产生 ~15% 单日跳变，改为收益加权链式合成；`test_extract_prices_union_join_*` 断言价格数组，不受影响。）

- [ ] **Step 2: 运行测试确认失败**

```bash
py -3.14 -m pytest scripts/local_evolver/tests/test_walk_forward.py -v
```
Expected: 新 3 例 FAIL（当前 inner join 返回 3 天窗口 / 无 NaN / 无归一化）。

- [ ] **Step 3: 实现 union-join**

重写 `extract_prices_for_symbols` 的返回段：

```python
    ordered = sorted(common_dates)
    ...
```
替换为：

```python
    if set(symbols) == set(BACKTEST_SYMBOLS):
        return _union_join_aligned(symbols, by_symbol)
    ordered = sorted(common_dates)
    aligned: list[np.ndarray] = []
    for _, price_by_date in by_symbol:
        aligned.append(np.array([price_by_date[d] for d in ordered], dtype=np.float64))
    return aligned
```

新增私有助手：

```python
def _union_join_aligned(
    symbols: list[str],
    by_symbol: list[tuple[str, dict[str, float]]],
) -> list[np.ndarray]:
    """Union-join over trading dates with per-layer availability (P1).

    Master index = union of every symbol's trading dates, truncated to the
    first date where BOTH layers have at least one symbol. Symbols that
    listed later get NaN until their first bar; composites renormalize
    across whatever is available (as-if backtest, no index proxies).
    """
    safe_symbols = set(BACKTEST_SAFE_SYMBOLS)
    ambition_symbols = set(AMBITION_SYMBOLS)
    all_dates: set[str] = set()
    for _, price_by_date in by_symbol:
        all_dates |= set(price_by_date)

    def layer_first(layer: set[str]) -> str:
        firsts = [
            min(price_by_date)
            for sym, price_by_date in by_symbol
            if sym in layer and price_by_date
        ]
        if not firsts:
            msg = "backtest layer has no symbols with data"
            raise ValueError(msg)
        return min(firsts)

    first_safe = layer_first(safe_symbols)
    first_ambition = layer_first(ambition_symbols)
    master_start = max(first_safe, first_ambition)
    master = sorted(d for d in all_dates if d >= master_start)
    if not master:
        msg = "no trading dates after both layers become available"
        raise ValueError(msg)

    aligned: list[np.ndarray] = []
    for _, price_by_date in by_symbol:
        aligned.append(
            np.array(
                [price_by_date.get(d, float("nan")) for d in master],
                dtype=np.float64,
            )
        )
    return aligned
```

- [ ] **Step 4: `_weighted_composite` 收益加权链式合成**（2026-08-18 用户裁决，替代原价格水平归一化）

```python
def _weighted_composite(
    all_prices: list[np.ndarray],
    symbols: list[str],
    indices: list[int],
    weights: dict[str, float],
) -> np.ndarray:
    base = all_prices[indices[0]]
    nav = np.full(len(base), np.nan)
    nav[0] = 1.0  # 锚点 1.0
    for i in range(1, len(base)):
        total = 0.0
        value = 0.0
        for idx in indices:
            w = weights.get(symbols[idx], 0.0)
            prev = all_prices[idx][i - 1]
            cur = all_prices[idx][i]
            if w > 0 and np.isfinite(prev) and np.isfinite(cur) and prev > 0:
                value += w * (cur / prev - 1.0)
                total += w
        if total > 0:
            nav[i] = nav[i - 1] * (1.0 + value / total)
        else:
            nav[i] = np.nan  # 无可用收益 → NaN，绝不静默输出 0
    return nav
```

`compute_portfolio_returns_for_params` 中在构建 `safe_price`/`ambition_price` 后追加守卫：

```python
    if not np.all(np.isfinite(safe_price)) or not np.all(np.isfinite(ambition_price)):
        msg = (
            "composite series contains missing data on the backtest master "
            "index; check per-symbol listing dates"
        )
        raise ValueError(msg)
```

- [ ] **Step 5: 运行测试确认通过**

```bash
py -3.14 -m pytest scripts/local_evolver/tests/test_walk_forward.py
```
Expected: 全部 PASS（原 16 例 + 新 3 例；`test_extract_prices_for_symbols_aligned` 全量同日期 → 主索引不变；`test_extract_prices_for_symbols_inner_joins_on_dates` 用 A/B 非回测宇宙 → 仍 inner join）。

- [ ] **Step 6: 全量回归**

```bash
py -3.14 -m pytest scripts/local_evolver/tests/ -q
```
Expected: 全部 PASS（122 + 新增）。

- [ ] **Step 7: 提交**

```bash
git add scripts/local_evolver/walk_forward.py scripts/local_evolver/tests/test_walk_forward.py
git commit -m "feat(evolver): as-if backtest with per-symbol listing-date availability"
```

---

### Task 11: 执行次数饱和文档化

**Files:**
- Modify: `scripts/local_evolver/dca_sim.py`（模块 docstring）
- Modify: `docs/EVOLVER.md`（追加 Known Modeling Choices 节）

**Interfaces:**
- Consumes: 无
- Produces: 无

- [ ] **Step 1: dca_sim.py docstring 追加**

模块 docstring 末尾追加：

```
Known modeling choice (P1, documented): under the default monthly
contribution (1000 yuan / 21 trading days) the pool's accumulation speed is
below the trigger line, so bsm_threshold changes execution TIMING but not
the execution COUNT (liquidity-ceiling saturation). Raising the monthly
contribution or lowering the trigger line makes the count responsive.
```

- [ ] **Step 2: EVOLVER.md 追加节**

在 `docs/EVOLVER.md` 末尾追加：

```markdown
## Known Modeling Choices

- **Execution-count saturation**: under the default monthly contribution
  (1000 yuan / 21 trading days) the pool accumulates slower than the trigger
  line, so `bsm_threshold` changes execution timing but not the execution
  count. This is a documented modeling choice — raise the monthly
  contribution or lower the trigger line to observe count sensitivity.
- **Backtest universe availability (as-if)**: each ETF enters the backtest
  from its own listing date; the safe/ambition composites are
  **returns-weighted and chain-linked** (NAV from 1.0) over the funds
  available on each day, so a late listing (511360 2020-09, 515080 2019-11)
  joins without a price-level jump (all real prices, no index proxies).
  Window: 2013-04 onward.
- **CPCV fold degeneracy (known limitation)**: `generate_cpcv_folds` anchors
  the embargo on `max(train_indices)`, so at the production default
  (`num_splits=10`) only 2 folds pass the filter and `num_splits=5` yields
  0 folds. Pre-existing; the per-fold CPCV path handles 0/2 folds without
  in-sample leakage (reported frontier falls back to the full-window
  frontier with no OOS claim). Follow-up recommended: anchor the embargo on
  each fold's own train/test boundary and assert >= 1 fold.
```

- [ ] **Step 3: 提交**

```bash
git add scripts/local_evolver/dca_sim.py docs/EVOLVER.md
git commit -m "docs(evolver): document execution-count saturation and as-if universe"
```

---

### Task 12: 全量验证 + TODO.md 收尾

**Files:**
- Modify: `TODO.md`（勾掉 10 项 P1 待办）
- Modify: `docs/superpowers/specs/2026-08-17-p1-backtest-methodology-design.md`（若实现与 spec 有偏差则标注）

**Interfaces:**
- Consumes: 全部前置任务

- [ ] **Step 1: 全量测试**

```bash
py -3.14 -m pytest scripts/local_evolver/tests/ -q
```
Expected: 全部 PASS。

- [ ] **Step 2: 静态检查**

```bash
npm run lint:python:all
```
Expected: ruff check / ruff format --check / mypy --strict / bandit 全绿。

- [ ] **Step 3: 复现性回归**

```bash
py -3.14 -m pytest scripts/local_evolver/tests/test_seeding.py scripts/local_evolver/tests/test_walk_forward.py -q
```
Expected: PASS（同 seed 逐字节一致保持）。

- [ ] **Step 4: 更新 TODO.md**

把 TODO.md「P1 回测方法学（决策质量）」10 项全部改为 `- [x]`，并在文件顶部状态行追加一行：`> 2026-08-17 状态：P1 回测方法学 10 项全部完成（A股规则/T+1/整手/涨停/折溢价、MPT 逐折估计、WF purge/embargo、regime 死代码删除、bootstrap 修复、stability 联合扰动、MC 252日窗口+5%分位数、回测窗口延至 2013-04、执行次数饱和文档化、cpcv 除零守卫）。`

- [ ] **Step 5: 提交**

```bash
git add TODO.md
git commit -m "docs(todo): mark all P1 backtest methodology items complete"
```

---

## Self-Review Notes

- **Spec 覆盖**：10 项 spec 逐项对应 Task 1-11（Task 12 验证收尾）。第 9 项（执行次数饱和）为纯文档，落在 Task 11。第 2 项 spec 中"循环每个 fold 生成前沿"在实现阶段先简化为"test_end 最大 fold 的 train 窗口生成前沿 + 全 fold 样本外评估"，2026-08-18 最终评审发现该简化使早期折 test 窗口落在估计窗口内（样本内混合），经用户裁决恢复**逐折估计**（每折在自身 train 窗口估计、在自身 test 窗口样本外评估，报告前沿取最新折）——即与 spec 原始设计一致。
- **占位符扫描**：无 TBD/TODO 步骤；每个 Step 含具体代码或命令。
- **签名已对照源码逐项核实**（本计划写入前已读 models.py/walk_forward.py/report.py/mpt.py/dca_sim.py/stability.py/monte_carlo.py/cpcv.py/config.py/config.yaml/regime.py/dsr.py 及 6 个 test 文件）：
  - `bootstrap_ci(returns, n_resamples=1000, block_size=5, levels=None, risk_free_rate=0.0, rng=None)` 返回 `{"sharpe","sortino","max_drawdown"}` 各含 `mean/std/ci_95/ci_99`（dsr.py:229）——Task 9 断言与之一致。
  - `compute_efficient_frontier_with_cpcv(data, symbols, folds, config, risk_free_rate, alpha)`、`compute_cpcv_result(data, symbols, weights, folds, risk_free_rate, alpha)`（mpt.py:225/158）——Task 6 重写签名不变。
  - `generate_walk_forward_windows(total_obs, num_windows, train_ratio)`（walk_forward.py:167）；Task 4 新增 purge/embargo 后默认 0 时与现状逐窗一致（w0: train 175 [0,174]、test [175,249] 等），既有 3 个窗口测试不受影响。
  - `extract_prices_for_symbols` 双模式：`set(symbols) == set(BACKTEST_SYMBOLS)` → union-join（`test_extract_prices_for_symbols_aligned` 全量同日期 → 500 天无 NaN，数值不变）；A/B 等非回测宇宙 → inner join（`test_extract_prices_for_symbols_inner_joins_on_dates` 不变）。
  - `simulate_dca` 决策余额沿用 `safe_cash + ambition_value`（已结算口径）；既有测试仅 `test_simulate_dca_twr_flat_market_no_cost` 需要显式 `spread=0.0`（`_cost` 助手加参数），其余既有测试在默认 spread=0.002 下行为不变（佣金仍 5.0/笔、3% 日波动 < 10% 涨停线）。
- **Task 4 窗口算术已手算验证**：1320/6 窗/gap10 → wpf=211/train 147/test 64（w0: train_end=141, test [152,215]）；500/2 窗 → wpf=245/train 171/test 74（w0 test_end=249, w1 test_end=494）；gap 过大（160）→ test 51 < 63 → ValueError。计划内测试断言与实现一致。
- **Task 3 测试判别力已手算验证**（旧实现必然红）：整手测试用 bps=300 放大佣金差（新 12.16215/笔 vs 旧 19.926/笔）；涨停测试用控制组对比（月供 10000 保证第 30 天余额 ≥ 触发线，唯一差异 = 涨停跳过 → 恰少 1 次）；T+1 测试用次日 5% 尖峰 + 零成本 → T+1 下 nav 恒 1.0（全零收益），当日结算吃尖峰（returns[1] ≈ +0.6%）。
- **Task 6 测试判别力已手算验证**：A 低波动温和漂移（Sharpe≈0.2）、B train 段高波动中等漂移（Sharpe≈0.09）→ train 窗口切点偏好 A（w_B 远低于 0.8）；旧实现全样本看到 B 的 +5%/日 test 段 → w_B ≈ 1.0 必红。
- **类型一致性**：`compute_mean_returns`/`compute_covariance_matrix` 的 `start`/`end` 统一为价格空间索引（returns 切片 `[max(start,1):end+1]`）；`DcaConfig`/`TransactionCostConfig` 新字段在 Task 2 定义、Task 3 消费；`EvolverConfig.mc_estimate_window_days` 在 Task 2 定义、Task 7 消费；`_perturb_split` 在 Task 5 定义并被 `check_stability` 调用；`compute_bootstrap_from_walk_forward` 在 Task 9 定义并被 `generate_report` 调用。
- **Task 7 已核实**：`test_monte_carlo.py` 已有 `test_run_monte_carlo`（结构断言），无需重复；`compute_monte_carlo_summary` 的 dd_list 采样 min(n,1000) 与 percentile(5) 兼容（100 条路径：99×-0.049 + 1×-0.9 → p5 = -0.049 > -0.5）。
- **Task 8 已核实**：`regime.py` 的 `torch`/`_get_device` 仅被 `blended_covariance` 使用（detect_regimes 纯 numpy/sklearn）→ 一并删除；`mpt.py` 的 `from regime import blended_covariance, detect_regimes` 与 `RegimeResult` 导入仅在 `compute_regime_blended_frontier` 使用 → 一并清理；`report.py` 直接 `from regime import detect_regimes`（惰性导入）不受影响。