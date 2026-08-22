# Strategy Evolver

Python-based strategy optimization engine located at `scripts/local-evolver/`.

## Overview

The evolver performs walk-forward optimization with combinatorial purged cross-validation (CPCV) to find robust strategy parameters. It applies Deflated Sharpe Ratio (DSR) for ranking and Probability of Backtest Overfitting (PBO) for filtering.

## Pipeline

```
Market Data (CSV) → CPCV → Purge/Embargo → MPT Efficient Frontier
    → Walk-Forward Optimization → DSR Ranking → PBO Filter
    → Monte Carlo Stress Test → Sensitivity Analysis
    → Strategy Report → PATCH to Cloudflare API
```

## Modules

### `mpt.py` — Modern Portfolio Theory

- Computes the efficient frontier using CPCV-generated return paths
- Applies purge (removal of overlapping data) and embargo (gap between train/test)
- Outputs optimal weight allocations for the safe/ambition layer split

### `cpcv.py` — Combinatorial Purged Cross-Validation

- Generates multiple independent return paths from historical data
- Each path represents a different train/test split combination
- Returns distribution of Sharpe ratios across all paths

### `walk_forward.py` — Walk-Forward Optimization

- Iterates through time with rolling training windows
- Optimizes parameters on each training window
- Tests on out-of-sample data
- Produces parameter stability metrics

### `dsr.py` — Deflated Sharpe Ratio

- Adjusts Sharpe ratio for multiple testing (data snooping bias)
- Accounts for the number of trials, return distribution, and track record length
- Ranks parameter sets by DSR value

### `stability.py` — Stability Analysis

- Computes PBO (Probability of Backtest Overfitting)
- PBO > 50% → auto-reject parameter set
- Checks parameter consistency across training windows

### `sensitivity.py` — Sensitivity Analysis

- Examines gradient around optimal parameters
- Verifies that small parameter changes don't cause drastic performance drops
- Flags unstable optima

### `monte_carlo.py` — Monte Carlo Simulation

- Generates thousands of Geometric Brownian Motion (GBM) paths
- Tests strategy robustness across synthetic market scenarios
- Computes VaR, CVaR, and max drawdown distributions

### `risk.py` — Risk Metrics

- VaR (Value at Risk)
- CVaR (Conditional Value at Risk)
- Maximum drawdown
- Calmar ratio

### `regime.py` — Regime Detection

- Identifies market regimes (bull, bear, sideways, high/low volatility)
- Tests strategy performance across regimes
- Flags regime-specific vulnerabilities

### `report.py` — Report Generation

- Compiles all results into a structured report
- Generates JSON report for PATCH to Cloudflare API
- Saves HTML summary for local review

### `config.py` / `config.yaml` — Configuration

- Data paths
- CPCV parameters (test_size, embargo, purge)
- Walk-forward parameters (train_window, test_window, step)
- Monte Carlo parameters (n_simulations, time_horizon)

### `api_client.py` — Data Loading

- Fetches market history from the backend API (`GET /api/market-data/history`, session cookie auth)
- Drops NULL-close rows (upstream downloads may write NULL) instead of coercing them to 0.0
- Sorts per-symbol rows by date (does not rely on API ordering)

## Usage

```bash
# Install dependencies
pip install -e ".[dev]"   # 单一事实源 pyproject.toml（scripts/local_evolver/requirements.txt 仅为无 pyproject 环境兜底）

# Run full evolution
npm run evolve

# Or directly
python scripts/local-evolver/evolver.py
```

## Dependencies

版本约束以 `pyproject.toml` 为单一事实源（`pip install -e ".[dev]"`），
主要包括：torch / numpy / pandas / scikit-learn / scipy / click / pyyaml /
requests / akshare。

## Output

The evolver generates a strategy report and pushes it to:

```
POST /api/strategy/reports
```

The report includes:
- Optimal parameter set
- DSR ranking
- PBO score
- Status color (green/yellow/red based on days since evolution + PBO)
- Next scheduled evolution timestamp

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
